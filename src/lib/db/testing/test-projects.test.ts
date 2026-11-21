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

  test("only the postgres-integration job runs the integration tests, and only the ci job runs the unit tests", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ciJobPolicyViolations(ci)).toEqual([]);
  });

  describe("the CI job policy", () => {
    const job = (name: string, ...runs: string[]) =>
      [
        `  ${name}:`,
        "    runs-on: ubuntu-24.04",
        "    steps:",
        ...runs.map((run) => `      - run: ${run}`),
      ].join("\n");
    const workflow = (...jobs: string[]) =>
      ["name: CI", "on:", "  push:", "jobs:", ...jobs, ""].join("\n");
    const approved = [
      job("ci", "npm ci", "npm run test:unit", "npm run build"),
      job(
        "postgres-integration",
        "npm ci",
        'TEST_DATABASE_URL="$url" npm run test:integration',
      ),
    ];

    test("accepts the approved two jobs", () => {
      expect(ciJobPolicyViolations(workflow(...approved))).toEqual([]);
    });

    test("accepts an unrelated extra job that runs neither", () => {
      expect(
        ciJobPolicyViolations(
          workflow(...approved, job("docs", "npm run lint")),
        ),
      ).toEqual([]);
    });

    test.each([
      [
        "the ci job running the integration tests",
        [
          job("ci", "npm run test:unit", "npm run test:integration"),
          approved[1],
        ],
        "INTEGRATION_JOBS",
      ],
      [
        "the ci job running Vitest's integration project directly",
        [
          job(
            "ci",
            "npm run test:unit",
            "npx vitest run --project integration",
          ),
          approved[1],
        ],
        "INTEGRATION_JOBS",
      ],
      [
        "the ci job setting the integration opt-in",
        [
          job(
            "ci",
            "npm run test:unit",
            "AI_SPEC_STUDIO_INTEGRATION=1 npx vitest run",
          ),
          approved[1],
        ],
        "INTEGRATION_JOBS",
      ],
      [
        "another job running the integration tests",
        [...approved, job("extra", "npm run test:integration")],
        "INTEGRATION_JOBS",
      ],
      [
        "the integration tests moved to another job",
        [approved[0], job("database", "npm run test:integration")],
        "INTEGRATION_JOBS",
      ],
      ["no integration job", [approved[0]], "INTEGRATION_JOBS"],
      [
        "the postgres job also running the unit tests",
        [
          approved[0],
          job(
            "postgres-integration",
            "npm run test:unit",
            "npm run test:integration",
          ),
        ],
        "UNIT_JOBS",
      ],
      [
        "another job running the unit tests",
        [...approved, job("extra", "npm run test:unit")],
        "UNIT_JOBS",
      ],
      [
        "the ci job no longer running the unit tests",
        [job("ci", "npm run build"), approved[1]],
        "CI_RUNS_UNIT_TESTS",
      ],
      [
        "the postgres job only mentioning the integration tests",
        [
          approved[0],
          job("postgres-integration", "echo 'test:integration is skipped'"),
        ],
        "POSTGRES_RUNS_INTEGRATION_TESTS",
      ],
    ])("rejects %s", (_name, jobs, violation) => {
      expect(ciJobPolicyViolations(workflow(...jobs))).toContain(violation);
    });

    test.each([
      [
        "a job hidden by unusual indentation",
        workflow(
          ...approved,
          "   extra:\n      steps:\n        - run: npm run test:integration",
        ),
      ],
      ["a duplicate job", workflow(...approved, approved[1] ?? "")],
      [
        "a top-level key after jobs",
        `${workflow(...approved)}env:\n  X: "npm run test:integration"\n`,
      ],
      [
        "two jobs blocks",
        `${workflow(...approved)}jobs:\n${job("extra", "npm run test:integration")}\n`,
      ],
      ["no jobs block", "name: CI\non:\n  push:\n"],
      [
        "a reference before the jobs block",
        workflow(...approved).replace(
          "name: CI",
          "name: CI\nenv:\n  RUN: npm run test:integration",
        ),
      ],
    ])("fails closed on %s", (_name, text) => {
      expect(ciJobPolicyViolations(text)).not.toEqual([]);
    });

    // The real workflow, edited in memory only: each edit must be caught.
    const real = readFileSync(".github/workflows/ci.yml", "utf8");
    test.each([
      [
        "the ci job given the integration tests",
        "        run: npm run test:unit\n",
        "        run: npm run test:unit\n\n      - name: Integration\n        run: npm run test:integration\n",
        "INTEGRATION_JOBS",
      ],
      [
        "the ci job's unit tests removed",
        "        run: npm run test:unit\n",
        "        run: npm run lint\n",
        "CI_RUNS_UNIT_TESTS",
      ],
      [
        "the postgres job renamed",
        "\n  postgres-integration:\n",
        "\n  database-tests:\n",
        "INTEGRATION_JOBS",
      ],
      [
        "the postgres job also running the unit tests",
        "      - name: Install dependencies\n        run: npm ci\n\n      # Read only.",
        "      - name: Install dependencies\n        run: npm ci\n\n      - name: Unit\n        run: npm run test:unit\n\n      # Read only.",
        "UNIT_JOBS",
      ],
    ])("catches the real workflow with %s", (_name, from, to, violation) => {
      expect(real).toContain(from);
      const edited = real.replace(from, to);
      expect(edited).not.toBe(real);
      expect(ciJobPolicyViolations(edited)).toContain(violation);
    });

    test("finds exactly the two jobs in the real workflow", () => {
      expect([...workflowJobs(real).jobs.keys()]).toEqual([
        "ci",
        "postgres-integration",
      ]);
    });

    test("ignores comments, so a comment can't satisfy or break the policy", () => {
      const commented = workflow(
        job("ci", "npm run test:unit"),
        "  # postgres-integration runs npm run test:integration\n" +
          job("postgres-integration", "npm run test:integration"),
      );
      expect(ciJobPolicyViolations(commented)).toEqual([]);
      const onlyComment = workflow(
        job("ci", "npm run test:unit"),
        job("postgres-integration", "npm ci") +
          "\n      # npm run test:integration",
      );
      expect(ciJobPolicyViolations(onlyComment)).toContain(
        "POSTGRES_RUNS_INTEGRATION_TESTS",
      );
    });
  });
});

// Anything that selects or opts in to the integration tests, or selects the
// unit and component projects. A direct Vitest call counts as much as the
// npm script.
const INTEGRATION_MARKER =
  /test:integration|--project[ =]integration\b|AI_SPEC_STUDIO_INTEGRATION/;
const UNIT_MARKER = /test:unit|--project[ =](unit|component)\b/;

// The jobs of a GitHub Actions workflow, split by YAML block structure: one
// top-level `jobs:` block, each job a two-space key, every other line
// indented deeper. Comment and blank lines are dropped. Anything else (a
// second jobs block, a key after it, a line no job owns, a duplicate job)
// throws, so nothing can hide outside the jobs this policy sees.
function workflowJobs(text: string): {
  before: string[];
  jobs: Map<string, string[]>;
} {
  const lines = text
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^\s*#/.test(line));
  const starts = lines.filter((line) => line === "jobs:").length;
  if (starts !== 1) throw new Error("expected exactly one top-level jobs:");
  const start = lines.indexOf("jobs:");
  const jobs = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([A-Za-z0-9_-]+):$/.exec(line);
    if (key) {
      const name = key[1] ?? "";
      if (jobs.has(name)) throw new Error(`duplicate job ${name}`);
      current = [];
      jobs.set(name, current);
      continue;
    }
    if (!current || !/^ {4,}\S/.test(line)) {
      throw new Error(`a line outside any job: ${line}`);
    }
    current.push(line);
  }
  return { before: lines.slice(0, start), jobs };
}

// Violations of the CI job policy, as codes: the integration tests run in the
// postgres-integration job and nowhere else, and the unit tests in the ci
// job and nowhere else.
function ciJobPolicyViolations(text: string): string[] {
  let parsed: ReturnType<typeof workflowJobs>;
  try {
    parsed = workflowJobs(text);
  } catch {
    return ["STRUCTURE"];
  }
  const violations: string[] = [];
  const { before, jobs } = parsed;
  if (before.some((l) => INTEGRATION_MARKER.test(l) || UNIT_MARKER.test(l))) {
    violations.push("OUTSIDE_JOBS");
  }
  const running = (marker: RegExp) =>
    [...jobs]
      .filter(([, lines]) => lines.some((l) => marker.test(l)))
      .map(([name]) => name);
  if (
    JSON.stringify(running(INTEGRATION_MARKER)) !==
    JSON.stringify(["postgres-integration"])
  ) {
    violations.push("INTEGRATION_JOBS");
  }
  if (JSON.stringify(running(UNIT_MARKER)) !== JSON.stringify(["ci"])) {
    violations.push("UNIT_JOBS");
  }
  // Each job actually runs its command (a step, not just a mention).
  const runsCommand = (job: string, command: RegExp) =>
    (jobs.get(job) ?? []).some((l) => command.test(l.trim()));
  if (!runsCommand("ci", /^(- )?run: npm run test:unit$/)) {
    violations.push("CI_RUNS_UNIT_TESTS");
  }
  if (
    !runsCommand(
      "postgres-integration",
      /^(- run: |run: )?(TEST_DATABASE_URL="\$url" )?npm run test:integration( |$)/,
    )
  ) {
    violations.push("POSTGRES_RUNS_INTEGRATION_TESTS");
  }
  return violations;
}

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
