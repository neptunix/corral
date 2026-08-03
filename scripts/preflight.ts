import { ENV_CONFIG_PATH } from "../config.ts";
import {
  buildReport, findMissingBinaries, formatReport, isExecutableFile, loadEnvironmentsOrReport,
  resolveOnPath,
} from "../server/preflight.ts";

/**
 * npm pre-step for `dev` and `start`. It exists because `process.exit(1)` inside the server does not
 * stop `npm run dev`: `tsx watch` survives its child's exit, so `concurrently -k` never fires and vite
 * keeps serving a live page over a dead backend.
 *
 * Its job is to STOP the launch, not to narrate it — the server prints the report on every healthy
 * start. Printing here too would double it, so this stays silent unless it is about to abort.
 */
const pathEnv = process.env.PATH ?? "";
const cfg = await loadEnvironmentsOrReport(
  async () => (await import("../environments.ts")).ENVIRONMENTS,
  ENV_CONFIG_PATH,
);
const report = buildReport({
  env: process.env,
  envs: cfg.ok ? cfg.envs : null,
  configLine: cfg.line,
  missing: cfg.ok ? findMissingBinaries(cfg.envs, (bin) => resolveOnPath(bin, pathEnv, isExecutableFile)) : [],
  pathEnv,
});

if (report.fatal) {
  console.error(formatReport(report.lines));
  console.error("\nFATAL: refusing to start.");
  process.exit(1);
}
