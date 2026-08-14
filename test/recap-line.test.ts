import { RecapSourceSchema, RecapStatusSchema } from "@shared/schema";
import { describe, expect, it } from "vitest";

import { RECAP_SOURCE_LABEL, recapReason } from "../web/src/lib/recap-line.ts";

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
