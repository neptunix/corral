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

  /**
   * The URL case above does NOT cover this: `new URL` normalizes dot segments away, so
   * `https://github.com/../corral` is already `/corral` by the time the split runs and is refused
   * for having one segment. The shorthand branch does no such normalizing, so the explicit `.`/`..`
   * rejection is the only thing standing between a `repository` field and a request path that
   * climbs out of `/repos/`.
   */
  it("refuses a dot segment through the shorthand branch, which does not normalize", () => {
    expect(parseRepoSlug("../corral")).toBe(null);
    expect(parseRepoSlug("./corral")).toBe(null);
    expect(parseRepoSlug("github:../corral")).toBe(null);
    expect(parseRepoSlug("corral/..")).toBe(null);
  });

  it("reads the scp remote form a fork is most likely to paste", () => {
    expect(parseRepoSlug("git@github.com:neptunix/corral.git"))
      .toEqual({ owner: "neptunix", repo: "corral" });
    expect(parseRepoSlug("github.com:neptunix/corral"))
      .toEqual({ owner: "neptunix", repo: "corral" });
  });

  it("refuses an scp form whose host only looks like github", () => {
    expect(parseRepoSlug("git@evilgithub.com:neptunix/corral.git")).toBe(null);
    expect(parseRepoSlug("git@github.com.evil.example:neptunix/corral.git")).toBe(null);
    expect(parseRepoSlug("git@gitlab.com:neptunix/corral.git")).toBe(null);
    expect(parseRepoSlug("git@github.com:../corral.git")).toBe(null);
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
