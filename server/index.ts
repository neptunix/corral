import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import {
  BOARD_DATA_DIR, BRIEF_ROOT, CHEAP_INTERVAL_MS, ENV_CONFIG_PATH, HOST, LIST_TIMEOUT, PORT,
  UPLOAD_ROOT, WS_ALLOWED_ORIGINS, ZOMBIE_REAP_ENABLED, ZOMBIE_REAP_GRACE_MS,
} from "../config.ts";
import { createApi } from "./api.ts";
import { createAttentionStore } from "./attention-store.ts";
import { sweepBriefRoot } from "./brief.ts";
import { createGit } from "./git.ts";
import { closePane, listTabs, listWorkspaces, readPane, workspaceClose } from "./herdr.ts";
import { assertLoopback } from "./host-guard.ts";
import { createPoller } from "./poller.ts";
import {
  buildReport, findMissingBinaries, formatReport, isExecutableFile, loadEnvironmentsOrReport,
  resolveOnPath, resolveReapGrace,
} from "./preflight.ts";
import { startReconciler } from "./reconcile.ts";
import { spawnSession } from "./spawn.ts";
import { createStorage } from "./storage.ts";
import { readLastActivity } from "./transcript.ts";
import { sweepUploadRoot } from "./uploads.ts";
import { attachWebSocketServer } from "./ws-attach.ts";
import { startZombieReaper } from "./zombie-reaper.ts";

assertLoopback(HOST);

// The config is loaded through a DYNAMIC import on purpose: environments.ts evaluates ENVIRONMENTS at
// module scope, so a static import would throw during import resolution — before anything here could
// turn it into a readable line. Re-adding `import { ENVIRONMENTS }` compiles and lints clean while
// making this whole block unreachable; test/preflight-wiring.test.ts guards against exactly that.
const searchedPath = process.env.PATH ?? "";
const cfg = await loadEnvironmentsOrReport(
  async () => (await import("../environments.ts")).ENVIRONMENTS,
  ENV_CONFIG_PATH,
);
const report = buildReport({
  env: process.env,
  envs: cfg.ok ? cfg.envs : null,
  configLine: cfg.line,
  // Missing binaries are resolved against THIS process's PATH — see server/preflight.ts for why the
  // server's own environment is the only place that tell lives — and stay a warning, never fatal.
  missing: cfg.ok
    ? findMissingBinaries(cfg.envs, (bin) => resolveOnPath(bin, searchedPath, isExecutableFile))
    : [],
  pathEnv: searchedPath,
});
console.error(formatReport(report.lines));
if (report.fatal || !cfg.ok) {
  console.error("\nFATAL: refusing to start.");
  process.exit(1);
}
const ENVS = cfg.envs;

const storage = createStorage(BOARD_DATA_DIR);
const git = createGit(BOARD_DATA_DIR);

void (async () => {
  await storage.ensureFirstRunBoard();
  await git.ensureRepo();
  git.start();
  await sweepUploadRoot(UPLOAD_ROOT); // clear last run's dropped files (bounded disk use, no GC)
  await sweepBriefRoot(BRIEF_ROOT); // same contract for MCP spawn briefs

  // recap sweep is live by default (RECAP_ENABLED=true, 60s interval); set RECAP_ENABLED=false to disable
  const attention = createAttentionStore({ dataDir: BOARD_DATA_DIR, read: readPane });
  attention.init(); // load attention.json once at startup (§3.2)
  const poller = createPoller({ envs: ENVS, attention });
  poller.start();
  // Backfill stored links' Claude sessionId once the poller sees it (spawned links start null) — the
  // write-side half of persistent session identity; buildBoardState does the read-side churn-heal.
  startReconciler({ poller, storage });
  // Close shell-only tabs left behind when a Claude session exits (detached link whose herdr tab still
  // lingers). The ONLY place the poll loop mutates herdr — gated, guarded, and via pane close only.
  // Clamp + warning sit inside the gate: with the reaper off there is nothing to clamp or warn about.
  if (ZOMBIE_REAP_ENABLED) {
    const reapGrace = resolveReapGrace(ZOMBIE_REAP_GRACE_MS, CHEAP_INTERVAL_MS, LIST_TIMEOUT);
    if (reapGrace.message !== null) console.error(reapGrace.message);
    startZombieReaper({ poller, storage, envs: ENVS, listTabs, closePane, graceMs: reapGrace.ms });
  }

  const app = createApi({
    poller, envs: ENVS, storage,
    listWorkspaces,
    lastActivity: readLastActivity,
    allowedOrigins: WS_ALLOWED_ORIGINS,
    spawn: (opts) => spawnSession({
      ...opts,
      workspaceListFn: listWorkspaces,
      workspaceCloseFn: workspaceClose,
    }),
  });
  app.use("/*", serveStatic({ root: "./web/dist" })); // built frontend (Task 13+); absent in dev — harmless

  const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
    console.warn(`herdr-dashboard listening on http://${info.address}:${String(info.port)}`);
  });
  // Live-terminal WS attach rides the same loopback-only http server (assertLoopback above). SEC-1
  // Origin allowlist + SEC-2 rate/cap + SEC-3 reaping are all enforced inside attachWebSocketServer.
  attachWebSocketServer(server, { envs: ENVS, allowedOrigins: WS_ALLOWED_ORIGINS });
})();
