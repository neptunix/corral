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

  // Asserts the EXACT string, not `length <= NAME_MAX`. The bound is enforced twice over (the slice
  // and NAME_RE's {0,55}), so a length assertion survives every single mutation to the truncation
  // machinery and moves its own goalpost when NAME_MAX changes. Pinning where the cut lands is the
  // only assertion that fails when truncation breaks.
  it("cuts the composed name to exactly NAME_MAX characters", () => {
    const out = composeSessionName("a".repeat(32), "b".repeat(32), free);
    expect(out).toBe(`${"a".repeat(32)}-${"b".repeat(23)}`); // 32 + 1 + 23 = 56 = NAME_MAX
    expect(out).toHaveLength(NAME_MAX);
  });

  // The primary candidate is re-trimmed after the slice, so a cut landing on a dash cannot emit a
  // trailing-dash name as `--name` / `--remote-control` / the tab label. NAME_RE permits a trailing
  // dash, so nothing else in the file would catch losing that re-trim.
  it("re-trims a dash the truncation cut lands on", () => {
    // joined is 32×a + "-" + 22×b + "-" + 5×c; index 55 — the last character the slice keeps — is the
    // second dash, so the untrimmed cut would end in "-".
    const out = composeSessionName("a".repeat(32), `${"b".repeat(22)} ${"c".repeat(5)}`, free);
    expect(out).toBe(`${"a".repeat(32)}-${"b".repeat(22)}`);
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
  // Asserts the EXACT string: `length <= NAME_MAX` plus `endsWith("-a")` also holds for the BROKEN
  // output, because dropping the pre-trim makes every lettered candidate fail NAME_RE and the
  // function falls through to the `<taskSlug>-<letter>` family — which still ends in "-a" and is
  // still short enough. The requested name vanishes entirely and only the exact string notices.
  it("keeps the disambiguating letter when the joined name is already at the cap", () => {
    const slug = "a".repeat(32);
    const requested = "b".repeat(32);
    const first = composeSessionName(slug, requested, free) ?? "";
    const second = composeSessionName(slug, requested, except([first]));
    // 32 + 1 + 21 + 2 = 56: the base is pre-trimmed by 2 so "-a" still fits inside NAME_MAX.
    expect(second).toBe(`${"a".repeat(32)}-${"b".repeat(21)}-a`);
    expect(second).toHaveLength(NAME_MAX);
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
