import http from "node:http";

import { HOST, PORT } from "../config.ts";
import { formatRestoreReport, parseRestoreArgs } from "../server/restore-format.ts";
import type { FleetRestoreReport } from "../shared/schema.ts";
import { FleetRestoreReportSchema } from "../shared/schema.ts";

const parsed = parseRestoreArgs(process.argv.slice(2));
if ("error" in parsed) {
  console.error(`${parsed.error}\nusage: npm run fleet:restore [-- --dry-run] [-- --env <id>]`);
  process.exit(2);
}
const body = JSON.stringify({
  ...(parsed.dryRun ? { dryRun: true } : {}),
  ...(parsed.env !== null ? { env: parsed.env } : {}),
});

// node:http, not fetch: undici's default headers timeout (~5 min) can be shorter than a large remote
// fleet's sequential resume, and the server only answers once the whole restore has run.
function post(): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST, port: PORT, path: "/api/fleet/restore", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => { resolve({ status: res.statusCode ?? 0, text }); });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

let response: { status: number; text: string };
try {
  response = await post();
} catch (err) {
  console.error(`cannot reach corral at http://${HOST}:${String(PORT)} — is the server running? (${err instanceof Error ? err.message : String(err)})`);
  process.exit(1);
}
if (response.status !== 200) {
  console.error(`restore failed: HTTP ${String(response.status)}\n${response.text}`);
  process.exit(1);
}
let report: FleetRestoreReport;
try {
  report = FleetRestoreReportSchema.parse(JSON.parse(response.text));
} catch (err) {
  console.error(`unexpected response shape: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const { text, exitCode } = formatRestoreReport(report, Math.floor(Date.now() / 1000));
process.stdout.write(`${text}\n`);
process.exit(exitCode);
