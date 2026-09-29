import { describe, expect, it } from "vitest";

import { descriptionRev } from "../shared/description-rev.ts";

describe("descriptionRev", () => {
  it("is 12 lowercase hex and stable", () => {
    const r = descriptionRev("b", "t_1", "text");
    expect(r).toMatch(/^[0-9a-f]{12}$/);
    expect(descriptionRev("b", "t_1", "text")).toBe(r);
  });

  it("differs across cards holding the same text, including empty", () => {
    expect(descriptionRev("b", "t_1", "")).not.toBe(descriptionRev("b", "t_2", ""));
    expect(descriptionRev("b1", "t_1", "x")).not.toBe(descriptionRev("b2", "t_1", "x"));
  });

  it("changes when the text changes", () => {
    expect(descriptionRev("b", "t_1", "a")).not.toBe(descriptionRev("b", "t_1", "b"));
  });
});
