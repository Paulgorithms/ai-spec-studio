// Applies the approved migration to the local test database, once (Step 5B-3).
// Run it yourself from the project root, after the read-only preflight:
//
//   npm run db:migrate:test
//
// Loads .env.local with Node's process.loadEnvFile() (a variable already set
// in the shell wins) and uses only TEST_DATABASE_URL, as ai_spec_studio_test.
// One connection holds the test-database advisory lock for the whole run.
// Prints fixed PASS/FAIL labels with codes; never URLs, passwords, or driver
// messages. On any failure it stops for review: never rerun it blindly.
// Exit code: 0 when migrated or already up to date, 1 otherwise.
import { loadEnvFile } from "node:process";
import { Pool } from "pg";
import { errorKind, formatResults } from "./lib/live-verification";
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
  try {
    loadEnvFile(".env.local");
  } catch (error) {
    console.log(`FAIL  could not load .env.local (${errorKind(error)})`);
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
