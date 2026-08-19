import { describe, expect, it } from "vitest";

import { parseRepoSlug, readRepoSlug } from "../server/diagnostics/update/repo-slug.ts";

describe("parseRepoSlug", () => {
  it("reads the object form this repo carries", () => {
    expect(parseRepoSlug("git+https://github.com/neptunix/corral.git"))
      .toEqual({ owner: "neptunix", repo: "corral" });
  });

  it("reads a plain https url with no .git suffix", () => {
    expect(parseRepoSlug("https://github.com/neptunix/corral"))
      .toEqual({ owner: "neptunix", repo: "corral" });
  });

  it("reads the string shorthand, with and without the github: prefix", () => {
    expect(parseRepoSlug("neptunix/corral")).toEqual({ owner: "neptunix", repo: "corral" });
    expect(parseRepoSlug("github:neptunix/corral")).toEqual({ owner: "neptunix", repo: "corral" });
  });

  it("reads the ssh url form", () => {
    expect(parseRepoSlug("git+ssh://git@github.com/neptunix/corral.git"))
      .toEqual({ owner: "neptunix", repo: "corral" });
  });

  it("refuses a non-GitHub host, so a fork never reports the upstream's releases", () => {
    expect(parseRepoSlug("https://gitlab.example/neptunix/corral.git")).toBe(null);
    expect(parseRepoSlug("gitlab:neptunix/corral")).toBe(null);
    expect(parseRepoSlug("https://github.com.evil.example/neptunix/corral")).toBe(null);
  });

  it("refuses anything it cannot split into exactly two safe segments", () => {
    expect(parseRepoSlug("")).toBe(null);
    expect(parseRepoSlug("   ")).toBe(null);
    expect(parseRepoSlug("https://github.com/neptunix")).toBe(null);
    expect(parseRepoSlug("https://github.com/neptunix/corral/extra")).toBe(null);
    expect(parseRepoSlug("https://github.com/../corral")).toBe(null);
    expect(parseRepoSlug("not a url at all")).toBe(null);
  });
});

describe("readRepoSlug", () => {
  it("reads this checkout's own package.json", () => {
    expect(readRepoSlug()).toEqual({ owner: "neptunix", repo: "corral" });
  });

  it("returns null rather than throwing on unreadable or malformed json", () => {
    expect(readRepoSlug(() => { throw new Error("ENOENT"); })).toBe(null);
    expect(readRepoSlug(() => "{ not json")).toBe(null);
    expect(readRepoSlug(() => JSON.stringify({ name: "corral" }))).toBe(null);
    expect(readRepoSlug(() => JSON.stringify({ repository: { type: "git" } }))).toBe(null);
  });
});
