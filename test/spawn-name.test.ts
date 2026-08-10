import { describe, expect, it } from "vitest";

import {
  composeSessionName, fallbackNamePrefix, NAME_MAX, sanitizeSlug, slugify,
} from "../server/spawn.ts";

const free = (): boolean => true;
const except = (taken: readonly string[]) => (n: string): boolean => !taken.includes(n);

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

describe("composeSessionName — the agent's name is the name", () => {
  it("returns the requested name verbatim, with no card prefix", () => {
    expect(composeSessionName("my-task", "wm-stake rc toggle", free)).toBe("wm-stake-rc-toggle");
  });

  it("never consults the fallback prefix when a name was supplied", () => {
    expect(composeSessionName("some-very-long-card-slug", "short", free)).toBe("short");
  });

  it("appends the first free letter when the requested name is already taken", () => {
    expect(composeSessionName("my-task", "rc-toggle", except(["rc-toggle"]))).toBe("rc-toggle-a");
  });

  it("takes the next free letter when earlier ones are taken", () => {
    expect(composeSessionName("my-task", "rc", except(["rc", "rc-a", "rc-b"]))).toBe("rc-c");
  });

  it("returns null when nothing is both free and valid, so the route can 409", () => {
    expect(composeSessionName("my-task", "rc-toggle", () => false)).toBeNull();
  });

  // The case `() => false` above CANNOT catch: it rejects the fallback-prefix candidates too, so a
  // function that wrongly falls through to them still returns null and looks correct. Here only the
  // requested name's 27 candidates are taken and every `my-task-<letter>` is free — a fallthrough
  // returns "my-task-a" and the agent gets a name it never asked for, with a 200.
  it("returns null — not a fallback-prefix name — when the requested name's 27 candidates are taken", () => {
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    const taken = ["rc-toggle", ...letters.map((l) => `rc-toggle-${l}`)];
    expect(composeSessionName("my-task", "rc-toggle", except(taken))).toBeNull();
  });
});

// THE regression for revision 1's first blocker. NAME_RE hardcoded {0,55} — one character short of
// the OLD NAME_MAX — while composeSessionName gates every candidate on it. Raising NAME_MAX without
// deriving NAME_RE from it made every name over 56 characters fail the gate, so composeSessionName
// returned null and the route answered 409 "no free session name left on this task" for a card with
// no sessions at all. Asserts the EXACT string: `length > 56` would also hold for a name truncated
// to some other wrong bound.
describe("composeSessionName — names longer than the old 56-character bound", () => {
  it("returns a 70-character name intact rather than rejecting it", () => {
    const requested = "b".repeat(70);
    expect(composeSessionName("fb", requested, free)).toBe(requested);
  });

  it("still disambiguates a name past the old bound", () => {
    const requested = "b".repeat(70);
    expect(composeSessionName("fb", requested, except([requested]))).toBe(`${requested}-a`);
  });
});

describe("composeSessionName — the cap", () => {
  // Asserts the EXACT string, not `length <= NAME_MAX`. The bound is enforced by the slice and by
  // NAME_RE, so a length assertion survives every mutation to the truncation machinery and moves its
  // own goalpost when NAME_MAX changes. Pinning where the cut lands is the only assertion that fails
  // when truncation breaks.
  it("cuts the requested name to exactly NAME_MAX characters", () => {
    const out = composeSessionName("fb", "b".repeat(200), free);
    expect(out).toBe("b".repeat(NAME_MAX));
    expect(out).toHaveLength(NAME_MAX);
  });

  // Pre-trimming the lettered base by 2 is what stops truncation from eating the letter that
  // disambiguates. Asserts the EXACT string: `length <= NAME_MAX` plus `endsWith("-a")` also holds
  // for a broken output that dropped the name entirely.
  it("keeps the disambiguating letter when the name is already at the cap", () => {
    const first = composeSessionName("fb", "b".repeat(200), free) ?? "";
    const second = composeSessionName("fb", "b".repeat(200), except([first]));
    expect(second).toBe(`${"b".repeat(NAME_MAX - 2)}-a`);
    expect(second).toHaveLength(NAME_MAX);
  });

  // The candidate is re-trimmed after the slice, so a cut landing on a dash cannot emit a
  // trailing-dash name as `--name` / `--remote-control` / the tab label. NAME_RE permits a trailing
  // dash, so nothing else in the file would catch losing that re-trim.
  it("re-trims a dash the truncation cut lands on", () => {
    // The cut at NAME_MAX lands on the dash between the two runs.
    const requested = `${"b".repeat(NAME_MAX)} ${"c".repeat(5)}`;
    expect(composeSessionName("fb", requested, free)).toBe("b".repeat(NAME_MAX));
  });

  // THE invariant two spec revisions got backwards: the string tested for freeness must be the
  // string returned. Truncation happens BEFORE the test, so a taken TRUNCATED name is rejected.
  it("tests the truncated string for freeness, not the untruncated one", () => {
    const requested = "b".repeat(200);
    const first = composeSessionName("fb", requested, free) ?? "";
    expect(first).toHaveLength(NAME_MAX); // it really was truncated
    const second = composeSessionName("fb", requested, except([first]));
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});

describe("composeSessionName — the fallback prefix", () => {
  it("falls back to <prefix>-<first free letter> when the name is absent or unusable", () => {
    expect(composeSessionName("my-task", "", free)).toBe("my-task-a");
    expect(composeSessionName("my-task", "***", free)).toBe("my-task-a");
  });

  it("takes the next free letter when earlier ones are taken", () => {
    expect(composeSessionName("my-task", "", except(["my-task-a", "my-task-b"]))).toBe("my-task-c");
  });

  // A name written in a non-Latin script reduces to nothing, which IS the "not supplied" signal —
  // the fallback carries it rather than the spawn failing.
  it("treats a name in a non-Latin script as not supplied", () => {
    expect(composeSessionName("my-task", "исправить зомби", free)).toBe("my-task-a");
    expect(composeSessionName("my-task", "日本語", free)).toBe("my-task-a");
  });

  // THE regression for revision 1's second blocker. The chain's last resort is task.id, minted as
  // `t_${nanoid(7)}` — nanoid's alphabet contains "_" and uppercase, and NAME_RE admits neither, so
  // a raw id made the last-resort fallback a guaranteed 409. Measured over 2000 generated ids, 2000
  // of 2000 failed. The prefix must go through the same charset reduction as everything else.
  it("reduces a task-id prefix to the launch-flag charset", () => {
    expect(composeSessionName("t_Ab3D9xk", "", free)).toBe("t-ab3d9xk-a");
  });

  it("returns null when every lettered fallback candidate is taken", () => {
    expect(composeSessionName("my-task", "", () => false)).toBeNull();
  });
});

// Every step is slugified, and the chain is ordered most-meaningful first. It exists ONLY for the
// no-name path — an agent that supplies a name never reaches it.
describe("fallbackNamePrefix", () => {
  it("uses the card title when it carries anything usable", () => {
    expect(fallbackNamePrefix("Create WM Stakeholders", "corral", "t_ab3d9xk")).toBe("create-wm-stakeholders");
  });

  it("truncates a long title to 32 characters", () => {
    expect(fallbackNamePrefix("a".repeat(40), null, "t_ab3d9xk")).toBe("a".repeat(32));
  });

  // The case the whole design exists for: a title with no Latin characters used to reduce to the
  // sentinel "task", so every session on every such card was named task-a, task-b — indistinguishable
  // in the herdr tab bar and the /resume picker, which are global.
  it("falls through to the repo when the title has nothing usable", () => {
    expect(fallbackNamePrefix("Починить зомби-ридер", "corral", "t_ab3d9xk")).toBe("corral");
  });

  it("falls through to the task id when there is no repo either", () => {
    expect(fallbackNamePrefix("Починить зомби-ридер", null, "t_ab3d9xk")).toBe("t-ab3d9xk");
  });

  it("falls through to the task id when the repo itself has nothing usable", () => {
    expect(fallbackNamePrefix("日本語", "***", "t_ab3d9xk")).toBe("t-ab3d9xk");
  });

  // The last resort must satisfy the launch-flag charset, which "ASCII" does not imply: ids are
  // `t_${nanoid(7)}` and nanoid's alphabet contains "_" and uppercase. Measured over 2000 generated
  // ids, 2000 of 2000 failed the charset before this was slugified.
  it("reduces the task id to the launch-flag charset", () => {
    expect(fallbackNamePrefix("***", null, "t_Ab3D9xk")).toBe("t-ab3d9xk");
  });
});

// Pins the EXACT reduction of each input, not `NAME_RE.test(out)`. Two reasons a regex-based shape
// could not fail: it would re-declare its own copy of production's (unexported) NAME_RE, so the two
// could drift apart silently; and a fixture set without a character the charset rules actually have
// to remove leaves `.toLowerCase()` or the `[^a-z0-9]+` collapse safe to delete.
describe("composeSessionName — charset reduction", () => {
  it.each([
    ["RC Toggle UI!", "rc-toggle-ui"],       // uppercase + trailing punctuation
    ["MiXeD CaSe", "mixed-case"],            // uppercase only
    ["café/naïve", "caf-na-ve"],             // non-ASCII letters are dropped, not transliterated
    ["  spaced   out  ", "spaced-out"],      // runs of spaces collapse to one dash
    ["trailing---", "trailing"],             // a trailing dash run is trimmed off
    ["--leading", "leading"],                // a leading dash run cannot survive into a flag value
    ["under_score", "under-score"],          // "_" is not in the charset
  ])("reduces %j to the launch-flag charset as %j", (requested, expected) => {
    expect(composeSessionName("my-task", requested, free)).toBe(expected);
  });
});
