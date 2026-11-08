import { describe, expect, test } from "vitest";
import { cx } from "@/lib/class-names";

describe("cx", () => {
  test("joins class names with single spaces", () => {
    expect(cx("a", "b c", "d")).toBe("a b c d");
  });

  test("skips false, null, undefined, and empty strings", () => {
    const isActive = false;
    expect(cx("base", isActive && "active", null, undefined, "", "end")).toBe(
      "base end",
    );
  });

  test("returns an empty string when nothing is left", () => {
    expect(cx(undefined, false)).toBe("");
  });
});
