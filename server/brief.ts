import { nanoid } from "nanoid";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { writeAtomic } from "./atomic-store.ts";

// Prepended to every brief so a spawned session always reads its card before starting (spec UC-1),
// rather than depending on the brief's author remembering to say so.
export const BRIEF_PREAMBLE =
  "Before you start: call the corral_whoami tool to read your session identity and assigned card.";

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
  writeAtomic(dest, text);
  return dest;
}

/** Best-effort recursive remove of the brief root (bounds disk to one server run). Never throws. */
export async function sweepBriefRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
