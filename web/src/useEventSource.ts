import { useEffect, useState } from "react";
import type { ZodType, ZodTypeDef } from "zod";

export function useEventSource<T>(url: string, schema: ZodType<T, ZodTypeDef, unknown>): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    const es = new EventSource(url);
    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const parsed = schema.safeParse(JSON.parse(e.data));
        if (parsed.success) setData(parsed.data);
        // A dropped frame is indistinguishable from "no data yet" on screen, and the view it feeds
        // then sits frozen until the next frame parses — so say so. This has bitten before: the
        // no-board stream once sent a bare Snapshot and every frame was discarded in silence.
        else console.warn(`[corral] dropped an unparseable frame from ${url}`, parsed.error.issues);
      } catch {
        /* ignore a malformed frame */
      }
    };
    return () => { es.close(); };
  }, [url, schema]);
  return data;
}
