import { ENV_CONFIG_PATH } from "../config.ts";
import { formatReport, runPreflight } from "../server/preflight.ts";

/**
 * Guard that runs before the dev/prod stack starts. It exists because `process.exit(1)` inside the
 * server does not stop `npm run dev`: `tsx watch` survives its child's exit, so `concurrently -k`
 * never fires and vite keeps serving a live page over a dead backend.
 *
 * Its job is to STOP the launch, not narrate it — the server prints the report on every healthy start.
 */
const { report } = await runPreflight(process.env, ENV_CONFIG_PATH);

if (report.fatal) {
  console.error(formatReport(report.lines));
  console.error("\nFATAL: refusing to start.");
  process.exit(1);
}
