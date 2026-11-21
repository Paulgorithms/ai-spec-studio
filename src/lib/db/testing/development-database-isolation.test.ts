import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CI_CLUSTER_NAME,
  DEVELOPMENT_DATABASE,
  classifyEnvironment,
  developmentDatabaseIsolationViolations,
  type DevelopmentDatabaseFacts,
} from "./development-database-isolation";

// A GitHub-hosted Linux runner, as checkCiRunner sees it. The runner
// checks are the only ones used, so the file system is never consulted for
// them; RUNNER_TEMP and GITHUB_ENV are left unset on purpose.
const CI_ENV = {
  GITHUB_ACTIONS: "true",
  CI: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  RUNNER_OS: "Linux",
};
const LINUX = { platform: "linux" as const, uid: 1001 };
const MAC = { platform: "darwin" as const, uid: 501 };
const LOCAL_CLUSTER = "";

const facts = (
  overrides: Partial<DevelopmentDatabaseFacts>,
): DevelopmentDatabaseFacts => ({
  clusterName: LOCAL_CLUSTER,
  developmentDatabaseExists: true,
  testRoleCanConnect: false,
  ...overrides,
});
const ciFacts = (overrides: Partial<DevelopmentDatabaseFacts>) =>
  facts({ clusterName: CI_CLUSTER_NAME, ...overrides });

describe("developmentDatabaseIsolationViolations", () => {
  test.each<
    [string, Record<string, string>, DevelopmentDatabaseFacts, object, string[]]
  >([
    [
      "CI, development database absent: passes",
      CI_ENV,
      ciFacts({ developmentDatabaseExists: false, testRoleCanConnect: null }),
      LINUX,
      [],
    ],
    [
      "CI, development database present (closed): fails",
      CI_ENV,
      ciFacts({ developmentDatabaseExists: true, testRoleCanConnect: false }),
      LINUX,
      ["CI_DEVELOPMENT_DATABASE_PRESENT"],
    ],
    [
      "CI, development database present and open: fails twice",
      CI_ENV,
      ciFacts({ developmentDatabaseExists: true, testRoleCanConnect: true }),
      LINUX,
      ["DEVELOPMENT_CONNECT_ALLOWED", "CI_DEVELOPMENT_DATABASE_PRESENT"],
    ],
    [
      "local, development database absent: fails",
      {},
      facts({ developmentDatabaseExists: false, testRoleCanConnect: null }),
      MAC,
      ["LOCAL_DEVELOPMENT_DATABASE_MISSING"],
    ],
    [
      "local, development database present, CONNECT allowed: fails",
      {},
      facts({ testRoleCanConnect: true }),
      MAC,
      ["DEVELOPMENT_CONNECT_ALLOWED"],
    ],
    [
      "local, development database present, CONNECT denied: passes",
      {},
      facts({ testRoleCanConnect: false }),
      MAC,
      [],
    ],
    [
      "local, development database present, CONNECT not read: fails",
      {},
      facts({ testRoleCanConnect: null }),
      MAC,
      ["LOCAL_DEVELOPMENT_CONNECT_UNKNOWN"],
    ],
    [
      "local on Linux (no runner variables): classified local, passes when closed",
      {},
      facts({}),
      LINUX,
      [],
    ],
  ])("%s", (_name, env, input, options, expected) => {
    expect(developmentDatabaseIsolationViolations(env, input, options)).toEqual(
      expected,
    );
  });

  test("an open development database fails even when the environment can't be classified", () => {
    expect(
      developmentDatabaseIsolationViolations(
        { CI: "true" },
        facts({ testRoleCanConnect: true }),
        MAC,
      ),
    ).toEqual(["ENVIRONMENT_INCONSISTENT", "DEVELOPMENT_CONNECT_ALLOWED"]);
  });

  test("a missing development database never passes outside a verified CI run", () => {
    const absent = {
      developmentDatabaseExists: false,
      testRoleCanConnect: null,
    };
    for (const [env, clusterName, options] of [
      [{}, LOCAL_CLUSTER, MAC],
      [{}, CI_CLUSTER_NAME, LINUX],
      [CI_ENV, LOCAL_CLUSTER, LINUX],
      [CI_ENV, CI_CLUSTER_NAME, MAC],
      [{ CI: "true" }, CI_CLUSTER_NAME, LINUX],
      [{ ...CI_ENV, GITHUB_ACTIONS: "false" }, CI_CLUSTER_NAME, LINUX],
    ] as const) {
      expect(
        developmentDatabaseIsolationViolations(
          env,
          facts({ clusterName, ...absent }),
          options,
        ),
      ).not.toEqual([]);
    }
  });
});

describe("classifyEnvironment: unexpected or inconsistent indicators fail closed", () => {
  test.each<[string, Record<string, string>, string, object, object]>([
    [
      "a GitHub-hosted runner on the CI cluster",
      CI_ENV,
      CI_CLUSTER_NAME,
      LINUX,
      { ok: true, environment: "ci" },
    ],
    [
      "no runner variables, not the CI cluster",
      {},
      LOCAL_CLUSTER,
      MAC,
      { ok: true, environment: "local" },
    ],
    [
      "no runner variables, a named local cluster",
      {},
      "local",
      MAC,
      { ok: true, environment: "local" },
    ],
    [
      "a GitHub-hosted runner on another server",
      CI_ENV,
      LOCAL_CLUSTER,
      LINUX,
      { ok: false, codes: ["SERVER_NOT_CI_CLUSTER"] },
    ],
    [
      "the CI cluster without runner variables",
      {},
      CI_CLUSTER_NAME,
      LINUX,
      { ok: false, codes: ["SERVER_IS_CI_CLUSTER"] },
    ],
    [
      "CI=true alone (as for a local E2E run)",
      { CI: "true" },
      LOCAL_CLUSTER,
      MAC,
      { ok: false, codes: ["ENVIRONMENT_INCONSISTENT"] },
    ],
    [
      "CI=false",
      { CI: "false" },
      LOCAL_CLUSTER,
      MAC,
      { ok: false, codes: ["ENVIRONMENT_INCONSISTENT"] },
    ],
    [
      "CI set to empty",
      { CI: "" },
      LOCAL_CLUSTER,
      MAC,
      { ok: false, codes: ["ENVIRONMENT_INCONSISTENT"] },
    ],
    [
      "GITHUB_ACTIONS without the rest",
      { GITHUB_ACTIONS: "true" },
      CI_CLUSTER_NAME,
      LINUX,
      { ok: false, codes: ["ENVIRONMENT_INCONSISTENT"] },
    ],
    [
      "a self-hosted runner",
      { ...CI_ENV, RUNNER_ENVIRONMENT: "self-hosted" },
      CI_CLUSTER_NAME,
      LINUX,
      { ok: false, codes: ["ENVIRONMENT_INCONSISTENT"] },
    ],
    [
      "a macOS runner",
      { ...CI_ENV, RUNNER_OS: "macOS" },
      CI_CLUSTER_NAME,
      MAC,
      { ok: false, codes: ["ENVIRONMENT_INCONSISTENT"] },
    ],
    [
      "runner variables on a non-Linux process",
      CI_ENV,
      CI_CLUSTER_NAME,
      MAC,
      { ok: false, codes: ["ENVIRONMENT_INCONSISTENT"] },
    ],
    [
      "near-miss values",
      { ...CI_ENV, GITHUB_ACTIONS: "true " },
      CI_CLUSTER_NAME,
      LINUX,
      { ok: false, codes: ["ENVIRONMENT_INCONSISTENT"] },
    ],
    [
      "a near-miss cluster name",
      CI_ENV,
      "18/main ",
      LINUX,
      { ok: false, codes: ["SERVER_NOT_CI_CLUSTER"] },
    ],
  ])("%s", (_name, env, clusterName, options, expected) => {
    expect(classifyEnvironment(env, clusterName, options)).toEqual(expected);
  });
});

describe("the CI facts it relies on", () => {
  test("ci-setup.sql requires the CI server's cluster_name and creates no development database", () => {
    const setup = readFileSync("scripts/db/ci-setup.sql", "utf8");
    expect(setup).toContain(
      `IF (current_setting('cluster_name') = '${CI_CLUSTER_NAME}') IS NOT TRUE THEN`,
    );
    expect(setup).toContain(
      "-- No ai_spec_studio_dev database: CI has only the test database.",
    );
    const code = setup
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(code).not.toContain(DEVELOPMENT_DATABASE);
  });

  test("local-setup.sql creates the development database", () => {
    const local = readFileSync("scripts/db/local-setup.sql", "utf8");
    expect(local).toContain(
      "SELECT format('CREATE DATABASE %I TEMPLATE template0 ENCODING %L', name, 'UTF8')\nFROM unnest(ARRAY['ai_spec_studio_dev', 'ai_spec_studio_test']) AS name",
    );
    expect(local).toContain(
      "ALTER DATABASE ai_spec_studio_dev SET app.environment = 'development';",
    );
  });

  test("the integration test reads existence from pg_database before any privilege check, and never changes anything", () => {
    const source = readFileSync(
      "src/lib/db/schema.integration.test.ts",
      "utf8",
    );
    const start = source.indexOf(
      `test("the test role can't reach the development database"`,
    );
    const body = source.slice(start, source.indexOf("\n  });\n", start));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain(
      "from pg_database where datname = ${DEVELOPMENT_DATABASE}",
    );
    expect(body.indexOf("pg_database")).toBeLessThan(
      body.indexOf("has_database_privilege"),
    );
    expect(body).toContain("developmentDatabaseExists\n        ? (");
    expect(body).toContain("withRollback");
    expect(body).toContain(
      "developmentDatabaseIsolationViolations(process.env",
    );
    expect(body).toContain(".toEqual([]);");
    expect(body).not.toMatch(/\b(create|drop|alter|grant|revoke)\b/i);
    expect(body).not.toMatch(/\.skip|skipIf|runIf|todo/);
  });
});
