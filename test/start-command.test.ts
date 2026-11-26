import { presetLabel, START_COMMAND_MAX } from "@shared/board-schema";
import { describe, expect, it } from "vitest";

import { startCommandProblem } from "../web/src/lib/start-command";

describe("startCommandProblem", () => {
  it.each([
    ["", "needs text"],
    ["  \n ", "needs text"],
    ["-x", "must begin with"],
    ["Привет", "must begin with"],
    [`/${"x".repeat(START_COMMAND_MAX)}`, "limited to 3000"],
  ])("refuses %j", (text, message) => {
    expect(startCommandProblem(text)).toContain(message);
  });

  it("measures the trimmed text, as the server does", () => {
    expect(startCommandProblem(`  /${"x".repeat(START_COMMAND_MAX - 1)}\n`)).toBeNull();
    expect(startCommandProblem("  /plan")).toBeNull();
  });
});

describe("presetLabel", () => {
  it("uses the trimmed title", () => {
    expect(presetLabel({ id: "a", title: " Plan ", text: "/plan" })).toBe("Plan");
  });

  it("falls back to the first non-blank line of the text when the title is blank", () => {
    expect(presetLabel({ id: "a", title: "  ", text: "\n /fix\n\nbody" })).toBe("/fix");
  });
});
