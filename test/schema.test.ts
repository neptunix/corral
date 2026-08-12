import { StatuslineDataSchema, StatuslineStatusSchema, SessionRowSchema, RegistryStatusSchema, AccountUsageSchema, UploadResponseSchema, UPLOAD_MAX_BYTES, EnvStateSchema, AttentionMapSchema, AttentionRecordSchema, PaneReadSchema, SnapshotSchema, FleetRestoreReportSchema } from "@shared/schema";
import { describe, it, expect } from "vitest";

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

describe("SessionRow — Claude's own session state", () => {
  const base = {
    env: "e", paneId: "p1", status: "idle", agent: "claude", cwd: "/", tab: "t", workspace: "w",
  };

  it("SessionRow defaults the four registry fields to null", () => {
    const row = SessionRowSchema.parse(base);
    expect(row.claudeStatus).toBeNull();
    expect(row.waitingFor).toBeNull();
    expect(row.registryStatus).toBeNull();
    // null, NOT false: "we have no record for this session" is not "Remote Control is off".
    expect(row.remoteControl).toBeNull();
  });

  it("SessionRow carries registry state when present", () => {
    const row = SessionRowSchema.parse({
      ...base,
      claudeStatus: "waiting", waitingFor: "input needed", remoteControl: true, registryStatus: "ok",
    });
    expect(row.claudeStatus).toBe("waiting");
    expect(row.waitingFor).toBe("input needed");
    expect(row.remoteControl).toBe(true);
    expect(row.registryStatus).toBe("ok");
  });

  it("carries remoteControl: false distinctly from the null default", () => {
    expect(SessionRowSchema.parse({ ...base, remoteControl: false }).remoteControl).toBe(false);
  });

  it("rejects an unknown registryStatus — it is the drift detector, not a free-text field", () => {
    expect(SessionRowSchema.safeParse({ ...base, registryStatus: "probably-fine" }).success).toBe(false);
  });

  // Every member is asserted by name. A `toEqual(RegistryStatusSchema.options)` would compare the
  // schema against itself and stay green through any edit to it.
  it("RegistryStatus admits exactly the six documented states", () => {
    for (const s of ["ok", "no-session-ref", "no-config-dirs", "not-found", "bad-schema", "read-error"]) {
      expect(RegistryStatusSchema.safeParse(s).success).toBe(true);
    }
    expect(RegistryStatusSchema.options).toHaveLength(6);
  });

  // `no-config-dirs` is the member StatuslineStatus does NOT have, and the reason this is a separate
  // enum rather than a reuse. If it ever disappears, readRegistry's zero-dirs branch has no status.
  it("RegistryStatus has no-config-dirs, which StatuslineStatus does not", () => {
    expect(RegistryStatusSchema.safeParse("no-config-dirs").success).toBe(true);
    expect(StatuslineStatusSchema.safeParse("no-config-dirs").success).toBe(false);
  });
});

describe("FleetRestoreReportSchema", () => {
  it("accepts a full report and rejects a bad outcome", () => {
    const good = {
      dryRun: false,
      envs: {
        e1: {
          error: null, updatedAt: 1700000000, unmirrored: 0, pendingRestore: true,
          sessions: [{ sessionId: "3f2a9c1e-0000-4000-8000-000000000001", name: "t", outcome: "resumed", error: null }],
        },
        e2: { error: "not_in_mirror", updatedAt: null, unmirrored: 2, pendingRestore: false, sessions: [] },
      },
    };
    expect(FleetRestoreReportSchema.parse(good)).toEqual(good);
    const bad = { ...good, envs: { e1: { ...good.envs.e1, sessions: [{ sessionId: "x", name: "t", outcome: "exploded", error: null }] } } };
    expect(FleetRestoreReportSchema.safeParse(bad).success).toBe(false);
  });
});
