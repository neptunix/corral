import { useEffect, useRef, useState } from "react";
import type { ZodType, ZodTypeDef } from "zod";

/**
 * How long an unrecovered error must persist before the stream counts as down. `EventSource` retries
 * a network failure forever and its `readyState` never reaches CLOSED, so readyState alone cannot see
 * a dead server; `onerror` alone fires on every ordinary reconnect and would flash a fatal row.
 */
const DEFAULT_GRACE_MS = 10_000;

export interface StreamState<T> {
  /**
   * The latest parsed frame. Its IDENTITY is part of the contract: App keys an effect on this value to
   * clear its post-mutation override and optimistic overlay, so handing back a new object on a status
   * change alone would fire that effect on every render and wipe the overlay.
   */
  readonly frame: T | null;
  readonly streamDown: boolean;
}

export function useEventSource<T>(
  url: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  graceMs: number = DEFAULT_GRACE_MS,
): StreamState<T> {
  const [data, setData] = useState<T | null>(null);
  const [streamDown, setStreamDown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Drop the previous url's frame. This hook returns "the latest frame from THIS url", and holding a
    // frame minted by a different one is simply wrong: `/api/stream?board=` encodes the board, so a
    // retained frame kept the OLD board's tasks on screen under the newly selected board until the new
    // stream produced its first frame — and it masked the REST seed that exists precisely to cover a
    // first frame that is slow, buffered, or schema-rejected.
    setData(null);
    setStreamDown(false);
    const clearTimer = (): void => {
      if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    };
    const recovered = (): void => { clearTimer(); setStreamDown(false); };

    const es = new EventSource(url);
    es.onopen = recovered;
    es.onmessage = (e: MessageEvent<string>) => {
      recovered();
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
    es.onerror = () => {
      // ARM ONCE. The browser fires this on every failed reconnect attempt (roughly every 3s), so
      // re-arming here would cancel the pending timer forever and the outage would never be reported.
      if (timer.current !== null) return;
      timer.current = setTimeout(() => { timer.current = null; setStreamDown(true); }, graceMs);
    };
    return () => { clearTimer(); es.close(); };
  }, [url, schema, graceMs]);

  return { frame: data, streamDown };
}
