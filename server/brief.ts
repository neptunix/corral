import { nanoid } from "nanoid";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { writeAtomic } from "./atomic-store.ts";

// Prepended to every brief so a spawned session always reads its card before starting (spec UC-1),
// rather than depending on the brief's author remembering to say so.
export const BRIEF_PREAMBLE =
  "Before you start: call the corral_whoami tool to read your session identity and assigned card.";

/**
 * What the new session receives if the shell could not read the brief file.
 *
 * `$(cat <missing>)` expands to the EMPTY STRING, so without this the pane would launch with no
 * first message at all while corral_spawn had already reported success — a handoff lost silently.
 * This turns that into a state the session can report. Kept free of apostrophes: it is embedded in
 * a single-quoted shell word.
 */
export const BRIEF_FALLBACK =
  "corral could not deliver your brief (the handoff file was unreadable). Call corral_whoami to read your card, then tell the operator the brief was lost.";

/** The start-command counterpart of BRIEF_FALLBACK. Nothing was handed off here and no prior session
 *  authored this text, so the handoff wording would be actively misleading. Apostrophe-free. */
export const START_COMMAND_FALLBACK =
  "corral could not deliver your start command (the file was unreadable). Call corral_whoami to read your card, then tell the operator the start command was lost.";

/** Preamble + blank line + the brief verbatim. */
export function composeBrief(brief: string): string {
  return `${BRIEF_PREAMBLE}\n\n${brief}`;
}

/** Byte length, which is what the cap is expressed in — a char count would under-measure UTF-8. */
export function briefByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Write a brief and return its absolute path. The filename is generated server-side from `nanoid`,
 * so the caller influences no part of the path and the result is a single shell-safe token. The write
 * is atomic (temp + rename) so the launching shell can never `cat` a half-written file.
 */
export async function writeBrief(root: string, text: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const dest = path.join(root, `${nanoid()}.md`);
  // 0o600: a brief is agent-authored handoff text under os.tmpdir(). On Linux that is /tmp (mode 1777),
  // so at a default umask this file would be world-readable for as long as it exists.
  writeAtomic(dest, text, 0o600);
  return dest;
}

/** Best-effort recursive remove of the brief root (belt-and-braces for a crashed process). Never throws. */
export async function sweepBriefRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Best-effort removal of a single brief file once its spawn attempt is done (bounds disk to one
 * spawn, not one server run — see config.ts BRIEF_CLEANUP_DELAY_MS for why the caller delays this
 * rather than calling it the instant the spawn call returns). Never throws.
 */
export async function cleanupBrief(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => undefined);
}
