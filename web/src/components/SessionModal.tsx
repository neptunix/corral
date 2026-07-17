import type { StatuslineData } from "@shared/schema";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState, type JSX } from "react";

import { useTheme } from "./ThemeProvider";
import {
  ATTACH_LIVE_AFTER_MS, ATTACH_RETRY_DELAY_MS, shouldRetryAttach,
} from "../lib/attach";
import { contextLevelClass } from "../lib/level";
import { formatDropInjection, formatPaste } from "../lib/paste";
import { closeMessage } from "../lib/protocol";
import { isStale } from "../lib/time";
import { isFileDrag, uploadFile, UPLOAD_MAX_BYTES } from "../lib/upload";

import "@xterm/xterm/css/xterm.css";

// Backgrounds carry alpha (8-digit hex) so the frosted-glass panel behind shows through
// (paired with allowTransparency below). selectionBackground is set explicitly because xterm's
// default light-theme selection tint is nearly invisible on the light canvas.
const TERM_THEME = {
  dark: { background: "#12151dcc", foreground: "#e2e4e9", cursor: "#a99cf5", selectionBackground: "#a99cf54d" },
  light: { background: "#f5f6f8cc", foreground: "#24272f", cursor: "#5b34c9", selectionBackground: "#33415566" },
} as const;

interface Props {
  readonly env: string;
  readonly paneId: string;
  readonly awaitAgent?: boolean;
  // Bound task's title, shown as the header's primary label; "" (unassigned opens) falls back to paneId.
  readonly title?: string;
  readonly recap?: string | null;
  readonly statusline?: StatuslineData | null;
  // Enables drop-to-attach (upload + path injection). True for local envs only; remote needs SSH
  // byte transfer (v2), so the drop affordance is hidden there (the server also refuses remote uploads).
  readonly canAttachFiles?: boolean;
  readonly onClose: () => void;
}

// Renders the statusline's second-line chips: model · ctx NN% (NNK) · $X.XX · +A/−R. Any field null →
// its chip is omitted entirely (not "· —"), so a partial capture still reads clean. The ctx% is
// color-coded by level (green/amber/red) via contextLevelClass — which warns earlier than the 5h/7d
// windows since context degrades before it's full; everything else stays muted (parent span).
function MetricChips({ sl }: { readonly sl: StatuslineData }): JSX.Element {
  const chips: JSX.Element[] = [];
  if (sl.model !== null) chips.push(<span key="model">{sl.model}</span>);
  if (sl.ctx.pct !== null) {
    const pct = sl.ctx.pct;
    chips.push(
      <span key="ctx">
        ctx <span className={`font-semibold ${contextLevelClass(pct)}`}>{`${String(pct)}%`}</span>
        {sl.ctx.tokens !== null ? ` (${String(Math.round(sl.ctx.tokens / 1000))}K)` : ""}
      </span>,
    );
  }
  if (sl.cost.usd !== null) chips.push(<span key="cost">{`$${sl.cost.usd.toFixed(2)}`}</span>);
  if (sl.cost.lines_added !== null || sl.cost.lines_removed !== null) {
    chips.push(<span key="lines">{`+${String(sl.cost.lines_added ?? 0)}/−${String(sl.cost.lines_removed ?? 0)}`}</span>);
  }
  return (
    <>
      {chips.flatMap((chip, i) =>
        i === 0
          ? [chip]
          : [<span key={`sep-${String(chip.key)}`} className="text-muted-foreground/40"> · </span>, chip],
      )}
    </>
  );
}

export function SessionModal({
  env, paneId, awaitAgent = false, title = "", recap = null, statusline = null,
  canAttachFiles = false, onClose,
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [closeInfo, setCloseInfo] = useState<{ code: number; reason: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(awaitAgent);
  const startedAtRef = useRef(0);
  const { resolved } = useTheme();
  const resolvedRef = useRef<"light" | "dark">(resolved);
  resolvedRef.current = resolved;
  const termRef = useRef<Terminal | null>(null);
  // Drop-to-attach state. `liveRef`/`sendInputRef` bridge the drop handlers (outside the terminal
  // effect) to the effect-owned `live` flag and WebSocket, so a drop only uploads/injects on a live
  // session and never writes to a closed socket.
  const liveRef = useRef(false);
  const sendInputRef = useRef<((bytes: Uint8Array) => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  // Esc closes (kills WS→PTY via the teardown effect). Separate effect so it doesn't churn the terminal.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  // Stop a stray file drop ANYWHERE on the page from navigating the browser to the file — which would
  // unload the SPA and destroy this live session. Files-gated so it never intercepts the board's
  // @dnd-kit card reordering (pointer-based, no native HTML5 file drag-drop). Separate effect so it
  // doesn't churn the terminal. Registered while the modal is mounted.
  useEffect(() => {
    function guard(e: DragEvent): void {
      if (e.dataTransfer !== null && isFileDrag(e.dataTransfer.types)) e.preventDefault();
    }
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  // Auto-close on normal exit: the server mints code 1000 in exactly one place —
  // pty-bridge.ts "pty exited" — and the teardown below nulls ws.onclose before ws.close(), so a
  // user-initiated close never reaches this path. 1 s lets the "session ended" banner register.
  // Unconditional — no hasSelection guard. Failure codes
  // (4000/4001/1013) keep the modal open with the reason.
  useEffect(() => {
    if (closeInfo?.code !== 1000) return;
    const t = setTimeout(onClose, 1000);
    return () => { clearTimeout(t); };
  }, [closeInfo, onClose]);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    // SEC-5: pane output is UNTRUSTED (file names, git/web content the agent fetched). A browser-hosted
    // emulator interpreting escapes is a new sink, so disable every output→input write-back path:
    //  - allowProposedApi off (no experimental APIs).
    //  - windowOptions {} — all window report/response sequences off. The dangerous one is the title
    //    report (CSI 21 t after OSC 2 sets an attacker-controlled title), which would be written back as
    //    if typed — synthetic keystrokes into the live agent. Left-empty = every flag defaults false.
    //  - no clipboard addon → OSC 52 inert; no web-links addon → OSC 8 inert.
    //  DSR (CSI 6n → cursor position) and DA (CSI c → fixed capability string) are core VT and cannot be
    //  disabled, but they only ever emit bounded integers / a constant — no attacker-controlled bytes.
    const term = new Terminal({
      allowProposedApi: false,
      windowOptions: {},
      allowTransparency: true, // lets the alpha in TERM_THEME.background reveal the frosted panel behind
      // Claude Code's TUI enables mouse reporting, so a plain drag is sent to the app (via onData)
      // and never selects locally — ⌥+drag is the selection path for those panes, not an edge case.
      macOptionClickForcesSelection: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: TERM_THEME[resolvedRef.current],
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    term.focus();

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/api/sessions/${env}/${paneId}/attach`);
    ws.binaryType = "arraybuffer";

    let disposed = false;
    if (startedAtRef.current === 0) startedAtRef.current = Date.now();
    // When awaiting the agent, hold output until the connection proves live so a fast-fail (4001)
    // attempt's herdr error blob is discarded, not flashed. A normal (non-await) attach writes at once.
    let live = !awaitAgent;
    liveRef.current = live;
    const buffered: (string | Uint8Array)[] = [];
    let liveTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function sendResize(): void {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    }

    function goLive(): void {
      if (live) return;
      live = true;
      liveRef.current = true;
      setStarting(false);
      for (const d of buffered) term.write(d);
      buffered.length = 0;
    }

    ws.onopen = () => {
      sendResize();
      if (awaitAgent) liveTimer = setTimeout(goLive, ATTACH_LIVE_AFTER_MS);
    };
    ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      if (disposed) return;
      const data = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data;
      if (live) term.write(data);
      else buffered.push(data);
    };
    ws.onclose = (e: CloseEvent) => {
      if (disposed) return;
      // A closed socket is no longer live: clear the ref the drop handler reads so a drop in the
      // window after close (modal lingers on a failure banner or the ~1s auto-dismiss) is refused
      // BEFORE it uploads — otherwise it writes an orphan temp file whose path can never be injected.
      // Only the ref is cleared, not the effect-local `live`, which shouldRetryAttach below still reads.
      liveRef.current = false;
      if (liveTimer !== undefined) clearTimeout(liveTimer);
      // Boot race: retry a not-yet-live post-spawn attach (4001) until Claude registers or the window
      // elapses — the buffered error blob is dropped so the user only ever sees "starting…" then Claude.
      // `starting` is already true across the whole retry loop (init from awaitAgent, cleared only by
      // goLive/real-failure), so no setStarting here.
      if (shouldRetryAttach({ code: e.code, live, awaitAgent, elapsedMs: Date.now() - startedAtRef.current })) {
        retryTimer = setTimeout(() => { setAttempt((a) => a + 1); }, ATTACH_RETRY_DELAY_MS);
        return;
      }
      if (!live) { for (const d of buffered) term.write(d); buffered.length = 0; } // real failure → show what came
      setStarting(false);
      setCloseInfo({ code: e.code, reason: e.reason });
    };

    // Keystrokes → binary frame (the bridge treats binary as raw input); resize → text frame (JSON control).
    const dataSub = term.onData((d) => {
      // Drop input while buffering a not-yet-live session: output is hidden during "starting…", so any
      // keystroke would be blind — typed into a terminal the operator can't see. Flows once goLive fires.
      if (!live) return;
      if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d));
    });

    // Why corral brackets pastes itself instead of letting xterm do it: see formatPaste in lib/paste.ts.
    // CAPTURE phase is load-bearing here: xterm listens for "paste" on its textarea AND its element, both
    // descendants of `el`, and capture runs outer→inner, so this fires first and stopPropagation means
    // xterm never sees the event. preventDefault is separately required to stop the browser's default
    // insertion into the helper textarea.
    // Arrow, not a hoisted `function`: TS won't carry `el`'s null-narrowing into a hoisted decl.
    const onPasteCapture = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      // No text — an image, or no clipboardData at all. Fall through untouched: xterm's own handler
      // gates on `ev.clipboardData &&` and does nothing without text either, so nothing is lost.
      if (text === "") return;
      e.preventDefault();
      e.stopPropagation();
      // Taking over the paste path means inheriting its cleanup. xterm's paste() ends with
      // `textarea.value = ''`, and rightClickHandler seeds that helper textarea with the current
      // selection on EVERY right-click (unconditionally — the rightClickSelectsWord option gates only
      // the word-select). Skipping the clear would leave stale, selected text in it for a later
      // composition/input path to read.
      const helper = term.textarea;
      if (helper !== undefined) helper.value = "";
      // Gated exactly like onData above: output is hidden until live, so a paste then would be blind.
      // KNOWN LIMIT: one paste is one binary frame, so a clipboard larger than WS_MAX_PAYLOAD (64 KB,
      // config.ts) trips the server's ws maxPayload and closes the socket (1009) instead of degrading.
      // Pre-existing rather than introduced here — xterm's own paste path had the same single-frame
      // shape — and deliberately left as-is (owner call, 2026-07-17). The fix, if it ever earns its
      // keep, is to chunk INSIDE the bracketed block: the markers already make split delivery safe
      // (measured — a 3.4 KB paste reaches the pane as ~4 pty reads and the receiver reassembles it).
      if (live && ws.readyState === WebSocket.OPEN) ws.send(formatPaste(text));
    };
    el.addEventListener("paste", onPasteCapture, true);

    // Bridge for the drop handler to inject uploaded file paths over the same binary keystroke channel.
    // Guarded on `live` + OPEN like onData, so a drop during "starting…" or after close is a safe no-op.
    sendInputRef.current = (bytes: Uint8Array): void => {
      if (live && ws.readyState === WebSocket.OPEN) ws.send(bytes);
    };

    // Copy-on-select, herdr parity. User-gesture output→clipboard only — OSC 52 stays
    // inert (no clipboard addon, SEC-5). Non-empty guard: a selection *clear* fires the same event
    // and must not wipe the clipboard. localhost is a secure context, so navigator.clipboard exists;
    // a rejected write (focus lost mid-drag) is deliberately ignored.
    const selSub = term.onSelectionChange(() => {
      const s = term.getSelection();
      if (s.length > 0) void navigator.clipboard.writeText(s).catch(() => undefined);
    });

    const ro = new ResizeObserver(() => { sendResize(); });
    ro.observe(el);

    return () => {
      disposed = true;
      if (liveTimer !== undefined) clearTimeout(liveTimer);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      ro.disconnect();
      el.removeEventListener("paste", onPasteCapture, true);
      dataSub.dispose();
      selSub.dispose();
      // Closing the socket triggers the server-side SIGHUP→SIGKILL reap and releases herdr --takeover,
      // returning control to the operator's own terminal (a Task 0 verified property).
      ws.onclose = null;
      ws.close();
      term.dispose();
      termRef.current = null;
      liveRef.current = false;
      sendInputRef.current = null;
    };
  }, [env, paneId, attempt, awaitAgent]);

  // Upload each dropped file to the local env, then inject the returned path(s) into the pane. Gated on
  // `canAttachFiles` (local only) and a live session (so no orphan temp file is written for a drop that
  // can't be injected). Per-file requests: on a mid-batch failure we still inject whatever uploaded
  // successfully so far (those bytes are already on-host) and surface the error for the rest.
  async function handleDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault();
    setDragging(false);
    if (!canAttachFiles) { setDropError("file attach is available for local environments only"); return; }
    if (!liveRef.current) { setDropError("session is not live — try again"); return; }
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const tooBig = files.find((f) => f.size > UPLOAD_MAX_BYTES);
    if (tooBig !== undefined) { setDropError(`"${tooBig.name}" exceeds the 25 MB limit`); return; }
    setDropError(null);
    const paths: string[] = [];
    try {
      for (const f of files) paths.push(await uploadFile(env, f));
    } catch (err) {
      setDropError(err instanceof Error ? err.message : String(err));
    } finally {
      if (paths.length > 0) sendInputRef.current?.(formatDropInjection(paths));
    }
  }

  // Recolor an already-open terminal when the theme switches (no reconnect).
  useEffect(() => {
    if (termRef.current !== null) termRef.current.options.theme = TERM_THEME[resolved];
  }, [resolved]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="relative bg-card/75 backdrop-blur-md border border-border rounded-lg shadow-2xl w-[90vw] h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => { e.stopPropagation(); }}
        onDragEnter={(e) => { if (canAttachFiles && isFileDrag(e.dataTransfer.types)) { e.preventDefault(); setDragging(true); } }}
        onDragOver={(e) => { if (canAttachFiles && isFileDrag(e.dataTransfer.types)) e.preventDefault(); }}
        onDragLeave={(e) => { const rt = e.relatedTarget; if (!(rt instanceof Node) || !e.currentTarget.contains(rt)) setDragging(false); }}
        onDrop={(e) => { void handleDrop(e); }}
      >
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
          <span className="text-foreground text-sm font-semibold">{title !== "" ? title : paneId}</span>
          <span className="text-xs text-muted-foreground/70">{title !== "" ? `${paneId} · ${env}` : env}</span>
          {starting && (
            <span className="text-xs text-warning">· starting session…</span>
          )}
          {closeInfo !== null && !starting && (
            <span className="text-xs text-warning">· {closeMessage(closeInfo.code, closeInfo.reason)}</span>
          )}
          {dropError !== null && (
            <span className="text-xs text-warning">· {dropError}</span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-muted-foreground hover:text-foreground text-lg leading-none"
            title="Close (Esc)"
          >✕</button>
        </div>
        {(recap !== null && recap !== "") || statusline !== null ? (
          <div className="flex items-start gap-2 px-4 py-1.5 border-b border-border shrink-0 text-[11px]">
            {statusline !== null && (
              <span className={`shrink-0 font-mono tabular-nums text-muted-foreground ${isStale(statusline.captured_at) ? "opacity-50" : ""}`}>
                <MetricChips sl={statusline} />
              </span>
            )}
            {recap !== null && recap !== "" && (
              <span className="min-w-0 flex-1 truncate text-muted-foreground/80" title={recap}>
                {statusline !== null ? "· " : ""}{recap}
              </span>
            )}
          </div>
        ) : null}
        <div ref={containerRef} className="flex-1 min-h-0 p-2" />
        {dragging && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-none">
            <span className="text-foreground text-sm font-medium rounded-md border border-border bg-card/80 px-4 py-2">
              Drop files to attach
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
