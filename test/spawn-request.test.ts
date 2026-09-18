import { describe, expect, it } from "vitest";

import { buildSpawnRequest, type SpawnFormState } from "../web/src/lib/spawn-request.ts";

const base: SpawnFormState = {
  env: "work-local", envKind: "local", targetWorkspaceId: null, repo: "repo",
  model: null, remoteControl: false, startCommand: null,
};

describe("buildSpawnRequest", () => {
  it("omits every optional key at its default", () => {
    expect(buildSpawnRequest(base)).toEqual({ env: "work-local", targetWorkspaceId: null, repo: "repo", spawnedBy: "operator" });
  });

  it("sends the start command on a local env", () => {
    expect(buildSpawnRequest({ ...base, startCommand: "/plan" }))
      .toEqual({ env: "work-local", targetWorkspaceId: null, repo: "repo", startCommand: "/plan", spawnedBy: "operator" });
  });

  it("omits the start command on a remote env", () => {
    expect(buildSpawnRequest({ ...base, envKind: "remote", startCommand: "/plan" }))
      .toEqual({ env: "work-local", targetWorkspaceId: null, repo: "repo", spawnedBy: "operator" });
  });

  it("omits the start command when the env kind is unknown — unknown is NOT local", () => {
    expect(buildSpawnRequest({ ...base, envKind: null, startCommand: "/plan" }))
      .toEqual({ env: "work-local", targetWorkspaceId: null, repo: "repo", spawnedBy: "operator" });
  });

  it("still sends model and remoteControl when set", () => {
    expect(buildSpawnRequest({ ...base, model: "opus", remoteControl: true }))
      .toEqual({ env: "work-local", targetWorkspaceId: null, repo: "repo", model: "opus", remoteControl: true, spawnedBy: "operator" });
  });

  it("omits a blank preset's text — the stored shape allows one, the route does not", () => {
    expect(buildSpawnRequest({ ...base, startCommand: "" }))
      .toEqual({ env: "work-local", targetWorkspaceId: null, repo: "repo", spawnedBy: "operator" });
  });

  it("always sends spawnedBy: \"operator\" — the web UI is the operator", () => {
    expect(buildSpawnRequest(base).spawnedBy).toBe("operator");
  });
});
