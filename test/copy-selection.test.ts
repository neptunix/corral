import { describe, expect, it } from "vitest";

import { cleanSelection } from "../web/src/lib/copy-selection";

describe("cleanSelection", () => {
  it("strips trailing padding on every line", () => {
    expect(cleanSelection("a   \nb\t \n", 0)).toBe("a\nb\n");
  });

  it("removes the indent every non-blank line shares, keeping relative indent", () => {
    const text = "  What v8 has   \n  - one, wrapped\n    continuation  \n      \n  - two";
    expect(cleanSelection(text, 0)).toBe("What v8 has\n- one, wrapped\n  continuation\n\n- two");
  });

  it("keeps indentation when some line starts at column 0", () => {
    expect(cleanSelection("def f():\n    return 1", 0)).toBe("def f():\n    return 1");
  });

  it("treats Claude's gutter marker as indent", () => {
    expect(cleanSelection("● Yes, small.\n\n  Why: padding.", 0)).toBe("Yes, small.\n\nWhy: padding.");
    expect(cleanSelection("❯ yes, do it\n  as a PR", 0)).toBe("yes, do it\nas a PR");
  });

  it("keeps a marker that is content, not gutter", () => {
    expect(cleanSelection("● a\nb", 0)).toBe("● a\nb");
  });

  it("leaves a first line that starts mid-row out of the shared indent", () => {
    expect(cleanSelection("possible.\n  Why: padding.\n    nested", 10)).toBe("possible.\nWhy: padding.\n  nested");
  });

  it("strips only the gutter left on a first line that starts inside it", () => {
    expect(cleanSelection(" Yes\n  Why", 1)).toBe("Yes\nWhy");
  });

  it("normalises CRLF", () => {
    expect(cleanSelection("  a  \r\n  b", 0)).toBe("a\nb");
  });
});
