import { RecapSourceSchema, RecapStatusSchema } from "@shared/schema";
import { describe, expect, it } from "vitest";

import { isRecapStale, RECAP_SOURCE_LABEL, recapReason } from "../web/src/lib/recap-line.ts";

describe("recapReason", () => {
  // Exhaustive over the wire enum plus `null`: a status added to the schema without words here would
  // otherwise reach the operator as a blank line, which is the exact failure this feature exists to end.
  it.each([...RecapStatusSchema.options, null])("has words for %s", (status) => {
    expect(recapReason(status).length).toBeGreaterThan(0);
  });

  it("distinguishes a broken read from an empty one", () => {
    expect(recapReason("read-error")).not.toBe(recapReason("no-summary"));
    expect(recapReason("not-found")).not.toBe(recapReason("no-summary"));
  });

  it("does not report a not-yet-swept pane as a failure", () => {
    expect(recapReason(null)).not.toBe(recapReason("read-error"));
  });
});

describe("isRecapStale", () => {
  // The cache keeps the last good text and refreshes only the status, so a failed read on a session
  // that HAS a recap is the one case where the failure would otherwise never reach the operator.
  it.each(RecapStatusSchema.options.filter((s) => s !== "ok"))("marks text stale on %s", (status) => {
    expect(isRecapStale(status, true)).toBe(true);
  });

  it("leaves a healthy read alone", () => {
    expect(isRecapStale("ok", true)).toBe(false);
  });

  it("is not staleness when there is no text to be stale, or no sweep yet", () => {
    expect(isRecapStale("read-error", false)).toBe(false);
    expect(isRecapStale(null, true)).toBe(false);
  });
});

describe("RECAP_SOURCE_LABEL", () => {
  it.each(RecapSourceSchema.options)("labels %s with a tag and a hint", (source) => {
    expect(RECAP_SOURCE_LABEL[source].tag.length).toBeGreaterThan(0);
    expect(RECAP_SOURCE_LABEL[source].hint.length).toBeGreaterThan(0);
  });

  it("gives every rung a distinct tag", () => {
    const tags = RecapSourceSchema.options.map((s) => RECAP_SOURCE_LABEL[s].tag);
    expect(new Set(tags).size).toBe(tags.length);
  });
});
