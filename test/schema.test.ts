import { StatuslineDataSchema, SessionRowSchema, AccountUsageSchema, UploadResponseSchema, UPLOAD_MAX_BYTES, EnvStateSchema } from "@shared/schema";
import { describe, it, expect } from "vitest";

import { AttentionMapSchema, AttentionRecordSchema, PaneReadSchema, SnapshotSchema } from "../shared/schema.ts";

describe("shared schema", () => {
  it("parses a snapshot without recap fields (defaults to null)", () => {
    const snap = {
      envs: { "work-local": { reachable: true } },
      sessions: [{ env: "work-local", paneId: "w1-1", status: "working", agent: "claude", cwd: "/x", tab: "t", workspace: "w" }],
    };
    const parsed = SnapshotSchema.parse(snap);
    const row = parsed.sessions[0];
    expect(row?.sessionId).toBeNull();
    expect(row?.recap).toBeNull();
    expect(row?.recapAt).toBeNull();
    expect(row?.recapStatus).toBeNull();
  });

  it("parses a snapshot with full recap fields", () => {
    const snap = {
      envs: { "work-local": { reachable: true } },
      sessions: [{
        env: "work-local", paneId: "w1-1", status: "working", agent: "claude",
        cwd: "/x", tab: "t", workspace: "w",
        sessionId: "a13ad559-8e59-4b98-b420-2746ef0b94d8",
        recap: "Working on feat/recap-capture.",
        recapAt: 1751000000000,
        recapStatus: "ok",
      }],
    };
    const parsed = SnapshotSchema.parse(snap);
    const row = parsed.sessions[0];
    expect(row?.sessionId).toBe("a13ad559-8e59-4b98-b420-2746ef0b94d8");
    expect(row?.recap).toBe("Working on feat/recap-capture.");
    expect(row?.recapStatus).toBe("ok");
  });

  it("rejects an invalid recapStatus value", () => {
    const bad = {
      envs: {},
      sessions: [{ env: "e", paneId: "p1", status: "idle", agent: "claude", cwd: "/", tab: "t", workspace: "w", sessionId: null, recap: null, recapAt: null, recapStatus: "invalid-status" }],
    };
    expect(SnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a snapshot with a non-boolean reachable", () => {
    const bad = { envs: { a: { reachable: "yes" } }, sessions: [] };
    expect(SnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("parses a pane read with null parsed fields", () => {
    const pr = { text: "hi", ctxPct: null, model: null, sessionName: null };
    expect(PaneReadSchema.parse(pr)).toEqual(pr);
  });
});

describe("AttentionRecordSchema", () => {
  it("parses a blocked record", () => {
    const r = AttentionRecordSchema.parse({
      state: "blocked", since: 1751700800000, sessionName: "task-42-a", lastLines: "…", captured: true,
    });
    expect(r.state).toBe("blocked");
  });
  it("allows null sessionName and rejects an unknown state", () => {
    expect(AttentionRecordSchema.parse({ state: "finished", since: 1, sessionName: null, lastLines: "", captured: false }).sessionName).toBeNull();
    expect(AttentionRecordSchema.safeParse({ state: "nope", since: 1, sessionName: null, lastLines: "", captured: false }).success).toBe(false);
  });
  it("AttentionMapSchema defaults empty", () => {
    expect(AttentionMapSchema.parse(undefined)).toEqual({});
  });
});

describe("StatuslineDataSchema", () => {
  const valid = {
    v: 1, captured_at: 1752345678, session_id: "s1", session_name: "task-42-a", name_source: null,
    account: { uuid: "u1", email: "a@b.c", org: "O", tier: "default_claude_max_20x" },
    model: "Opus", model_id: "claude-opus-4-8",
    ctx: { pct: 42, tokens: 84000, window: 200000 },
    cost: { usd: 0.83, lines_added: 120, lines_removed: 30 },
    rate: { five_hour: { used_percentage: 31, resets_at: 1752360000 },
            seven_day: { used_percentage: 58, resets_at: 1752900000 } },
    effort: "high", thinking: true, cc_version: "2.1.205",
  };

  it("parses a full v1 record", () => {
    expect(StatuslineDataSchema.parse(valid)).toEqual(valid);
  });

  it("tolerates absent optional metrics as nulls", () => {
    const sparse = { ...valid, account: null, cost: { usd: null, lines_added: null, lines_removed: null },
      rate: { five_hour: null, seven_day: null }, effort: null, thinking: null, cc_version: null };
    expect(StatuslineDataSchema.parse(sparse).rate.five_hour).toBeNull();
  });

  it("rejects a wrong schema version", () => {
    expect(StatuslineDataSchema.safeParse({ ...valid, v: 2 }).success).toBe(false);
  });

  it("SessionRow defaults statusline fields to null", () => {
    const row = SessionRowSchema.parse({
      env: "e", paneId: "p", status: "working", agent: "a", cwd: "/c", tab: "t", workspace: "w",
    });
    expect(row.statusline).toBeNull();
    expect(row.statuslineStatus).toBeNull();
  });

  it("AccountUsage round-trips", () => {
    const acc = { uuid: "u1", email: "a@b.c", org: "O", tier: "t",
      fiveHour: { used_percentage: 10, resets_at: 1 }, sevenDay: null, capturedAt: 5, envIds: ["e1"] };
    expect(AccountUsageSchema.parse(acc)).toEqual(acc);
  });
});

describe("StatuslineDataSchema name_source", () => {
  const base = {
    v: 1, captured_at: 1, session_id: "s", session_name: "n",
    account: null, model: null, model_id: null,
    ctx: { pct: null, tokens: null, window: null },
    cost: { usd: null, lines_added: null, lines_removed: null },
    rate: { five_hour: null, seven_day: null },
    effort: null, thinking: null, cc_version: null,
  };

  it("defaults name_source to null when absent (old captures parse)", () => {
    const parsed = StatuslineDataSchema.parse(base);
    expect(parsed.name_source).toBeNull();
  });

  it("round-trips a user-set source", () => {
    const parsed = StatuslineDataSchema.parse({ ...base, name_source: "user" });
    expect(parsed.name_source).toBe("user");
  });
});

describe("upload schema", () => {
  it("parses a valid upload response", () => {
    expect(UploadResponseSchema.parse({ path: "/tmp/x/foo.png" })).toEqual({ path: "/tmp/x/foo.png" });
  });
  it("rejects a missing path", () => {
    expect(UploadResponseSchema.safeParse({}).success).toBe(false);
  });
  it("exposes a positive byte cap", () => {
    expect(UPLOAD_MAX_BYTES).toBeGreaterThan(0);
  });
  it("accepts an EnvState with kind and without kind", () => {
    expect(EnvStateSchema.parse({ reachable: true, kind: "local" }).kind).toBe("local");
    expect(EnvStateSchema.parse({ reachable: true }).kind).toBeUndefined();
  });
});
