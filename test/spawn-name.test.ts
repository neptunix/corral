import { describe, expect, it } from "vitest";

import { composeSessionName, NAME_MAX, sanitizeSlug, slugify } from "../server/spawn.ts";

const free = (): boolean => true;
const except = (taken: readonly string[]) => (n: string): boolean => !taken.includes(n);
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,55}$/;

describe("slugify", () => {
  it("lowercases, collapses runs of non-alphanumerics, trims both ends", () => {
    expect(slugify("  RC Toggle UI! ", 32)).toBe("rc-toggle-ui");
  });

  it('returns "" when nothing usable survives — callers read that as "not supplied"', () => {
    expect(slugify("***", 32)).toBe("");
    expect(slugify("", 32)).toBe("");
  });

  it("truncates to max and re-trims a dash left at the cut", () => {
    expect(slugify("aaaa-bbbb", 5)).toBe("aaaa");
  });
});

// sanitizeSlug is the idempotent-rejoin key for cards that ALREADY EXIST. An earlier revision
// truncated it to 24, which silently changed the slug for every card title over 32 characters.
describe("sanitizeSlug — unchanged", () => {
  it("still truncates at 32, not lower", () => {
    expect(sanitizeSlug("a".repeat(40))).toBe("a".repeat(32));
  });

  it('still falls back to "task" for unusable input', () => {
    expect(sanitizeSlug("***")).toBe("task");
  });
});

describe("composeSessionName", () => {
  it("joins the card slug and the requested name", () => {
    expect(composeSessionName("my-task", "RC toggle UI", free)).toBe("my-task-rc-toggle-ui");
  });

  it("falls back to <slug>-<first free letter> when the name is absent or unusable", () => {
    expect(composeSessionName("my-task", "", free)).toBe("my-task-a");
    expect(composeSessionName("my-task", "***", free)).toBe("my-task-a");
  });

  it("takes the next free letter when earlier ones are on the card", () => {
    expect(composeSessionName("my-task", "", except(["my-task-a", "my-task-b"]))).toBe("my-task-c");
  });

  it("appends a letter when the composed name is already on the card", () => {
    expect(composeSessionName("my-task", "rc toggle", except(["my-task-rc-toggle"])))
      .toBe("my-task-rc-toggle-a");
  });

  it("never emits more than NAME_MAX characters", () => {
    const out = composeSessionName("a".repeat(32), "b".repeat(32), free) ?? "";
    expect(out.length).toBeLessThanOrEqual(NAME_MAX);
  });

  // THE invariant two spec revisions got backwards: the string tested for freeness must be the
  // string returned. Truncation happens BEFORE the test, so a taken TRUNCATED name is rejected.
  it("tests the truncated string for freeness, not the untruncated one", () => {
    const slug = "a".repeat(32);
    const requested = "b".repeat(32);
    const first = composeSessionName(slug, requested, free) ?? "";
    expect(first.length).toBe(NAME_MAX); // it really was truncated
    const second = composeSessionName(slug, requested, except([first]));
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  // Pre-trimming the base by 2 is what stops truncation from eating the letter that disambiguates.
  it("keeps the disambiguating letter when the joined name is already at the cap", () => {
    const slug = "a".repeat(32);
    const requested = "b".repeat(32);
    const first = composeSessionName(slug, requested, free) ?? "";
    const second = composeSessionName(slug, requested, except([first])) ?? "";
    expect(second.length).toBeLessThanOrEqual(NAME_MAX);
    expect(second.endsWith("-a")).toBe(true);
  });

  it("returns null when nothing is both free and valid, so the route can 409", () => {
    expect(composeSessionName("my-task", "rc toggle", () => false)).toBeNull();
  });

  it("every emitted name matches the launch-flag charset", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["my-task", "rc toggle"], ["my-task", ""], ["a".repeat(32), "b".repeat(32)], ["task", "!!!"],
    ];
    for (const [slug, requested] of cases) {
      const out = composeSessionName(slug, requested, free);
      expect(out).not.toBeNull();
      expect(NAME_RE.test(out ?? "")).toBe(true);
    }
  });
});
