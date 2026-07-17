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
      } catch {
        /* ignore a malformed frame */
      }
    };
    return () => { es.close(); };
  }, [url, schema]);
  return data;
}
