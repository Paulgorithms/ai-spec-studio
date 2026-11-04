import { describe, expect, test } from "vitest";
import { getErrorDigest } from "@/lib/errors";

describe("getErrorDigest", () => {
  test("returns the digest from an error that has one", () => {
    const error = Object.assign(new Error("Server error"), {
      digest: "abc123",
    });

    expect(getErrorDigest(error)).toBe("abc123");
  });

  test("returns undefined for an error without a digest", () => {
    expect(getErrorDigest(new Error("Client error"))).toBeUndefined();
  });

  test("ignores a digest that isn't a string", () => {
    expect(getErrorDigest({ digest: 42 })).toBeUndefined();
  });

  test.each([null, undefined, "thrown string", 0])(
    "returns undefined for the non-object value %s",
    (value) => {
      expect(getErrorDigest(value)).toBeUndefined();
    },
  );
});
