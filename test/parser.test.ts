// test/parser.test.ts
import { describe, it, expect } from "vitest";

import { parsePane } from "../server/parser.ts";

const sessionBar = "─".repeat(33) + " my-session " + "─".repeat(33);

describe("parsePane", () => {
  it("extracts ctx percent and shortened model", () => {
    const p = parsePane("ctx ░░░░ 19% (190K) | Sonnet 1M");
    expect(p.ctxPct).toBe("19");
    expect(p.model).toBe("Sonnet 1M");
  });

  it("shortens an Opus model name", () => {
    const p = parsePane("ctx ████ 42% (400K) | Claude Opus 4.8");
    expect(p.model).toBe("Opus");
  });

  it("extracts the session name from the name bar", () => {
    expect(parsePane(sessionBar).sessionName).toBe("my-session");
  });

  it("returns nulls when neither bar is present", () => {
    expect(parsePane("just some\nplain output\n")).toEqual({ ctxPct: null, model: null, sessionName: null });
  });

  it("parses ctx and session name together", () => {
    const p = parsePane(`ctx ░░ 7% (70K) | Haiku\nwork\n${sessionBar}`);
    expect(p.ctxPct).toBe("7");
    expect(p.model).toBe("Haiku");
    expect(p.sessionName).toBe("my-session");
  });
});
