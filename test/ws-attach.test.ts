import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { HerdrEnv } from "../environments.ts";
import type { PtyLike } from "../server/pty-bridge.ts";
import { createSpawnLimiter } from "../server/ws-attach-guard.ts";
import { attachWebSocketServer, auditLine, type AttachServerOptions, type PtySpawnFn } from "../server/ws-attach.ts";

const ENV: HerdrEnv = { id: "work-local", label: "Work", kind: "local", claudeConfigDirs: [], spawnCommand: "claude", repos: {} };

interface FakePty extends PtyLike {
  emitData(d: string | Buffer): void;
  emitExit(): void;
  readonly writes: string[];
  readonly resizes: [number, number][];
  readonly kills: string[];
}

function makeFakePty(): FakePty {
  const dataCbs: ((d: string | Buffer) => void)[] = [];
  const exitCbs: (() => void)[] = [];
  const writes: string[] = [];
  const resizes: [number, number][] = [];
  const kills: string[] = [];
  return {
    onData: (cb) => { dataCbs.push(cb); },
    onExit: (cb) => { exitCbs.push(cb); },
    write: (d) => { writes.push(d); },
    resize: (c, r) => { resizes.push([c, r]); },
    kill: (s) => { kills.push(s ?? ""); },
    emitData: (d) => { for (const cb of dataCbs) cb(d); },
    emitExit: () => { for (const cb of exitCbs) cb(); },
    writes, resizes, kills,
  };
}

interface Harness {
  readonly port: number;
  readonly ptys: FakePty[];
  readonly auditPath: string;
  close(): Promise<void>;
}

const servers: Server[] = [];
const clients: WebSocket[] = [];

async function start(overrides: Partial<AttachServerOptions> = {}): Promise<Harness> {
  const ptys: FakePty[] = [];
  const spawn: PtySpawnFn = () => { const p = makeFakePty(); ptys.push(p); return p; };
  const dir = mkdtempSync(path.join(tmpdir(), "wsatt-"));
  const auditPath = path.join(dir, "attach-audit.log");
  const server = createServer();
  servers.push(server);
  await new Promise<void>((res) => { server.listen(0, "127.0.0.1", res); });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  attachWebSocketServer(server, {
    envs: [ENV],
    allowedOrigins: [`http://127.0.0.1:${String(port)}`, `http://localhost:${String(port)}`],
    spawn,
    auditLogPath: auditPath,
    ...overrides,
  });
  return {
    port, ptys, auditPath,
    close: () => new Promise<void>((res) => { server.close(() => { res(); }); }),
  };
}

function connect(port: number, pane: string, origin: string): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/sessions/work-local/${pane}/attach`, { origin });
  clients.push(ws);
  return ws;
}

function once(emitter: { once(ev: string, cb: (...a: unknown[]) => void): void }, event: string): Promise<unknown[]> {
  return new Promise((resolve) => { emitter.once(event, (...args: unknown[]) => { resolve(args); }); });
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start0 = Date.now();
  while (!pred()) {
    if (Date.now() - start0 > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  for (const c of clients.splice(0)) { try { c.terminate(); } catch { /* noop */ } }
  for (const s of servers.splice(0)) { await new Promise<void>((res) => { s.close(() => { res(); }); }); }
});

describe("auditLine (SEC-6: open/close + source, never keystrokes)", () => {
  it("serializes an open entry with the resolved command and no keystroke field", () => {
    const line = auditLine({
      event: "open", ts: "2026-07-07T00:00:00.000Z", env: "work-local", paneId: "w1-1",
      origin: "http://127.0.0.1:8787", resolvedCommand: "herdr agent attach w1-1 --takeover",
    });
    expect(line.endsWith("\n")).toBe(true);
    const parsed: unknown = JSON.parse(line);
    expect(parsed).toMatchObject({ event: "open", env: "work-local", paneId: "w1-1" });
    expect(line).toContain("agent attach w1-1 --takeover");
    expect(line.toLowerCase()).not.toContain("keystroke");
  });
  it("serializes a close entry", () => {
    const parsed: unknown = JSON.parse(auditLine({ event: "close", ts: "T", env: "e", paneId: "p" }));
    expect(parsed).toMatchObject({ event: "close", env: "e", paneId: "p" });
  });
});

describe("attachWebSocketServer (integration, injected fake pty)", () => {
  it("attaches a valid upgrade: spawns via buildAttachSpec (takeover), routes keystrokes + resize, streams output", async () => {
    const h = await start();
    const client = connect(h.port, "w1-1", `http://127.0.0.1:${String(h.port)}`);
    await once(client, "open");
    await waitFor(() => h.ptys.length === 1);

    client.send(Buffer.from("ls\n")); // binary frame = keystrokes
    await waitFor(() => (h.ptys[0]?.writes.length ?? 0) > 0);
    expect(h.ptys[0]?.writes).toContain("ls\n");

    client.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 })); // text frame = control
    await waitFor(() => (h.ptys[0]?.resizes.length ?? 0) > 0);
    expect(h.ptys[0]?.resizes[0]).toEqual([100, 40]);

    const msg = once(client, "message");
    h.ptys[0]?.emitData(Buffer.from("hello-out"));
    const [data] = await msg;
    expect(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)).toBe("hello-out");

    await waitFor(() => existsSync(h.auditPath) && readFileSync(h.auditPath, "utf8").includes('"open"'));
    const audit = readFileSync(h.auditPath, "utf8");
    expect(audit).toContain("agent attach w1-1 --takeover");
    expect(audit).not.toContain("ls\\n"); // SEC-6: keystrokes never hit the audit log
  });

  it("rejects a disallowed Origin — no pty is spawned (SEC-1)", async () => {
    const h = await start();
    const client = connect(h.port, "w1-1", "https://evil.example");
    await new Promise<void>((res) => {
      client.once("error", () => { res(); });
      client.once("close", () => { res(); });
    });
    expect(h.ptys.length).toBe(0);
  });

  it("rejects a leading-dash paneId — no pty is spawned (SEC-4)", async () => {
    const h = await start();
    const client = connect(h.port, "-danger", `http://127.0.0.1:${String(h.port)}`);
    await new Promise<void>((res) => {
      client.once("error", () => { res(); });
      client.once("close", () => { res(); });
    });
    expect(h.ptys.length).toBe(0);
  });

  it("closes with 1013 when the spawn limiter is exhausted (SEC-2)", async () => {
    const h = await start({ limiter: { tryReserve: () => false, release: () => { /* noop */ } } });
    const client = connect(h.port, "w1-1", `http://127.0.0.1:${String(h.port)}`);
    const code = await new Promise<number>((res) => {
      client.once("close", (c: number) => { res(c); });
      client.once("error", () => { /* a 1013 close may surface as error on some paths */ });
    });
    expect(code).toBe(1013);
    expect(h.ptys.length).toBe(0);
  });

  it("closes 4001 'attach unavailable' when the pty exits within the probe grace", async () => {
    // 4001 is a locked contract with SessionModal.closeMessage — a pane that's gone / a herdr error
    // must render a reason, not a blank terminal. The probe's onExit is registered before the
    // bridge's, so 4001 must win the close race over the generic 1000.
    const h = await start();
    const client = connect(h.port, "w1-1", `http://127.0.0.1:${String(h.port)}`);
    await once(client, "open");
    await waitFor(() => h.ptys.length === 1);
    h.ptys[0]?.emitExit(); // immediately → well within WS_PROBE_GRACE_MS
    const [code, reason] = await once(client, "close");
    expect(code).toBe(4001);
    expect(String(reason)).toBe("attach unavailable");
  });

  it("closes 1000 when the pty exits after the probe grace (normal end of session)", async () => {
    let t = 0;
    const h = await start({ now: () => t });
    const client = connect(h.port, "w1-1", `http://127.0.0.1:${String(h.port)}`);
    await once(client, "open");
    await waitFor(() => h.ptys.length === 1);
    t = 60_000; // long past WS_PROBE_GRACE_MS — the attach was healthy, this is a normal exit
    h.ptys[0]?.emitExit();
    const [code, reason] = await once(client, "close");
    expect(code).toBe(1000);
    expect(String(reason)).toBe("pty exited");
  });

  it("closes 4000 'attach failed' when spawn throws (e.g. node-pty ENOENT), audits it, spawns no pty", async () => {
    const h = await start({ spawn: () => { throw new Error("ENOENT herdr"); } });
    const client = connect(h.port, "w1-1", `http://127.0.0.1:${String(h.port)}`);
    const [code, reason] = await once(client, "close");
    expect(code).toBe(4000);
    expect(String(reason)).toBe("attach failed");
    expect(h.ptys.length).toBe(0);
    await waitFor(() => existsSync(h.auditPath) && readFileSync(h.auditPath, "utf8").includes("spawn failed"));
    expect(readFileSync(h.auditPath, "utf8")).toContain("[spawn failed: ENOENT herdr]");
  });

  it("releases the reserved slot on close so the next attach succeeds (SEC-2, no slot leak)", async () => {
    const inner = createSpawnLimiter({ maxConcurrent: 1, ratePerWindow: 100, windowMs: 100_000, now: () => Date.now() });
    let releases = 0;
    const limiter = {
      tryReserve: () => inner.tryReserve(),
      release: () => { releases += 1; inner.release(); },
    };
    const h = await start({ limiter });

    const c1 = connect(h.port, "w1-1", `http://127.0.0.1:${String(h.port)}`);
    await once(c1, "open");
    await waitFor(() => h.ptys.length === 1);
    c1.close();
    await waitFor(() => releases === 1); // the slot is released on the socket's close (not leaked)

    const c2 = connect(h.port, "w1-2", `http://127.0.0.1:${String(h.port)}`);
    const outcome = await Promise.race([
      once(c2, "open").then(() => "open"),
      new Promise<string>((res) => { c2.once("close", (code: number) => { res(`close:${String(code)}`); }); }),
    ]);
    expect(outcome).toBe("open"); // slot was free again → second attach reserved successfully
    expect(h.ptys.length).toBe(2);
  });
});
