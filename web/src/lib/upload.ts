import { UPLOAD_MAX_BYTES, UploadResponseSchema } from "@shared/schema";
import { z } from "zod";

const ErrorBodySchema = z.object({ error: z.object({ message: z.string().optional() }).optional() });

/** True while a native file drag is in progress (DataTransfer advertises the "Files" type). */
export function isFileDrag(types: readonly string[]): boolean {
  return types.includes("Files");
}

/** Upload one file to the local env's upload endpoint; returns the absolute on-host path. */
export async function uploadFile(env: string, file: File): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  // No Content-Type header — the browser sets multipart/form-data with the boundary.
  const res = await fetch(`/api/envs/${encodeURIComponent(env)}/uploads`, { method: "POST", body: fd });
  if (!res.ok) {
    const raw: unknown = await res.json().catch(() => ({}));
    const parsed = ErrorBodySchema.safeParse(raw);
    const message = parsed.success ? (parsed.data.error?.message ?? `HTTP ${String(res.status)}`) : `HTTP ${String(res.status)}`;
    throw new Error(message);
  }
  const json: unknown = await res.json();
  return UploadResponseSchema.parse(json).path;
}

export { UPLOAD_MAX_BYTES };
