import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { BOARD_DATA_DIR, HOST, PORT, UPLOAD_ROOT, WS_ALLOWED_ORIGINS } from "../config.ts";
import { ENVIRONMENTS } from "../environments.ts";
import { createApi } from "./api.ts";
import { createAttentionStore } from "./attention-store.ts";
import { createGit } from "./git.ts";
import { listWorkspaces, readPane, tabClose, workspaceClose } from "./herdr.ts";
import { assertLoopback } from "./host-guard.ts";
import { createPoller } from "./poller.ts";
import { startReconciler } from "./reconcile.ts";
import { spawnSession } from "./spawn.ts";
import { createStorage } from "./storage.ts";
import { readLastActivity } from "./transcript.ts";
import { sweepUploadRoot } from "./uploads.ts";
import { attachWebSocketServer } from "./ws-attach.ts";

assertLoopback(HOST);

if (process.env.HERDR_SOCKET_PATH === undefined) {
  console.warn(
    'HERDR_SOCKET_PATH is unset — any `kind:"local"` environment without an explicit `socket` inherits ' +
      "the ambient socket and may return no sessions or route to the wrong herdr instance. " +
      "Launch from the intended herdr context or set HERDR_SOCKET_PATH.",
  );
}

const storage = createStorage(BOARD_DATA_DIR);
const git = createGit(BOARD_DATA_DIR);

void (async () => {
  await storage.ensureFirstRunBoard();
  await git.ensureRepo();
  git.start();
  await sweepUploadRoot(UPLOAD_ROOT); // clear last run's dropped files (bounded disk use, no GC)

  // recap sweep is live by default (RECAP_ENABLED=true, 60s interval); set RECAP_ENABLED=false to disable
  const attention = createAttentionStore({ dataDir: BOARD_DATA_DIR, read: readPane });
  attention.init(); // load attention.json once at startup (§3.2)
  const poller = createPoller({ envs: ENVIRONMENTS, attention });
  poller.start();
  // Backfill stored links' Claude sessionId once the poller sees it (spawned links start null) — the
  // write-side half of persistent session identity; buildBoardState does the read-side churn-heal.
  startReconciler({ poller, storage });

  const app = createApi({
    poller, envs: ENVIRONMENTS, storage,
    listWorkspaces,
    closeTab: tabClose,
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
  attachWebSocketServer(server, { envs: ENVIRONMENTS, allowedOrigins: WS_ALLOWED_ORIGINS });
})();
