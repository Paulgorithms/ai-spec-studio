// Whether the test role is cut off from the development database, judged
// against where the integration tests run.
//
// Locally, ai_spec_studio_dev exists (scripts/db/local-setup.sql) and the
// test role must not be able to CONNECT to it. In CI it must not exist at
// all: the disposable cluster has only the test database
// (scripts/db/ci-setup.sql).
//
// Which of the two applies is decided from two independent sources that must
// agree, never from whether the development database exists:
//   - the process environment: the GitHub-hosted Linux runner checks of
//     checkCiRunner (exact values), or none of their variables at all;
//   - the server the test role is connected to: the CI cluster is the
//     Ubuntu 18/main cluster, which ci-setup.sql's preflight requires.
// Anything partial or contradictory is a failure, not a guess.
//
// Whatever the classification, a development database the test role can
// CONNECT to is never accepted: CI requires it absent, local development
// requires it present and closed.
import {
  checkCiRunner,
  type CiRunnerCode,
  type CiRunnerOptions,
} from "../../../../scripts/db/lib/ci-runner";
import type { DatabaseEnv } from "../env";

export const DEVELOPMENT_DATABASE = "ai_spec_studio_dev";

// The cluster_name ci-setup.sql's preflight requires of the CI server.
export const CI_CLUSTER_NAME = "18/main";

// The variables a GitHub-hosted runner sets and checkCiRunner checks.
const RUNNER_VARIABLES = [
  "GITHUB_ACTIONS",
  "CI",
  "RUNNER_ENVIRONMENT",
  "RUNNER_OS",
] as const;

// The checkCiRunner codes about the runner itself. Its other checks (no
// database variables, RUNNER_TEMP, GITHUB_ENV) are about the steps before
// the tests and don't apply inside a test worker.
const RUNNER_CODES: readonly CiRunnerCode[] = [
  "NOT_GITHUB_ACTIONS",
  "NOT_CI",
  "NOT_GITHUB_HOSTED",
  "NOT_LINUX_RUNNER",
  "NOT_LINUX_PLATFORM",
];

export const ISOLATION_CODES = {
  ENVIRONMENT_INCONSISTENT:
    "the runner variables are neither all those of a GitHub-hosted Linux runner nor all unset",
  SERVER_NOT_CI_CLUSTER:
    "the runner is GitHub-hosted, but the server is not the CI cluster",
  SERVER_IS_CI_CLUSTER:
    "no runner variables are set, but the server is the CI cluster",
  CI_DEVELOPMENT_DATABASE_PRESENT:
    "CI: the development database exists (the CI cluster must not have one)",
  LOCAL_DEVELOPMENT_DATABASE_MISSING:
    "local: the development database doesn't exist, so its isolation can't be checked",
  DEVELOPMENT_CONNECT_ALLOWED:
    "the test role can CONNECT to the development database",
  LOCAL_DEVELOPMENT_CONNECT_UNKNOWN:
    "local: the test role's CONNECT privilege on the development database wasn't read",
} as const;

export type IsolationCode = keyof typeof ISOLATION_CODES;

export type IsolationEnvironment = "ci" | "local";

export type DevelopmentDatabaseFacts = {
  // current_setting('cluster_name') on the test role's own session.
  clusterName: string;
  // Whether pg_database has a row named ai_spec_studio_dev.
  developmentDatabaseExists: boolean;
  // has_database_privilege(current_user, 'ai_spec_studio_dev', 'CONNECT'),
  // read only when the database exists; null otherwise.
  testRoleCanConnect: boolean | null;
};

export type EnvironmentResult =
  | { ok: true; environment: IsolationEnvironment }
  | { ok: false; codes: IsolationCode[] };

export function classifyEnvironment(
  env: DatabaseEnv,
  clusterName: string,
  options: CiRunnerOptions = {},
): EnvironmentResult {
  const runner = checkCiRunner(env, options);
  const runnerCodes = runner.ok
    ? []
    : runner.codes.filter((code) => RUNNER_CODES.includes(code));
  const githubHosted = runnerCodes.length === 0;
  const noRunnerVariables = RUNNER_VARIABLES.every(
    (name) => env[name] === undefined,
  );
  const ciCluster = clusterName === CI_CLUSTER_NAME;

  if (githubHosted) {
    return ciCluster
      ? { ok: true, environment: "ci" }
      : { ok: false, codes: ["SERVER_NOT_CI_CLUSTER"] };
  }
  if (noRunnerVariables) {
    return ciCluster
      ? { ok: false, codes: ["SERVER_IS_CI_CLUSTER"] }
      : { ok: true, environment: "local" };
  }
  return { ok: false, codes: ["ENVIRONMENT_INCONSISTENT"] };
}

// Every reason the facts fail the isolation requirement; empty means it
// holds.
export function developmentDatabaseIsolationViolations(
  env: DatabaseEnv,
  facts: DevelopmentDatabaseFacts,
  options: CiRunnerOptions = {},
): IsolationCode[] {
  const environment = classifyEnvironment(env, facts.clusterName, options);
  const codes: IsolationCode[] = environment.ok ? [] : [...environment.codes];

  // Checked whatever the classification: never accepted anywhere.
  if (facts.developmentDatabaseExists && facts.testRoleCanConnect === true) {
    codes.push("DEVELOPMENT_CONNECT_ALLOWED");
  }
  if (!environment.ok) return codes;

  if (environment.environment === "ci") {
    if (facts.developmentDatabaseExists) {
      codes.push("CI_DEVELOPMENT_DATABASE_PRESENT");
    }
    return codes;
  }
  if (!facts.developmentDatabaseExists) {
    codes.push("LOCAL_DEVELOPMENT_DATABASE_MISSING");
  } else if (facts.testRoleCanConnect === null) {
    codes.push("LOCAL_DEVELOPMENT_CONNECT_UNKNOWN");
  }
  return codes;
}
