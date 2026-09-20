import type { Check } from "@shared/diagnostics-schema";
import { checkKey } from "@shared/diagnostics-schema";
import path from "node:path";
import { z } from "zod";

import type { CheckDeps } from "./deps.ts";
import type { HerdrEnv } from "../../environments.ts";
import type { TunnelStatus } from "../remote-mcp/status.ts";

const LOCAL_DOC = { anchor: "mcp-server", title: "MCP server" };
const REMOTE_DOC = { anchor: "mcp-on-a-remote-environment", title: "MCP on a remote environment" };
const SERVER_NAME = "corral";
export const SHIM_REPO_PATH = "scripts/corral-mcp-shim.mjs";

const ServerSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
type Server = z.infer<typeof ServerSchema>;

type Registration =
  | { readonly kind: "registered"; readonly server: Server }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

/** Where `claude mcp add --scope user` writes: `<dir>/.claude.json`, or `~/.claude.json` for the default dir. */
export function registrationFiles(dir: string): readonly string[] {
  const own = `${dir}/.claude.json`;
  return path.basename(dir) === ".claude" ? [own, `${path.dirname(dir)}/.claude.json`] : [own];
}

/** Null when the text is not JSON, or has a `corral` entry that is not an object. */
export function parseRegistration(text: string): Registration | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const top = z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() }).safeParse(json);
  if (!top.success) return null;
  const entry = top.data.mcpServers?.[SERVER_NAME];
  if (entry === undefined) return { kind: "absent" };
  const server = ServerSchema.safeParse(entry);
  return server.success ? { kind: "registered", server: server.data } : null;
}

export function readRegistration(deps: CheckDeps, dir: string): Registration {
  let unreadable = false;
  for (const file of registrationFiles(dir)) {
    const text = deps.readText(file);
    if (text === null) {
      // Present but not readable is the size cap: ~/.claude.json grows with every project opened.
      if (deps.isFile(file)) unreadable = true;
      continue;
    }
    const parsed = parseRegistration(text);
    if (parsed === null) unreadable = true;
    else if (parsed.kind === "registered") return parsed;
  }
  return unreadable ? { kind: "unreadable" } : { kind: "absent" };
}

export function shimPathOf(server: Server): string | null {
  return [server.command, ...(server.args ?? [])].find((a) => a?.startsWith("/") === true && a.endsWith(".mjs")) ?? null;
}

interface Row { readonly title: string; readonly state: Check["state"]; readonly severity: Check["severity"]; readonly detail: string }

function configDirRow(id: string, envId: string, dir: string, doc: Check["doc"], now: number, r: Row): Check {
  const scope = { kind: "configDir" as const, envId, dir };
  return { ...r, id, key: checkKey(id, scope), scope, doc, class: "cheap", checkedAt: now, startupOkLine: false, haltsStartup: false };
}

type RemoteEnv = Extract<HerdrEnv, { readonly kind: "remote" }>;

function registeredCheck(deps: CheckDeps, env: HerdrEnv, dir: string, reg: Registration): Check {
  const remote = env.kind === "remote";
  const doc = remote ? REMOTE_DOC : LOCAL_DOC;
  const make = (r: Row): Check => configDirRow("mcp-registered", env.id, dir, doc, deps.now(), r);
  const severity = remote ? "warning" : "info";
  if (reg.kind === "unreadable") {
    return make({
      title: `MCP registration in ${dir} could not be read`, state: "n/a", severity,
      detail: `${registrationFiles(dir).join(" or ")} is over the size cap or not valid JSON.`,
    });
  }
  if (reg.kind === "absent") {
    return make({
      title: `corral MCP server is not registered in ${dir}`, state: "problem", severity,
      detail: remote
        ? `Sessions using ${dir} have no corral_* tools. Register the shim there with \`claude mcp add --scope user corral\` — see README → "MCP on a remote environment".`
        : `Sessions using ${dir} have no corral_* tools. Register it with \`claude mcp add --scope user corral\` — see README → "MCP server".`,
    });
  }
  const want = env.kind === "remote" ? env.mcpSocket : undefined;
  const have = reg.server.env?.CORRAL_MCP_SOCKET;
  if (want !== undefined && have !== want) {
    return make({
      title: `corral MCP registration in ${dir} points at the wrong socket`, state: "problem", severity,
      detail: `CORRAL_MCP_SOCKET is ${have ?? "unset"} but corral serves ${want} — the shim fails with a connect error naming neither.`,
    });
  }
  return make({ title: `corral MCP server is registered in ${dir}`, state: "ok", severity, detail: "" });
}

function shimCheck(deps: CheckDeps, env: RemoteEnv, dir: string, reg: Registration): Check {
  const make = (r: Row): Check => configDirRow("mcp-shim-installed", env.id, dir, REMOTE_DOC, deps.now(), r);
  if (reg.kind !== "registered") {
    return make({ title: `MCP shim not checked in ${dir}`, state: "n/a", severity: "warning", detail: "No corral MCP registration to read the shim path from." });
  }
  const shim = shimPathOf(reg.server);
  if (shim === null) {
    return make({ title: `MCP shim not checked in ${dir}`, state: "n/a", severity: "warning", detail: "The registration names no absolute .mjs path." });
  }
  if (!deps.isFile(shim)) {
    return make({
      title: `MCP shim is missing in ${dir}`, state: "problem", severity: "warning",
      detail: `The registration launches ${shim}, which does not exist — copy ${SHIM_REPO_PATH} there.`,
    });
  }
  const installed = deps.hashFile(shim);
  const repo = deps.hashFile(`${deps.repoRoot}/${SHIM_REPO_PATH}`);
  if (installed !== null && repo !== null && installed !== repo) {
    return make({
      title: `MCP shim in ${dir} differs from the checkout`, state: "problem", severity: "warning",
      detail: `${shim} does not match ${SHIM_REPO_PATH} — re-copy it.`,
    });
  }
  return make({ title: `MCP shim is installed in ${dir}`, state: "ok", severity: "warning", detail: "" });
}

/** A remote env without `mcpSocket` has opted out: no rows at all, so it can never read as a fault. */
export function mcpChecks(deps: CheckDeps, env: HerdrEnv, dir: string): Check[] {
  if (env.kind === "remote" && env.mcpSocket === undefined) return [];
  const reg = readRegistration(deps, dir);
  const registered = registeredCheck(deps, env, dir, reg);
  return env.kind === "remote" ? [registered, shimCheck(deps, env, dir, reg)] : [registered];
}

export function mcpTunnelCheck(env: RemoteEnv, tunnels: TunnelStatus, now: number): Check {
  const scope = { kind: "env" as const, envId: env.id };
  const base = {
    id: "mcp-tunnel", key: checkKey("mcp-tunnel", scope), scope, doc: REMOTE_DOC,
    class: "cheap" as const, checkedAt: now, startupOkLine: false, haltsStartup: false, severity: "warning" as const,
  };
  if (env.mcpSocket === undefined) {
    return { ...base, title: `MCP not configured for "${env.id}"`, state: "n/a", detail: "No mcpSocket — this environment has opted out of the remote MCP surface." };
  }
  const reading = tunnels.get(env.id);
  if (reading === undefined) {
    return { ...base, title: `MCP tunnel to "${env.id}" not attempted yet`, state: "pending", detail: "" };
  }
  if (reading === "no-listener") {
    return {
      ...base, title: `MCP listener for "${env.id}" is not serving`, state: "problem",
      detail: "corral could not open its local socket for this environment at startup, so no tunnel was tried — the server log has the error.",
    };
  }
  if (reading === "down") {
    return {
      ...base, title: `MCP tunnel to "${env.id}" is down`, state: "problem",
      detail: "Sessions there have no corral_* tools. If it never comes up, the key in the remote's authorized_keys probably lacks `port-forwarding` — see README → \"MCP on a remote environment\"; the server log has the ssh error.",
    };
  }
  return { ...base, title: `MCP tunnel to "${env.id}" is up`, state: "ok", detail: "" };
}
