// Integration project globalSetup: runs once, in Vitest's main process,
// before any worker starts, and its teardown after every test file.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Pool } from "pg";
import type { TestProject } from "vitest/node";
import { readMigrationFiles } from "../../../../scripts/db/lib/migration-files";
import {
  isolateIntegrationEnvironment,
  mergeIntegrationEnvironment,
  requireIntegrationOptIn,
  startIntegrationRun,
} from "./integration-run";

function readEnvFile(): Record<string, string> {
  try {
    return parseEnv(readFileSync(".env.local", "utf8")) as Record<
      string,
      string
    >;
  } catch (error) {
    // No .env.local: the shell must provide TEST_DATABASE_URL.
    if ((error as { code?: unknown }).code === "ENOENT") return {};
    throw new Error("Could not read .env.local.");
  }
}

export default async function setup(project: TestProject) {
  requireIntegrationOptIn(process.env);
  // Read .env.local into this function only (never into process.env), then
  // remove every database variable from the process before workers start.
  const env = mergeIntegrationEnvironment(readEnvFile(), process.env);
  isolateIntegrationEnvironment(process.env);

  const run = await startIntegrationRun(
    env,
    (config) => new Pool(config),
    readMigrationFiles(),
  );
  project.provide("testDatabase", run.connection);
  return run.finish;
}
