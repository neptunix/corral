// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionModal } from "../web/src/components/SessionModal";
import { ThemeProvider } from "../web/src/components/ThemeProvider";
import { ATTACH_RETRY_DELAY_MS, RECONNECT_BASE_MS, RESUME_PROBE_MS } from "../web/src/lib/attach";

// xterm needs a real canvas/DOM measurement pass that jsdom cannot give it, and none of it matters
// here: every assertion below is about SOCKETS, not about what was painted. The mock is the smallest
// surface SessionModal's effect touches.
vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80;
    rows = 24;
    // `undefined` is a real production case (xterm exposes the helper textarea lazily) and takes the
    // no-op branch of attachCommittedTextInput, keeping this mock small.
    textarea = undefined;
    options = {};
    loadAddon(): void { /* fit addon */ }
    open(): void { /* no DOM to build */ }
    focus(): void { /* kept on every run: outside a user gesture it cannot raise the iOS keyboard */ }
    write(): void { /* output is not asserted here */ }
    dispose(): void { /* nothing to release */ }
    getSelection(): string { return ""; }
    scrollToBottom(): void { /* not reached without a textarea */ }
    onData(): { dispose: () => void } { return { dispose: () => undefined }; }
    onSelectionChange(): { dispose: () => void } { return { dispose: () => undefined }; }
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({
  // jsdom gives the container no layout, so `proposeDimensions()` returns undefined here exactly as
  // it would in a real browser before the panel has been measured.
  FitAddon: class {
    fit(): void { /* no layout in jsdom */ }
    proposeDimensions(): undefined { return undefined; }
  },
}));

interface CloseFrame { readonly code: number; readonly reason: string }

/**
 * A WebSocket that never touches the network. Tests drive it by hand: `open()` completes the
 * handshake, `serverClose(code)` is the server hanging up, and assigning `readyState` directly is
 * the iOS case this whole feature exists for — a socket the OS killed while the tab was frozen,
 * which never delivered an `onclose`.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static sockets: FakeWebSocket[] = [];

  readyState = 0;
  binaryType = "";
  sent: (string | ArrayBufferLike)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseFrame) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.sockets.push(this);
  }

  send(data: string | ArrayBufferLike): void { this.sent.push(data); }
  close(): void { this.readyState = FakeWebSocket.CLOSED; }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason: "" });
  }
}

let visibility: DocumentVisibilityState = "visible";

function setVisible(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

function firePageshow(persisted: boolean): void {
  const e = new Event("pageshow");
  Object.defineProperty(e, "persisted", { value: persisted });
  window.dispatchEvent(e);
}

function renderModal(awaitAgent = false): void {
  render(
    <ThemeProvider>
      <SessionModal
        env="work-local"
        envLabel="work-local"
        paneId="w1:p1"
        awaitAgent={awaitAgent}
        status="idle"
        claudeStatus={null}
        waitingFor={null}
        remoteControl={null}
        registryStatus={null}
        onClose={() => undefined}
      />
    </ThemeProvider>,
  );
}

/** Let the socket finish its handshake, which is what arms the indefinite-retry path (`everOpen`). */
function openFirstSocket(): FakeWebSocket {
  const ws = FakeWebSocket.sockets[0];
  if (ws === undefined) throw new Error("no socket was created");
  act(() => { ws.open(); });
  return ws;
}

/** Clear the minimum spacing between attach attempts so a resume in the test is not throttled. */
function passTheAttemptFloor(): void {
  act(() => { vi.advanceTimersByTime(RECONNECT_BASE_MS * 2); });
}

beforeEach(() => {
  FakeWebSocket.sockets = [];
  visibility = "visible";
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", class {
    observe(): void { /* layout is not under test */ }
    disconnect(): void { /* nothing observed */ }
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("SessionModal reconnect", () => {
  it("re-attaches after the server reaps a half-open socket", () => {
    renderModal();
    const ws = openFirstSocket();

    // 1006 is what a browser reports when the server calls terminate() — the heartbeat reap.
    act(() => { ws.serverClose(1006); });
    expect(FakeWebSocket.sockets).toHaveLength(1); // still inside the backoff delay

    act(() => { vi.advanceTimersByTime(RECONNECT_BASE_MS); });
    expect(FakeWebSocket.sockets).toHaveLength(2);
  });

  it("does not re-attach when the session ended on its own", () => {
    renderModal();
    const ws = openFirstSocket();

    // 1000 is minted in exactly one place: pty-bridge's "pty exited". Retrying would resurrect a
    // session the operator's Claude just finished.
    act(() => { ws.serverClose(1000); });
    act(() => { vi.advanceTimersByTime(60_000); });

    expect(FakeWebSocket.sockets).toHaveLength(1);
  });

  it("re-attaches when the tab comes back to a socket that died in silence", () => {
    renderModal();
    const ws = openFirstSocket();
    passTheAttemptFloor();

    // The iOS shape: the process was suspended, the OS tore the connection down, and no close event
    // was ever delivered. Only the state gives it away.
    ws.readyState = FakeWebSocket.CLOSED;
    act(() => { setVisible("hidden"); });
    act(() => { setVisible("visible"); });

    expect(FakeWebSocket.sockets).toHaveLength(2);
  });

  it("re-attaches once when several resume signals arrive together", () => {
    renderModal();
    const ws = openFirstSocket();
    passTheAttemptFloor();
    ws.readyState = FakeWebSocket.CLOSED;

    // A bfcache restore fires both, in the same tick. Without single-flight this opens two attaches
    // against one pane — and the second would fight the first for herdr's takeover lock.
    act(() => {
      setVisible("visible");
      firePageshow(true);
    });
    act(() => { vi.advanceTimersByTime(RESUME_PROBE_MS + RECONNECT_BASE_MS); });

    expect(FakeWebSocket.sockets).toHaveLength(2);
  });

  it("leaves a genuinely live socket alone when the tab comes back", () => {
    renderModal();
    openFirstSocket();
    passTheAttemptFloor();

    // Desktop: the process was never suspended and the socket really is fine. Tearing it down would
    // cost the operator their scrollback on every tab switch.
    act(() => { setVisible("visible"); });
    act(() => { vi.advanceTimersByTime(RESUME_PROBE_MS * 2); });

    expect(FakeWebSocket.sockets).toHaveLength(1);
  });

  it("re-attaches when the probe reveals the socket was lying about being open", () => {
    renderModal();
    const ws = openFirstSocket();
    passTheAttemptFloor();

    act(() => { setVisible("visible"); }); // readyState still OPEN → probe
    ws.readyState = FakeWebSocket.CLOSED; // the poke made WebKit notice
    act(() => { vi.advanceTimersByTime(RESUME_PROBE_MS); });

    expect(FakeWebSocket.sockets).toHaveLength(2);
  });

  it("does not resurrect a session that ended while the probe was in flight", () => {
    renderModal();
    const ws = openFirstSocket();
    passTheAttemptFloor();

    act(() => { setVisible("visible"); }); // readyState OPEN → probe armed
    // The close lands INSIDE the probe window. It is 1009: an over-size paste, which a retry would
    // repeat byte for byte. The probe must respect that verdict, not just notice the socket is gone.
    act(() => { ws.serverClose(1009); });
    act(() => { vi.advanceTimersByTime(RESUME_PROBE_MS * 2); });

    expect(FakeWebSocket.sockets).toHaveLength(1);
    expect(screen.getByTitle(/payload|connection closed/i)).toBeTruthy(); // the reason survives
  });

  it("backs off when the server accepts the handshake and drops it immediately", () => {
    renderModal();

    // A flapping server: every attach completes its handshake and dies. Resetting the backoff on
    // `open` alone would hold the retry at the 500 ms floor forever, and each attempt forks a pty
    // server-side.
    for (let i = 0; i < 3; i++) {
      const ws = FakeWebSocket.sockets.at(-1);
      if (ws === undefined) throw new Error("no socket was created");
      act(() => { ws.open(); });
      act(() => { ws.serverClose(1006); });
      act(() => { vi.advanceTimersByTime(60_000); }); // long enough for whatever the delay has become
    }
    const afterThree = FakeWebSocket.sockets.length;

    // By now the curve has outgrown the floor, so one base delay must NOT be enough to try again.
    // Reset the exponent on `open` alone and this fires immediately, every time, forever.
    const ws = FakeWebSocket.sockets.at(-1);
    if (ws === undefined) throw new Error("no socket was created");
    act(() => { ws.open(); });
    act(() => { ws.serverClose(1006); });
    act(() => { vi.advanceTimersByTime(RECONNECT_BASE_MS); });

    expect(FakeWebSocket.sockets.length).toBe(afterThree);
  });

  it("treats an attach-limit rejection as a failed attach, not as a working connection", () => {
    renderModal();

    // The server accepts the upgrade and THEN closes 1013 (ws-attach.ts handleUpgrade → close), so
    // the browser sees open-then-close. Counting that as "we connected once" would switch on the
    // unlimited retry and hide the limit behind a spinner that never escalates.
    for (let i = 0; i < 20; i++) {
      const ws = FakeWebSocket.sockets.at(-1);
      if (ws === undefined) throw new Error("no socket was created");
      act(() => { ws.open(); });
      act(() => { ws.serverClose(1013); });
      act(() => { vi.advanceTimersByTime(120_000); });
    }

    expect(FakeWebSocket.sockets.length).toBeLessThanOrEqual(7);
  });

  it("says it is reconnecting even when the session never finished starting", () => {
    renderModal(true);
    const ws = openFirstSocket();

    // awaitAgent holds `starting` until output proves live. A drop before that must not leave the
    // header stuck on "starting session…" with the recovery invisible.
    act(() => { ws.serverClose(1006); });

    expect(screen.getByText(/reconnecting/)).toBeTruthy();
  });

  it("lets the post-spawn boot race finish its own wait instead of racing it", () => {
    renderModal(true);
    const ws = FakeWebSocket.sockets[0];
    if (ws === undefined) throw new Error("no socket was created");
    act(() => { ws.open(); });

    // 4001 = Claude has not registered as a herdr agent yet. shouldRetryAttach owns this, on its own
    // 1.2 s cadence; a tab switch during the wait must not collapse it to the 500 ms floor.
    act(() => { ws.serverClose(4001); });
    act(() => { vi.advanceTimersByTime(ATTACH_RETRY_DELAY_MS / 2); });
    act(() => { setVisible("visible"); });

    expect(FakeWebSocket.sockets).toHaveLength(1);
  });

  it("gives up on a handshake that never once succeeded, so a misconfiguration is not hidden", () => {
    renderModal();

    // A rejected upgrade (bad origin, unknown env) never becomes a WebSocket, so it reports 1006
    // exactly like transport death. Retrying forever would replace today's error banner with a
    // spinner that never resolves.
    for (let i = 0; i < 20; i++) {
      const ws = FakeWebSocket.sockets.at(-1);
      if (ws === undefined) throw new Error("no socket was created");
      act(() => { ws.serverClose(1006); });
      act(() => { vi.advanceTimersByTime(60_000); });
    }

    expect(FakeWebSocket.sockets.length).toBeLessThanOrEqual(7); // 1 initial + RECONNECT_COLD_ATTEMPTS
  });
});
