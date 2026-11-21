// Read-only preflight for the local test database (Step 5B). Run it yourself
// from the project root:
//
//   ./node_modules/.bin/tsx scripts/db/test-database-check.ts pre
//
// Loads .env.local when it exists (lib/local-env.ts: a variable already set
// in the shell wins; no file means the shell must set everything), connects
// once as TEST_DATABASE_URL (ai_spec_studio_test only), and prints fixed
// PASS/FAIL labels with codes, ending with the database's state: fresh, the
// approved migration applied, or unexpected. Never prints URLs, passwords, or
// driver messages, and never writes to the database or takes the advisory
// lock.
// Exit code: 0 when every check passes, 1 when any fails, 2 for bad usage.
import { Pool } from "pg";
import { errorKind, formatResults } from "./lib/live-verification";
import { loadLocalEnv } from "./lib/local-env";
import { readMigrationFiles } from "./lib/migration-files";
import type { MigrationFiles } from "./lib/migration-checks";
import { runTestDatabasePreflight } from "./lib/test-database-target";

async function main(): Promise<number> {
  if (process.argv[2] !== "pre") {
    console.log("Usage: tsx scripts/db/test-database-check.ts pre");
    return 2;
  }
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
  const { results, state } = await runTestDatabasePreflight(
    process.env,
    (config) => new Pool(config),
    files,
  );
  console.log(formatResults(results));
  if (state) console.log(`Test database state: ${state}`);
  return results.every((result) => result.pass) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.log(`FAIL  checks stopped (${errorKind(error)})`);
    process.exitCode = 1;
  },
);
