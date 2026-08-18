import type { RecapSource, RecapStatus, RegistryStatus, StatuslineData } from "@shared/schema";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState, type JSX } from "react";

import { SessionMeta } from "./SessionMeta";
import { useTheme } from "./ThemeProvider";
import {
  ATTACH_LIVE_AFTER_MS, ATTACH_RETRY_DELAY_MS, jitter, RECONNECT_BASE_MS, RECONNECT_COLD_ATTEMPTS,
  RECONNECT_LIMIT_DELAY_MS, RECONNECT_MAX_MS, reconnectNominalMs, RECONNECT_STABLE_MS,
  RESUME_PROBE_MS, type ResumeTrigger, resumeAction, shouldReconnectAfterClose, shouldRetryAttach,
} from "../lib/attach";
import { formatDropInjection, formatPaste } from "../lib/paste";
import { closeMessage } from "../lib/protocol";
import { sessionStateLabel } from "../lib/session-state";
import { readTerminalPrefs } from "../lib/terminal-prefs";
import { attachCommittedTextInput } from "../lib/text-input";
import { attachTouchScroll } from "../lib/touch-scroll";
import { isFileDrag, uploadFile, UPLOAD_MAX_BYTES } from "../lib/upload";
import { attachWheelGain } from "../lib/wheel-gain";

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
  // Operator-facing display name for `env`; routing still uses `env`. Falls back to the id upstream.
  readonly envLabel: string;
  readonly paneId: string;
  readonly awaitAgent?: boolean;
  // Bound task's title, shown as the header's primary label; "" (unassigned opens) falls back to paneId.
  readonly title?: string;
  // herdr workspace label (≈ the repo). Shown in the header between the env and the session name; "" hides it.
  readonly workspace?: string;
  readonly recap?: string | null;
  // Health of the recap read and which rung of the ladder produced `recap`. Without the pair an empty
  // recap line is indistinguishable from a broken one — which is how the dead away_summary source hid
  // for a month (docs/adr/0005).
  readonly recapStatus?: RecapStatus | null;
  readonly recapSource?: RecapSource | null;
  readonly statusline?: StatuslineData | null;
  // Enables drop-to-attach (upload + path injection). True for local envs only; remote needs SSH
  // byte transfer (v2), so the drop affordance is hidden there (the server also refuses remote uploads).
  readonly canAttachFiles?: boolean;
  // Required, not optional: SessionStateFields declares these non-undefined, and under
  // exactOptionalPropertyTypes a `?:` prop widens to `| undefined` and no longer satisfies it.
  // App.tsx already defaults every one of them at the call site, so this costs nothing there.
  readonly status: string;
  readonly claudeStatus: string | null;
  readonly waitingFor: string | null;
  readonly remoteControl: boolean | null;
  readonly registryStatus: RegistryStatus | null;
  readonly onClose: () => void;
}

export function SessionModal({
  env, envLabel, paneId, awaitAgent = false, title = "", workspace = "", recap = null,
  recapStatus = null, recapSource = null, statusline = null,
  canAttachFiles = false, status, claudeStatus, waitingFor, remoteControl, registryStatus, onClose,
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The hairline around the terminal. Sized from the terminal's own box rather than from the space it
  // was given — see the render for why those are never the same thing.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [closeInfo, setCloseInfo] = useState<{ code: number; reason: string } | null>(null);
  // Monotonic effect key. Bumping it re-runs the terminal effect, which is how both the boot-race
  // retry and a reconnect open a new socket. NEVER reset — resetting is also a bump, so it would
  // tear down the very socket that just succeeded.
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(awaitAgent);
  const startedAtRef = useRef(0);
  // Recovery state, all of it deliberately outside the effect so it survives the re-run that a
  // reconnect IS.
  const [reconnectInfo, setReconnectInfo] = useState<{ attempts: number; reason: string } | null>(null);
  const backoffRef = useRef(0); // exponent for the next delay; safe to reset, unlike `attempt`
  const everOpenRef = useRef(false); // a handshake completed at least once — see the cold-start gate
  const everLiveRef = useRef(false); // output has flowed once, so a reconnect must not re-buffer
  const lastAttemptAtRef = useRef(0); // floor between attach attempts, whichever trigger fired
  const closeCodeRef = useRef<number | null>(null); // the verdict a resume must respect
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
      // scrollSensitivity is deliberately left at its default: it saturates at one wheel report per
      // event, a ceiling a trackpad or a finger already reaches (see wheel-gain.ts). The operator's
      // setting is applied by attachWheelGain below instead.
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
    lastAttemptAtRef.current = Date.now();
    closeCodeRef.current = null;
    // When awaiting the agent, hold output until the connection proves live so a fast-fail (4001)
    // attempt's herdr error blob is discarded, not flashed. A normal (non-await) attach writes at once.
    // `everLiveRef` exempts a RECONNECT: output has already flowed, so re-buffering it (and dropping
    // keystrokes for ATTACH_LIVE_AFTER_MS) on a session the operator has been using is just a stall.
    let live = !awaitAgent || everLiveRef.current;
    liveRef.current = live;
    const buffered: (string | Uint8Array)[] = [];
    let liveTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    // Single-flight. `visibilitychange`, `pageshow` and an `onclose` can all land in the same tick,
    // and until the bump re-runs this effect the listeners below are still registered — so without
    // this a bfcache restore opens two attaches against one pane, which then fight for herdr's
    // takeover lock. Effect-local is the right scope: the next run genuinely starts fresh.
    let pending: "none" | "backoff" | "resume" | "probe" = "none";

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
      everLiveRef.current = true;
      setStarting(false);
      for (const d of buffered) term.write(d);
      buffered.length = 0;
    }

    /**
     * Arm the next attach. `delayMs` is what the caller wants; the floor is what pacing demands —
     * no two attempts within RECONNECT_BASE_MS of each other, whichever trigger fired. A zero
     * effective delay bumps synchronously rather than through a pointless macrotask.
     */
    function scheduleReconnect(delayMs: number, kind: "backoff" | "resume", reason: string): void {
      if (pending !== "none") return;
      pending = kind;
      setCloseInfo(null);
      setReconnectInfo({ attempts: backoffRef.current, reason });
      const wait = Math.max(delayMs, lastAttemptAtRef.current + RECONNECT_BASE_MS - Date.now());
      if (wait <= 0) {
        setAttempt((a) => a + 1);
        return;
      }
      reconnectTimer = setTimeout(() => { setAttempt((a) => a + 1); }, wait);
    }

    ws.onopen = () => {
      setReconnectInfo(null);
      sendResize();
      // Completing a handshake is not the same as having a connection. The limiter accepts the
      // upgrade and only then closes 1013, and a flapping server accepts every attach and drops it
      // — treating either as success would clear the backoff and switch on the unlimited retry for
      // a link that never worked. Surviving RECONNECT_STABLE_MS is the proof.
      stableTimer = setTimeout(() => {
        everOpenRef.current = true;
        backoffRef.current = 0;
      }, RECONNECT_STABLE_MS);
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
      if (stableTimer !== undefined) clearTimeout(stableTimer); // died before it counted as working
      // Recorded BEFORE the boot-race branch, so a tab switch during that 1.2 s wait sees a 4001 and
      // leaves it alone instead of collapsing the retry to the attempt floor.
      closeCodeRef.current = e.code;
      // Boot race: retry a not-yet-live post-spawn attach (4001) until Claude registers or the window
      // elapses — the buffered error blob is dropped so the user only ever sees "starting…" then Claude.
      // `starting` is already true across the whole retry loop (init from awaitAgent, cleared only by
      // goLive/real-failure), so no setStarting here.
      if (shouldRetryAttach({ code: e.code, live, awaitAgent, elapsedMs: Date.now() - startedAtRef.current })) {
        retryTimer = setTimeout(() => { setAttempt((a) => a + 1); }, ATTACH_RETRY_DELAY_MS);
        return;
      }
      // The transport died — re-attach. Gated on having connected once, because a REJECTED UPGRADE
      // (bad origin, unknown env, malformed pane: rejectUpgrade in server/ws-attach.ts) never
      // becomes a WebSocket and so also reports 1006. Retrying that forever would bury a permanent
      // misconfiguration under a spinner; a socket that did connect is a corral restart or a frozen
      // phone, and those come back.
      if (shouldReconnectAfterClose(e.code)
        && (everOpenRef.current || backoffRef.current < RECONNECT_COLD_ATTEMPTS)) {
        // 1013 waits out the limiter rather than the backoff curve: the delay is sized to outlast
        // the server's reap of whatever is holding the slots.
        const nominal = e.code === 1013 ? RECONNECT_LIMIT_DELAY_MS : reconnectNominalMs(backoffRef.current);
        backoffRef.current += 1;
        scheduleReconnect(jitter(nominal, Math.random()), "backoff", closeMessage(e.code, e.reason));
        return;
      }
      if (!live) { for (const d of buffered) term.write(d); buffered.length = 0; } // real failure → show what came
      setStarting(false);
      setReconnectInfo(null);
      setCloseInfo({ code: e.code, reason: e.reason });
    };

    /**
     * The tab came back. `resumeAction` decides; this wires the decision up.
     *
     * A resume arriving mid-backoff cancels the wait instead of being swallowed by single-flight —
     * otherwise a phone picked up 5 s into a 30 s delay would sit out the other 25 for nothing.
     */
    function onResume(trigger: ResumeTrigger, persisted: boolean): void {
      if (disposed) return;
      const decision = resumeAction({
        trigger, persisted, readyState: ws.readyState, closeCode: closeCodeRef.current,
      });
      if (decision === "none") return;
      if (decision === "reconnect") {
        if (pending === "resume") return;
        if (pending === "backoff" || pending === "probe") {
          clearTimeout(reconnectTimer);
          clearTimeout(probeTimer);
          pending = "none";
        }
        backoffRef.current = 0;
        scheduleReconnect(0, "resume", "connection closed");
        return;
      }
      if (pending !== "none") return;
      pending = "probe";
      // Poke the socket: WebKit updates a stale readyState on send, so this is what makes a dead
      // connection admit it. Folklore from bug reports rather than specified behaviour: if a device
      // ever shows it is not enough, the accurate replacement is an application-level ping/pong over
      // the existing text-control channel, which costs a protocol change on both sides.
      sendResize();
      probeTimer = setTimeout(() => {
        pending = "none";
        if (disposed) return;
        // Ask the same question again rather than just re-reading readyState: a close can land
        // INSIDE the probe window, and its code decides. A 1009 paste or a 1000 exit arriving here
        // would otherwise be re-attached — and the setCloseInfo(null) below would wipe the reason
        // the operator needs, or cancel the auto-dismiss that a clean exit had already armed.
        if (resumeAction({
          trigger: "visible", persisted: false, readyState: ws.readyState, closeCode: closeCodeRef.current,
        }) !== "reconnect") return;
        backoffRef.current = 0;
        scheduleReconnect(0, "resume", "connection closed");
      }, RESUME_PROBE_MS);
    }

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") onResume("visible", false);
    };
    // `persisted` says Safari restored this page from bfcache — where it force-closed the socket on
    // the way in, so the answer needs no probing.
    const onPageShow = (e: PageTransitionEvent): void => { onResume("pageshow", e.persisted); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);

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

    // IM-routed keystrokes (ibus/fcitx → keydown "Process"/229) never reach term.onData — see
    // lib/text-input.ts. Same live/OPEN gate, plus the scroll-to-bottom triggerDataEvent would have done.
    const helperTextarea = term.textarea;
    const detachTextInput = helperTextarea === undefined
      ? () => undefined
      : attachCommittedTextInput(helperTextarea, (text) => {
        if (!live || ws.readyState !== WebSocket.OPEN) return;
        ws.send(new TextEncoder().encode(text));
        if (term.options.scrollOnUserInput === true) term.scrollToBottom();
      });

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
    // A second observer, on the TERMINAL rather than on the box holding it, and it sets the HEIGHT
    // only. xterm rounds down to whole rows, so its box is up to one row shorter than the space it
    // was given, by a different amount at every window size; following it is what keeps the hairline
    // on the last row instead of a ragged distance below it. Observing the element (rather than
    // measuring after fit) also sidesteps the question of when xterm's relayout lands.
    //
    // The width is NOT tracked, because it cannot be: `.xterm` is a plain block element that xterm
    // never sizes (only `.xterm-screen` inside it carries cols × cell width), so it is always exactly
    // as wide as this container. The hairline's left and right edges are therefore the container's,
    // and there is a slice of non-output between the last column and the right edge — wider than one
    // cell, since the fit addon also reserves room for an overview ruler.
    const xtermEl = el.querySelector(".xterm");
    const frameObserver = new ResizeObserver(() => {
      const frame = frameRef.current;
      if (frame === null || !(xtermEl instanceof HTMLElement)) return;
      frame.style.height = `${String(Math.round(xtermEl.getBoundingClientRect().height))}px`;
    });
    if (xtermEl !== null) frameObserver.observe(xtermEl);
    // Without this the pane cannot be scrolled at all on a phone — why, in lib/touch-scroll.ts.
    const detachTouchScroll = attachTouchScroll(el);
    // The operator's scroll speed. Read once rather than watched: the gear lives in the app header,
    // which this modal covers, so the value cannot change while a terminal is on screen. Attached AFTER
    // the touch shim, but order does not matter — this listener is in the capture phase.
    const detachWheelGain = attachWheelGain(el, readTerminalPrefs().scrollSpeed);

    return () => {
      disposed = true;
      if (liveTimer !== undefined) clearTimeout(liveTimer);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (probeTimer !== undefined) clearTimeout(probeTimer);
      if (stableTimer !== undefined) clearTimeout(stableTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      ro.disconnect();
      frameObserver.disconnect();
      detachTouchScroll();
      detachWheelGain();
      el.removeEventListener("paste", onPasteCapture, true);
      detachTextInput();
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

  // The scrim only exists where the panel does not already cover the screen. Below `sm` it does cover
  // it, so the scrim's one remaining effect was to darken the board showing THROUGH the panel —
  // muting the header without dimming anything the operator can actually see.
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 sm:bg-black/60" onClick={onClose}>
      <div
        // dvh, not vh: on iOS `vh` is the LARGE viewport (toolbars hidden), so with the Safari toolbars
        // shown a 90vh panel overflows the visible area — and `fixed inset-0` means it cannot be
        // scrolled to. The terminal is the flex child that absorbs the difference.
        //
        // Below `sm` the panel takes the whole screen — no inset, no radius, no side border. A 90%
        // panel on a phone spends a tenth of the shortest dimension there is on showing a board the
        // terminal is covering anyway, and the terminal is the only thing on this screen worth space.
        // Frosted only from `sm` up, and opaque below it. A translucent full-screen panel reveals
        // nothing — the board it would show through is entirely behind it — so on a phone the effect
        // costs a per-frame backdrop blur, which Safari charges for on every scroll, and returns a
        // muted header. On a desktop the panel is a window over the board, which is the whole point.
        className="relative bg-card border-border shadow-2xl w-screen h-[100dvh] flex flex-col overflow-hidden sm:bg-card/85 sm:backdrop-blur-md sm:w-[90vw] sm:h-[90dvh] sm:rounded-lg sm:border"
        onClick={(e) => { e.stopPropagation(); }}
        onDragEnter={(e) => { if (canAttachFiles && isFileDrag(e.dataTransfer.types)) { e.preventDefault(); setDragging(true); } }}
        onDragOver={(e) => { if (canAttachFiles && isFileDrag(e.dataTransfer.types)) e.preventDefault(); }}
        onDragLeave={(e) => { const rt = e.relatedTarget; if (!(rt instanceof Node) || !e.currentTarget.contains(rt)) setDragging(false); }}
        onDrop={(e) => { void handleDrop(e); }}
      >
        {/* Which fields survive a phone: the ones that say WHAT this session is and whether it needs
            you. The address (pane, env), the workspace and the session name are all recoverable from
            the card you opened this from, so below `sm` they give way — unwrapped, they took three
            lines of a 390px screen before the terminal even started. */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 sm:px-4">
          <span className="text-foreground text-sm font-semibold truncate">{title !== "" ? title : paneId}</span>
          <span className="hidden shrink-0 text-xs text-muted-foreground/70 sm:inline">{title !== "" ? `${paneId} · ${envLabel}` : envLabel}</span>
          {/* Every text child of this row must be able to give way, and the ✕ must not. The row does
              not wrap and the panel clips it, so one child that refuses to shrink pushes whatever
              follows past the edge — and below `sm` the panel covers the backdrop, so tapping outside
              no longer closes and a phone has no Esc: the ✕ is the only way out. Both the state
              (which carries a free-form `waitingFor`) and the close/drop messages (whose text comes
              from the server) are unbounded, so both truncate rather than shove. */}
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            title={sessionStateLabel({ status, claudeStatus, waitingFor, registryStatus })}
          >
            · {sessionStateLabel({ status, claudeStatus, waitingFor, registryStatus })}
          </span>
          {workspace !== "" && (
            <span className="hidden text-xs text-muted-foreground/60 truncate sm:inline" title={workspace}>· {workspace}</span>
          )}
          {statusline?.session_name !== null && statusline?.session_name !== undefined && statusline.session_name !== "" && (
            <span className="hidden text-xs text-muted-foreground/60 truncate sm:inline" title={statusline.session_name}>· {statusline.session_name}</span>
          )}
          {starting && reconnectInfo === null && (
            <span className="min-w-0 truncate text-xs text-warning">· starting session…</span>
          )}
          {/* Recovery is automatic, so this row is the whole of its surface — no button, nothing to
              press. It still has to SAY something: a terminal sitting out a backoff and a hung one
              look identical otherwise. Once the delay has reached its cap the bare word stops being
              enough — a corral that is merely down and a permanent 403 both spin forever — so the
              attempt count and the close reason join it.

              Precedence in this one-line row: reconnecting > starting > closed. Reconnecting wins
              over "starting session…" because an awaitAgent session whose transport dies before
              output ever flowed keeps `starting` true for the whole outage — ranking it first left
              the recovery, its attempt count and its reason invisible for exactly as long as they
              mattered. */}
          {reconnectInfo !== null && (
            <span className="min-w-0 truncate text-xs text-warning">
              · {reconnectNominalMs(reconnectInfo.attempts) < RECONNECT_MAX_MS
                ? "reconnecting…"
                : `reconnecting… (attempt ${String(reconnectInfo.attempts)}, ${reconnectInfo.reason})`}
            </span>
          )}
          {closeInfo !== null && !starting && reconnectInfo === null && (
            <span className="min-w-0 truncate text-xs text-warning" title={closeMessage(closeInfo.code, closeInfo.reason)}>
              · {closeMessage(closeInfo.code, closeInfo.reason)}
            </span>
          )}
          {dropError !== null && (
            <span className="min-w-0 truncate text-xs text-warning" title={dropError}>· {dropError}</span>
          )}
          {/* `true` only. `false` and `null` both render nothing, and that is deliberate even though
              they look identical here: `null` means corral has no record and cannot say, `false` is a
              positive "not connected". Do NOT collapse them with a nullish default.
              Read-only — Remote Control is turned on at launch and corral never changes it. */}
          {/* Grouped so the right edge holds regardless of which of these render: `ml-auto` used to
              live on whichever element happened to come first, which breaks the moment one of them is
              conditional on the viewport as well as on the data. */}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {remoteControl === true && (
              <span
                className="hidden text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-border text-muted-foreground sm:inline"
                title="Remote Control is connected — this session is reachable from claude.ai"
              >remote</span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground text-lg leading-none"
              title="Close (Esc)"
            >✕</button>
          </span>
        </div>
        <SessionMeta statusline={statusline} recap={recap} recapStatus={recapStatus} recapSource={recapSource} />
        {/* A hairline sitting directly on the terminal, in the same tone as the recap badge above it:
            xterm's background carries alpha (TERM_THEME), so on the frosted panel its edge is
            otherwise indistinguishable from the panel. No fill and no padding inside it — both could
            only be panel colour, which is a light frame around a dark terminal whenever the pane's
            own Claude theme disagrees with corral's, and corral cannot know that theme's background:
            it only flips the `base` field of the theme file, and the colours live inside Claude Code.

            The line is an OVERLAY whose height comes from the terminal's own box (set in the effect
            above), rather than a border on the box holding it. The two differ by up to one row,
            because xterm rounds down to whole rows while its container resizes continuously — a
            border on the container would sit a ragged, window-size-dependent distance below the
            output. Here that leftover ends up outside the line, where it reads as panel margin.
            Horizontally the line is the container's own width; see the effect for why nothing else
            is available to measure.

            The inset is deliberately tiny on a phone: every pixel of frame there is a pixel not spent
            on output. */}
        <div className="relative flex-1 min-h-0 m-0.5 sm:m-1">
          <div ref={containerRef} className="absolute inset-0 overflow-hidden" />
          <div
            ref={frameRef}
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 rounded border border-muted-foreground/30"
          />
        </div>
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
