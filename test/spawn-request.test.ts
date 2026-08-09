import { describe, expect, it } from "vitest";

import { buildSpawnRequest, type SpawnFormState } from "../web/src/lib/spawn-request.ts";

const base: SpawnFormState = {
  env: "work-local", envKind: "local", targetWorkspaceId: null, repo: "repo",
  model: null, remoteControl: false, startCommand: null,
};

describe("buildSpawnRequest", () => {
  it("omits every optional key at its default", () => {
    expect(buildSpawnRequest(base)).toEqual({ env: "work-local", targetWorkspaceId: null, repo: "repo" });
  });

  it("sends the start command on a local env", () => {
    expect(buildSpawnRequest({ ...base, startCommand: "/plan" }))
      .toEqual({ env: "work-local", targetWorkspaceId: null, repo: "repo", startCommand: "/plan" });
  });

  it("omits the start command on a remote env", () => {
    expect(buildSpawnRequest({ ...base, envKind: "remote", startCommand: "/plan" }))
      .toEqual({ env: "work-local", targetWorkspaceId: null, repo: "repo" });
  });

  it("omits the start command when the env kind is unknown — unknown is NOT local", () => {
    expect(buildSpawnRequest({ ...base, envKind: null, startCommand: "/plan" }))
      .toEqual({ env: "work-local", targetWorkspaceId: null, repo: "repo" });
  });

  it("restores the selection on a local → remote → local switch", () => {
    const picked: SpawnFormState = { ...base, startCommand: "/plan" };
    const away = buildSpawnRequest({ ...picked, envKind: "remote" });
    const back = buildSpawnRequest(picked); // the SELECTION never changed, only the env kind
    expect("startCommand" in away).toBe(false);
    expect(back).toHaveProperty("startCommand", "/plan");
  });

  it("still sends model and remoteControl when set", () => {
    expect(buildSpawnRequest({ ...base, model: "opus", remoteControl: true }))
      .toEqual({ env: "work-local", targetWorkspaceId: null, repo: "repo", model: "opus", remoteControl: true });
  });
});
