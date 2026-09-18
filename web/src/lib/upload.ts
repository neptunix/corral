import { UPLOAD_MAX_BYTES, UploadResponseSchema } from "@shared/schema";
import { z } from "zod";

const ErrorBodySchema = z.object({ error: z.object({ message: z.string().optional() }).optional() });

/** True while a native file drag is in progress (DataTransfer advertises the "Files" type). */
export function isFileDrag(types: readonly string[]): boolean {
  return types.includes("Files");
}

/**
 * Upload one file to an env's upload endpoint; returns the absolute path on that env's machine.
 * XHR rather than fetch because fetch exposes no upload progress. `onProgress` reports the
 * browser→server leg as a 0..1 fraction; for a remote env the server then still has to stream the
 * bytes on over ssh, which the browser cannot observe, so the request outlives the last report.
 */
export function uploadFile(env: string, file: File, onProgress?: (fraction: number) => void): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/envs/${encodeURIComponent(env)}/uploads`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () => { reject(new Error("upload failed: network error")); };
    xhr.onload = () => {
      const raw: unknown = xhr.response;
      if (xhr.status < 200 || xhr.status >= 300) {
        const parsed = ErrorBodySchema.safeParse(raw);
        reject(new Error(parsed.success ? (parsed.data.error?.message ?? `HTTP ${String(xhr.status)}`) : `HTTP ${String(xhr.status)}`));
        return;
      }
      const ok = UploadResponseSchema.safeParse(raw);
      if (ok.success) resolve(ok.data.path); else reject(new Error("upload failed: malformed response"));
    };
    // No Content-Type header — the browser sets multipart/form-data with the boundary.
    xhr.send(fd);
  });
}

export { UPLOAD_MAX_BYTES };
