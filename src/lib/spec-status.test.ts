import { describe, expect, test } from "vitest";
import { SPEC_STATUSES, SPEC_STATUS_LABELS } from "@/lib/spec-status";

describe("SPEC_STATUS_LABELS", () => {
  test("has a readable, distinct label for every status", () => {
    const labels = SPEC_STATUSES.map((status) => SPEC_STATUS_LABELS[status]);

    expect(labels).toEqual(["Draft", "In review", "Approved"]);
    expect(new Set(labels).size).toBe(SPEC_STATUSES.length);
  });
});
