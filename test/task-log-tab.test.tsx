// @vitest-environment jsdom
import type { Board, LogEntry } from "@shared/board-schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskLogTab } from "../web/src/components/TaskLogTab";
import { api } from "../web/src/lib/api";
import { readLogSeen } from "../web/src/lib/log-seen";

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); });

function entry(over: Partial<LogEntry> & { readonly id: string }): LogEntry {
  return { atMs: 1_000, source: { sessionId: null, name: "writer-a" }, kind: "note", text: "a note", ...over };
}

function boardWith(log: LogEntry[], taskId = "t1"): Board {
  return {
    id: "b1", label: "Board", columns: [{ id: "c1", label: "To do" }], spawnPresets: [], defaultSpawnPresetId: null,
    tasks: [{ id: taskId, title: "T", description: "", status: "c1", priority: null, sessions: [], log, createdAt: 0, updatedAt: 0 }],
  };
}

describe("TaskLogTab — the log comes from GET /api/boards/:bid, the one route that carries it", () => {
  it("fetches the board the card is on and renders that card's entries", async () => {
    const get = vi.spyOn(api.boards, "get").mockResolvedValue(boardWith([entry({ id: "e1", text: "decided X over Y" })]));
    render(<TaskLogTab boardId="b1" taskId="t1" />);
    await screen.findByText("decided X over Y");
    expect(get).toHaveBeenCalledWith("b1");
    expect(screen.getByText("writer-a")).toBeTruthy();
  });

  it("a card missing from the fetched board reads as an error, not as an empty log", async () => {
    vi.spyOn(api.boards, "get").mockResolvedValue(boardWith([], "someone-else"));
    render(<TaskLogTab boardId="b1" taskId="t1" />);
    await screen.findByText(/no longer on this board/);
    expect(screen.queryByText("Nothing written yet.")).toBeNull();
  });

  it("a failed fetch shows the failure instead of a blank panel", async () => {
    vi.spyOn(api.boards, "get").mockRejectedValue(new Error("Boards service unavailable"));
    render(<TaskLogTab boardId="b1" taskId="t1" />);
    await screen.findByText("Boards service unavailable");
  });

  it("an empty log says so", async () => {
    vi.spyOn(api.boards, "get").mockResolvedValue(boardWith([]));
    render(<TaskLogTab boardId="b1" taskId="t1" />);
    await screen.findByText("Nothing written yet.");
  });
});

describe("TaskLogTab — entry text is another session's and renders as text only", () => {
  it("markup inside an entry becomes characters on screen, never elements", async () => {
    const text = "<img src=x onerror=\"document.title='pwned'\"><b>bold</b>";
    vi.spyOn(api.boards, "get").mockResolvedValue(boardWith([entry({ id: "e1", text })]));
    const { container } = render(<TaskLogTab boardId="b1" taskId="t1" />);
    await screen.findByText(text);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(document.title).not.toBe("pwned");
  });

  it("a source name shaped like markup is text too", async () => {
    vi.spyOn(api.boards, "get").mockResolvedValue(boardWith([entry({ id: "e1", source: { sessionId: null, name: "<i>x</i>" } })]));
    const { container } = render(<TaskLogTab boardId="b1" taskId="t1" />);
    await screen.findByText("<i>x</i>");
    expect(container.querySelector("i")).toBeNull();
  });
});

describe("TaskLogTab — filter chips", () => {
  const log = [
    entry({ id: "n1", text: "a reasoned note" }),
    entry({ id: "s1", kind: "session_spawned", source: "corral", text: "worker-b on env-a" }),
  ];

  it("Notes hides the lifecycle and the headline counts the subset against the whole", async () => {
    vi.spyOn(api.boards, "get").mockResolvedValue(boardWith(log));
    render(<TaskLogTab boardId="b1" taskId="t1" />);
    await screen.findByText("worker-b on env-a");
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(screen.queryByText("worker-b on env-a")).toBeNull();
    expect(screen.getByText("a reasoned note")).toBeTruthy();
    expect(screen.getByText("1 of 2 entries")).toBeTruthy();
  });

  it("Lifecycle hides the notes and shows the kind beside corral's name", async () => {
    vi.spyOn(api.boards, "get").mockResolvedValue(boardWith(log));
    render(<TaskLogTab boardId="b1" taskId="t1" />);
    await screen.findByText("a reasoned note");
    fireEvent.click(screen.getByRole("button", { name: "Lifecycle" }));
    expect(screen.queryByText("a reasoned note")).toBeNull();
    expect(screen.getByText("session_spawned")).toBeTruthy();
    expect(screen.getByText("corral")).toBeTruthy();
  });

  it("a filter that matches nothing says so rather than showing an empty box", async () => {
    vi.spyOn(api.boards, "get").mockResolvedValue(boardWith([log[0] ?? entry({ id: "n1" })]));
    render(<TaskLogTab boardId="b1" taskId="t1" />);
    await screen.findByText("a reasoned note");
    fireEvent.click(screen.getByRole("button", { name: "Lifecycle" }));
    expect(screen.getByText("No lifecycle entries.")).toBeTruthy();
  });
});

describe("TaskLogTab — displaying the log is what marks it seen", () => {
  it("records the fetched log's size and newest timestamp under the card's key", async () => {
    vi.spyOn(api.boards, "get").mockResolvedValue(boardWith([
      entry({ id: "e1", atMs: 5_000 }), entry({ id: "e2", atMs: 9_000 }), entry({ id: "e3", atMs: 7_000 }),
    ]));
    render(<TaskLogTab boardId="b1" taskId="t1" />);
    await waitFor(() => { expect(readLogSeen("b1/t1")).toEqual({ count: 3, atMs: 9_000 }); });
  });

  it("a failed fetch marks nothing — the badge must keep saying new", async () => {
    vi.spyOn(api.boards, "get").mockRejectedValue(new Error("down"));
    render(<TaskLogTab boardId="b1" taskId="t1" />);
    await screen.findByText("down");
    expect(readLogSeen("b1/t1")).toBeUndefined();
  });
});
