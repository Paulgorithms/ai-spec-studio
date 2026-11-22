// Read-only checks before and after the development migrations (Step 4B-S;
// every approved migration, in order, since Task 1.2.3 Phase 3D).
// Run them yourself from the project root:
//
//   ./node_modules/.bin/tsx scripts/db/migration-check.ts pre
//   ./node_modules/.bin/tsx scripts/db/migration-check.ts post
//   ./node_modules/.bin/tsx scripts/db/migration-check.ts constraints
//
// (constraints is a diagnostic: it lists every constraint in schema public as
// PostgreSQL stores it.)
//
// Loads .env.local when it exists (lib/local-env.ts: a variable already set
// in the shell wins; no file means the shell must set everything), connects
// once as DATABASE_MIGRATION_URL, and prints fixed PASS/FAIL labels with
// codes. Never prints URLs, passwords, or driver messages, and never writes
// to the database.
// Exit code: 0 when every check passes, 1 when any fails, 2 for bad usage.
import { Pool } from "pg";
import { errorKind, formatResults } from "./lib/live-verification";
import { loadLocalEnv } from "./lib/local-env";
import {
  runMigrationChecks,
  type MigrationFiles,
  type Phase,
} from "./lib/migration-checks";
import { readMigrationFiles } from "./lib/migration-files";

async function main(): Promise<number> {
  const phase = process.argv[2];
  if (phase !== "pre" && phase !== "post" && phase !== "constraints") {
    console.log(
      "Usage: tsx scripts/db/migration-check.ts pre|post|constraints",
    );
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
  const results = await runMigrationChecks(
    phase satisfies Phase,
    process.env,
    (config) => new Pool(config),
    files,
  );
  console.log(formatResults(results));
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
