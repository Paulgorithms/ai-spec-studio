import { describe, expect, test } from "vitest";
import { formatDate, pluralize } from "@/lib/format";

describe("formatDate", () => {
  test("formats an ISO date as a short US date", () => {
    expect(formatDate("2026-11-06T10:05:00Z")).toBe("Nov 6, 2026");
  });

  test("uses UTC, not the machine's time zone", () => {
    // 23:30 UTC is already the next day in many zones; UTC keeps Oct 31.
    expect(formatDate("2026-10-31T23:30:00Z")).toBe("Oct 31, 2026");
    expect(formatDate("2026-11-01T00:30:00Z")).toBe("Nov 1, 2026");
  });
});

describe("pluralize", () => {
  test.each([
    [0, "0 specifications"],
    [1, "1 specification"],
    [4, "4 specifications"],
  ])("%i gives %j", (count, expected) => {
    expect(pluralize(count, "specification")).toBe(expected);
  });

  test("accepts an irregular plural", () => {
    expect(pluralize(2, "entry", "entries")).toBe("2 entries");
  });
});
