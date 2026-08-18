import { describe, expect, it } from "vitest";

import { parseWire } from "../server/diagnostics/remote/wire.ts";

const KEYS = new Set(["f_0", "f_1", "f_2", "t_0"]);
const b64 = (s: string): string => Buffer.from(s).toString("base64");
const CAP = 10 * 1024 * 1024;

describe("parseWire", () => {
  it("decodes content lines to bytes with the executability bit", () => {
    const r = parseWire(`f_0\tx:${b64("#!/bin/sh\n")}\nf_1\tf:${b64("{}")}`, KEYS, CAP);
    const a = r.answers.get("f_0");
    expect(a?.kind === "content" && a.executable && a.bytes.toString() === "#!/bin/sh\n").toBe(true);
    const bAns = r.answers.get("f_1");
    expect(bAns?.kind === "content" && !bAns.executable).toBe(true);
  });

  it("decodes every marker to its answer", () => {
    const r = parseWire(
      "f_0\t!absent\nf_1\t!too-large:x\nf_2\t!unreadable:f\nt_0\t!error",
      KEYS, CAP,
    );
    expect(r.answers.get("f_0")).toEqual({ kind: "absent" });
    expect(r.answers.get("f_1")).toEqual({ kind: "too-large", executable: true });
    expect(r.answers.get("f_2")).toEqual({ kind: "unreadable", executable: false });
    expect(r.answers.get("t_0")).toEqual({ kind: "error" });
    expect(r.missing.size).toBe(0);
  });

  it("drops a line carrying an UNKNOWN marker — Zod rejection, not a guess", () => {
    const r = parseWire("f_0\t!bogus\nf_1\t!not-regular", KEYS, CAP);
    expect(r.answers.has("f_0")).toBe(false);
    expect(r.missing.has("f_0")).toBe(true);
    expect(r.answers.get("f_1")).toEqual({ kind: "not-regular" });
  });

  it("reports never-arrived keys as missing, distinctly from any marker", () => {
    const r = parseWire("f_0\t!absent", KEYS, CAP);
    expect(r.answers.has("f_1")).toBe(false);
    expect(r.missing.has("f_1")).toBe(true);
    expect(r.missing.has("f_0")).toBe(false);
  });

  it("drops SSH banners, garbage and shapeless lines without losing real answers", () => {
    const raw = `Warning: Permanently added 'h' to hosts.\nmotd banner\nf_0\tv:${b64("/home/u")}\nnot a line at all`;
    const r = parseWire(raw, KEYS, CAP);
    expect(r.answers.get("f_0")).toEqual({ kind: "value", text: "/home/u" });
    expect(r.answers.size).toBe(1);
  });

  it("drops well-formed lines whose key was never assigned (forgery guard)", () => {
    const r = parseWire(`evil\tv:${b64("green")}\nf_0\t!absent`, KEYS, CAP);
    expect(r.answers.has("evil")).toBe(false);
    expect(r.answers.size).toBe(1);
  });

  it("keeps the FIRST answer when a key repeats", () => {
    const r = parseWire(`f_0\t!absent\nf_0\tv:${b64("late")}`, KEYS, CAP);
    expect(r.answers.get("f_0")).toEqual({ kind: "absent" });
  });

  it("drops the last line when the total cap truncated the stream", () => {
    const whole = `f_0\t!absent\nf_1\tv:${b64("x".repeat(200))}`;
    const r = parseWire(whole, KEYS, 40); // cap cuts inside the f_1 line
    expect(r.answers.get("f_0")).toEqual({ kind: "absent" });
    expect(r.answers.has("f_1")).toBe(false);
    expect(r.missing.has("f_1")).toBe(true);
  });

  it("drops a line with malformed base64 rather than throwing", () => {
    const r = parseWire("f_0\tv:!!not-base64!!", KEYS, CAP);
    expect(r.answers.has("f_0")).toBe(false);
    expect(r.missing.has("f_0")).toBe(true);
  });

  it("an EMPTY base64 payload is an answered-positive empty value, not a miss", () => {
    const r = parseWire("f_0\tv:", KEYS, CAP);
    expect(r.answers.get("f_0")).toEqual({ kind: "value", text: "" });
  });

  it("trims a value the way runLocalTool trims stdout", () => {
    const r = parseWire(`t_0\tv:${b64("herdr 0.7.5\n")}`, KEYS, CAP);
    expect(r.answers.get("t_0")).toEqual({ kind: "value", text: "herdr 0.7.5" });
  });
});
