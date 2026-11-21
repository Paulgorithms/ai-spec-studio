// Applies the approved migration to the local test database, once (Step 5B-3).
// Run it yourself from the project root, after the read-only preflight:
//
//   npm run db:migrate:test
//
// Loads .env.local when it exists (lib/local-env.ts: a variable already set
// in the shell wins; no file means the shell must set everything) and uses
// only TEST_DATABASE_URL, as ai_spec_studio_test.
// One connection holds the test-database advisory lock for the whole run.
// Prints fixed PASS/FAIL labels with codes; never URLs, passwords, or driver
// messages. On any failure it stops for review: never rerun it blindly.
// Exit code: 0 when migrated or already up to date, 1 otherwise.
import { Pool } from "pg";
import { errorKind, formatResults } from "./lib/live-verification";
import { loadLocalEnv } from "./lib/local-env";
import type { MigrationFiles } from "./lib/migration-checks";
import { readMigrationFiles } from "./lib/migration-files";
import { runTestDatabaseMigration } from "./lib/test-database-migration";

async function main(): Promise<number> {
  let files: MigrationFiles;
  try {
    files = readMigrationFiles();
  } catch (error) {
    console.log(
      `FAIL  could not read the drizzle/ migration files (${errorKind(error)})`,
    );
    return 1;
  }
  const localEnv = loadLocalEnv();
  if (!localEnv.ok) {
    console.log(`FAIL  could not load .env.local (${localEnv.reason})`);
    return 1;
  }
  const { results, outcome } = await runTestDatabaseMigration(
    process.env,
    (config) => new Pool(config),
    files,
  );
  console.log(formatResults(results));
  console.log(`Test database migration: ${outcome}`);
  return results.every((result) => result.pass) && outcome !== "not-migrated"
    ? 0
    : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.log(`FAIL  migration runner stopped (${errorKind(error)})`);
    process.exitCode = 1;
  },
);
