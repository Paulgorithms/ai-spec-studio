import { describe, expect, test } from "vitest";
import { getExample, getExamples } from "@/lib/examples";

// Covers the disposable example data. Delete this file along with
// src/lib/examples.ts when starting a real project.
describe("examples data", () => {
  test("every example has a unique slug", async () => {
    const slugs = (await getExamples()).map((example) => example.slug);

    expect(slugs.length).toBeGreaterThan(0);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("getExample finds an example by slug", async () => {
    const example = await getExample("dynamic-params");

    expect(example?.title).toBe("Dynamic params");
  });

  test("getExample returns undefined for an unknown slug", async () => {
    expect(await getExample("does-not-exist")).toBeUndefined();
  });
});
