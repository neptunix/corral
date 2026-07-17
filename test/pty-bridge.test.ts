import { describe, expect, it, vi } from "vitest";

import { bridgePtyToWs } from "../server/pty-bridge.ts";

function mocks() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const pty = {
    onData: vi.fn((cb: (...args: unknown[]) => void) => { handlers.data = cb; }),
    onExit: vi.fn((cb: (...args: unknown[]) => void) => { handlers.exit = cb; }),
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
  };
  const ws = {
    on: vi.fn((ev: string, cb: (...args: unknown[]) => void) => { handlers["ws:" + ev] = cb; }),
    send: vi.fn(), close: vi.fn(), ping: vi.fn(), terminate: vi.fn(), bufferedAmount: 0,
  };
  return { pty, ws, handlers };
}

describe("bridgePtyToWs", () => {
  it("pipes pty output to ws.send", () => {
    const { pty, ws, handlers } = mocks();
    bridgePtyToWs(pty, ws, { graceMs: 10, heartbeatMs: 1000 });
    handlers.data?.(Buffer.from("hi"));
    expect(ws.send).toHaveBeenCalledWith(Buffer.from("hi"));
  });
  it("routes a binary frame to pty.write and a resize control frame to pty.resize", () => {
    const { pty, ws, handlers } = mocks();
    bridgePtyToWs(pty, ws, { graceMs: 10, heartbeatMs: 1000 });
    handlers["ws:message"]?.(Buffer.from("keystroke"));
    expect(pty.write).toHaveBeenCalledWith("keystroke");
    handlers["ws:message"]?.(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    expect(pty.resize).toHaveBeenCalledWith(120, 40);
  });
  it("routes a real-ws TEXT resize frame (Buffer + isBinary=false) to pty.resize, not pty.write", () => {
    // Real `ws` delivers text frames as Buffers with isBinary===false — NOT JS strings. A bridge that
    // only checked `typeof raw === 'string'` would misroute resize JSON into the pty as keystrokes.
    const { pty, ws, handlers } = mocks();
    bridgePtyToWs(pty, ws, { graceMs: 10, heartbeatMs: 1000 });
    handlers["ws:message"]?.(Buffer.from(JSON.stringify({ type: "resize", cols: 90, rows: 30 })), false);
    expect(pty.resize).toHaveBeenCalledWith(90, 30);
    expect(pty.write).not.toHaveBeenCalled();
  });
  it("ignores a malformed text control frame without throwing", () => {
    const { pty, ws, handlers } = mocks();
    bridgePtyToWs(pty, ws, { graceMs: 10, heartbeatMs: 1000 });
    expect(() => handlers["ws:message"]?.("}{ not json")).not.toThrow();
    expect(pty.resize).not.toHaveBeenCalled();
  });
  it("drops output when bufferedAmount is over the bound (backpressure)", () => {
    const { pty, ws, handlers } = mocks();
    ws.bufferedAmount = 5_000_000;
    bridgePtyToWs(pty, ws, { graceMs: 10, heartbeatMs: 1000, maxBuffered: 1_000_000 });
    handlers.data?.(Buffer.from("flood"));
    expect(ws.send).not.toHaveBeenCalled();
  });
  it("ws close kills the pty", () => {
    const { pty, ws, handlers } = mocks();
    bridgePtyToWs(pty, ws, { graceMs: 10, heartbeatMs: 1000 });
    handlers["ws:close"]?.();
    expect(pty.kill).toHaveBeenCalledWith("SIGHUP");
  });
  it("escalates to SIGKILL after graceMs when the pty ignores SIGHUP", () => {
    const { pty, ws, handlers } = mocks();
    vi.useFakeTimers();
    try {
      bridgePtyToWs(pty, ws, { graceMs: 10, heartbeatMs: 1000 });
      handlers["ws:close"]?.();
      expect(pty.kill).toHaveBeenCalledWith("SIGHUP");
      expect(pty.kill).not.toHaveBeenCalledWith("SIGKILL");
      vi.advanceTimersByTime(11);
      expect(pty.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
  it("teardown is idempotent: close then error → exactly one SIGHUP and one SIGKILL", () => {
    const { pty, ws, handlers } = mocks();
    vi.useFakeTimers();
    try {
      bridgePtyToWs(pty, ws, { graceMs: 10, heartbeatMs: 1000 });
      handlers["ws:close"]?.();
      handlers["ws:error"]?.();
      vi.advanceTimersByTime(50);
      expect(pty.kill.mock.calls.filter(([s]) => s === "SIGHUP")).toHaveLength(1);
      expect(pty.kill.mock.calls.filter(([s]) => s === "SIGKILL")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("swallows a throwing pty.kill on both the SIGHUP and the SIGKILL path", () => {
    const { pty, ws, handlers } = mocks();
    pty.kill.mockImplementation(() => { throw new Error("ESRCH"); });
    vi.useFakeTimers();
    try {
      bridgePtyToWs(pty, ws, { graceMs: 10, heartbeatMs: 1000 });
      expect(() => handlers["ws:close"]?.()).not.toThrow();
      expect(() => { vi.advanceTimersByTime(11); }).not.toThrow();
      expect(pty.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
  it("swallows a throwing pty.write / pty.resize (pty exited but close not yet observed)", () => {
    const { pty, ws, handlers } = mocks();
    pty.write.mockImplementation(() => { throw new Error("EIO"); });
    pty.resize.mockImplementation(() => { throw new Error("EIO"); });
    bridgePtyToWs(pty, ws, { graceMs: 10, heartbeatMs: 1000 });
    expect(() => handlers["ws:message"]?.(Buffer.from("keystroke"))).not.toThrow();
    expect(() => handlers["ws:message"]?.(JSON.stringify({ type: "resize", cols: 80, rows: 24 }))).not.toThrow();
  });
  it("pty exit closes the ws", () => {
    const { pty, ws, handlers } = mocks();
    bridgePtyToWs(pty, ws, { graceMs: 10, heartbeatMs: 1000 });
    handlers.exit?.();
    expect(ws.close).toHaveBeenCalled();
  });
  it("starts a heartbeat that pings the ws (and stops after close)", () => {
    const { pty, ws, handlers } = mocks();
    vi.useFakeTimers();
    try {
      bridgePtyToWs(pty, ws, { graceMs: 10, heartbeatMs: 1000 });
      vi.advanceTimersByTime(1000);
      expect(ws.ping).toHaveBeenCalledTimes(1);
      handlers["ws:pong"]?.(); // browser answers → stays alive
      vi.advanceTimersByTime(1000);
      expect(ws.ping).toHaveBeenCalledTimes(2);
      handlers["ws:close"]?.(); // teardown clears the interval
      vi.advanceTimersByTime(3000);
      expect(ws.ping).toHaveBeenCalledTimes(2); // no more pings after close
    } finally {
      vi.useRealTimers();
    }
  });
  it("reaps a half-open ws: an unanswered ping → terminate + pty reap (SEC-3)", () => {
    // A dead browser (laptop sleep, killed tab) emits no close/error for minutes of TCP timeout,
    // but it also stops answering pings — the bridge must not let it hold the herdr --takeover
    // input lock and a limiter slot for that long.
    const { pty, ws, handlers } = mocks();
    vi.useFakeTimers();
    try {
      bridgePtyToWs(pty, ws, { graceMs: 10, heartbeatMs: 1000 });
      vi.advanceTimersByTime(1000); // ping #1
      handlers["ws:pong"]?.();      // answered — no reap
      vi.advanceTimersByTime(1000); // ping #2
      expect(ws.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000); // ping #2 never answered → reap instead of ping #3
      expect(ws.ping).toHaveBeenCalledTimes(2);
      expect(ws.terminate).toHaveBeenCalledTimes(1);
      expect(pty.kill).toHaveBeenCalledWith("SIGHUP"); // teardown ran: takeover lock released
      vi.advanceTimersByTime(11);
      expect(pty.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
});
