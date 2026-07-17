import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { ENV_CONFIG_PATH } from "./config.ts";

const SafeToken = z.string().regex(/^[A-Za-z0-9~/._:@-]+$/, "must not contain spaces or shell metacharacters");

// Stricter than SafeToken (no `:` `/` `~` `@`): the id is a URL path segment and the prefix of
// `${env.id}:${paneId}` attention keys, which both server enrichment and client routing split on the
// FIRST colon — a colon inside the id would silently land the split inside the id.
const EnvIdToken = z.string().regex(/^[A-Za-z0-9._-]+$/, "env id must use only letters, digits, '.', '_', '-' (it is a URL segment and the 'env:paneId' key prefix)");

const RemoteReposValue = SafeToken.refine((s) => !s.startsWith("~"), {
  message: "remote repos paths must be absolute — ~ is not expanded on the remote shell",
});

const RawLocalEnvSchema = z.object({
  id: EnvIdToken, label: z.string(), kind: z.literal("local"),
  socket: SafeToken.optional(),
  claudeConfigDirs: z.array(z.string()).optional(),
  spawnCommand: SafeToken.optional(),
  repos: z.record(z.string(), z.string()).optional(),
});
const RawRemoteEnvSchema = z.object({
  id: EnvIdToken, label: z.string(), kind: z.literal("remote"),
  sshHost: SafeToken, socket: SafeToken, herdrBin: SafeToken,
  claudeConfigDirs: z.array(
    SafeToken.refine((s) => !s.startsWith("~"), {
      message: "remote claudeConfigDirs must be absolute — ~ is not expanded on the remote shell",
    })
  ).optional(),
  spawnCommand: SafeToken.optional(),
  repos: z.record(z.string(), RemoteReposValue).optional(),
});
const RawHerdrEnvSchema = z.discriminatedUnion("kind", [RawLocalEnvSchema, RawRemoteEnvSchema]);
type RawHerdrEnv = z.infer<typeof RawHerdrEnvSchema>;

const EnvConfigSchema = z.object({ environments: z.array(RawHerdrEnvSchema).min(1) });

export type HerdrEnv =
  | { readonly id: string; readonly label: string; readonly kind: "local"; readonly socket?: string; readonly claudeConfigDirs: readonly string[]; readonly spawnCommand: string; readonly repos: Readonly<Record<string, string>> }
  | { readonly id: string; readonly label: string; readonly kind: "remote"; readonly sshHost: string; readonly socket: string; readonly herdrBin: string; readonly claudeConfigDirs: readonly string[]; readonly spawnCommand: string; readonly repos: Readonly<Record<string, string>> };

const LOCAL_DEFAULT_DIRS = ["~/.claude"] as const;

function expandDir(d: string): string {
  const home = os.homedir();
  if (d.startsWith("~/")) return path.join(home, d.slice(2));
  if (d === "~") return home;
  return d;
}

function expandRepos(repos: Record<string, string> | undefined, expand: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(repos ?? {})) out[k] = expand ? expandDir(v) : v;
  return out;
}

function postProcess(raw: RawHerdrEnv): HerdrEnv {
  const spawnCommand = raw.spawnCommand ?? "claude";
  if (raw.kind === "local") {
    const dirs: readonly string[] = (raw.claudeConfigDirs ?? LOCAL_DEFAULT_DIRS).map(expandDir);
    const repos = expandRepos(raw.repos, true);
    const base = { id: raw.id, label: raw.label, kind: "local" as const, claudeConfigDirs: dirs, spawnCommand, repos };
    return raw.socket !== undefined ? { ...base, socket: raw.socket } : base;
  }
  return {
    id: raw.id, label: raw.label, kind: "remote" as const,
    sshHost: raw.sshHost, socket: raw.socket, herdrBin: raw.herdrBin,
    claudeConfigDirs: raw.claudeConfigDirs ?? [],
    spawnCommand, repos: expandRepos(raw.repos, false),
  };
}

// Trusted operator config, loaded ONCE at startup — same trust level as source code (whoever runs
// the server owns the file). NEVER mutate environments via the web API/UI: a runtime-set sshHost
// would turn the server into an SSH relay (spec §4, §13). A local entry with no socket inherits
// the ambient HERDR_SOCKET_PATH; the server warns at startup if it is unset.
export function loadEnvironments(filePath: string = ENV_CONFIG_PATH): readonly HerdrEnv[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read environments config at ${filePath} (copy environments.example.json there): ${msg}`);
  }
  const result = EnvConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`invalid environments config at ${filePath}: ${result.error.message}`);
  }
  return result.data.environments.map(postProcess);
}

export const ENVIRONMENTS: readonly HerdrEnv[] = loadEnvironments();

export function getEnv(id: string): HerdrEnv {
  const env = ENVIRONMENTS.find((e) => e.id === id);
  if (!env) throw new Error(`unknown environment: ${id}`);
  return env;
}
