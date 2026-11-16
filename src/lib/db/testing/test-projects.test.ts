// The integration tests must only ever run through npm run test:integration.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

type Project = { test: Record<string, unknown> & { name: string } };
// Loaded at run time: TypeScript doesn't resolve .mts imports in this project.
const config = (
  (await import(
    /* @vite-ignore */ new URL("../../../../vitest.config.mts", import.meta.url)
      .href
  )) as { default: { test?: { projects?: unknown } } }
).default;
const projects = (config.test?.projects ?? []) as Project[];
const byName = (name: string) =>
  projects.find((p) => p.test.name === name)?.test;
const scripts = (
  JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

describe("Vitest projects", () => {
  test("unit and component exclude integration tests", () => {
    expect(byName("unit")).toMatchObject({
      include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
      exclude: ["**/*.integration.test.*"],
    });
    expect(byName("component")).toMatchObject({
      include: ["src/**/*.test.tsx"],
      exclude: ["**/*.integration.test.*"],
    });
    expect(byName("unit")).not.toHaveProperty("globalSetup");
    expect(byName("component")).not.toHaveProperty("globalSetup");
  });

  test("the integration project runs one file at a time in one Node worker", () => {
    expect(byName("integration")).toMatchObject({
      environment: "node",
      include: ["src/**/*.integration.test.ts"],
      fileParallelism: false,
      maxWorkers: 1,
      globalSetup: ["./src/lib/db/testing/global-setup.ts"],
      setupFiles: ["./src/lib/db/testing/setup.ts"],
    });
  });

  test("there are exactly these three projects", () => {
    expect(projects.map((p) => p.test.name)).toEqual([
      "unit",
      "component",
      "integration",
    ]);
  });
});

describe("npm scripts and CI", () => {
  test("test:unit and its watch mode select only unit and component", () => {
    expect(scripts["test:unit"]).toBe(
      "vitest run --project unit --project component",
    );
    expect(scripts["test:unit:watch"]).toBe(
      "vitest --project unit --project component",
    );
  });

  test("test:integration opts in explicitly and selects only integration", () => {
    expect(scripts["test:integration"]).toBe(
      "AI_SPEC_STUDIO_INTEGRATION=1 vitest run --project integration",
    );
  });

  test("CI runs test:unit and never test:integration", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("npm run test:unit");
    expect(ci).not.toContain("test:integration");
  });
});

describe("the testing helpers", () => {
  const sources = readdirSync("src/lib/db/testing")
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map(
      (name) =>
        [name, readFileSync(`src/lib/db/testing/${name}`, "utf8")] as const,
    );

  test.each(sources)(
    "%s never imports the application's database client",
    (_, source) => {
      expect(source).not.toMatch(
        /from\s+["'](?:\.\.\/client|@\/lib\/db\/client|\.\.\/index)["']/,
      );
      expect(source).not.toMatch(
        /process\.env\.(DATABASE_URL|DATABASE_MIGRATION_URL)/,
      );
    },
  );

  test("the public entry point exports no pool, client, or database", async () => {
    const entry = await import("./index");
    expect(Object.keys(entry).sort()).toEqual([
      "RollbackCleanupError",
      "expectPgError",
      "findPgError",
      "withRollback",
    ]);
  });
});
