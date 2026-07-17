import { nanoid } from "nanoid";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_NAME_LEN = 200;

/**
 * Confine an uploaded file's name to a safe, single-token basename. Strips any directory components,
 * then charset-reduces the WHOLE remaining string to [A-Za-z0-9._-] (removing spaces, control bytes,
 * ESC, and shell/terminal metacharacters) — so the eventual injected path is one token and can carry
 * no escape sequence. Degenerate results (empty, all-dots) become "file" so the write can never climb
 * out of its nanoid subdir. Over-length names are capped while keeping the extension (image detection).
 */
export function sanitizeUploadName(name: string): string {
  const base = (name.split(/[/\\]/).pop() ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (base === "" || /^\.+$/.test(base)) return "file";
  if (base.length <= MAX_NAME_LEN) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  return base.slice(0, Math.max(1, MAX_NAME_LEN - ext.length)) + ext;
}

/** Write bytes to `root/<nanoid>/<safe-name>` and return the absolute path. */
export async function writeUploadFile(opts: {
  readonly root: string;
  readonly originalName: string;
  readonly bytes: Uint8Array;
}): Promise<string> {
  const dir = path.join(opts.root, nanoid());
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, sanitizeUploadName(opts.originalName));
  await writeFile(dest, opts.bytes);
  return dest;
}

/** Best-effort recursive remove of the upload root (bounds disk to one server run). Never throws. */
export async function sweepUploadRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
