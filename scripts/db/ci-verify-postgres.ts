// Negative security checks for the provisioned CI PostgreSQL server (Phase
// 3D). GitHub-hosted Ubuntu 26.04 runner ONLY, after
// scripts/db/ci-provision-postgres.sh has succeeded:
//
//   ./node_modules/.bin/tsx scripts/db/ci-verify-postgres.ts
//
// Reads TEST_DATABASE_URL's value from the Phase 2 credential file (never
// from the environment, which must hold no database variable), confirms
// the test role reaches the intended server, then makes one connection
// attempt per probe in lib/ci-postgres-probes.ts and requires each to be
// refused in exactly the expected way. Doesn't read .env.local, and writes
// nothing to the database.
//
// Prints fixed PASS/FAIL labels with outcome codes (SQLSTATEs and fixed
// categories); never a URL, password, or driver message.
// Exit code: 0 when every check passes, 1 when any fails, 2 for bad usage.
import { Pool } from "pg";
import { runPostgresProbes } from "./lib/ci-postgres-probes";
import { errorKind, formatResults } from "./lib/live-verification";

async function main(): Promise<number> {
  if (process.argv.length > 2) {
    console.log("Usage: tsx scripts/db/ci-verify-postgres.ts");
    return 2;
  }
  const { results, ok } = await runPostgresProbes({
    env: process.env,
    createPool: (config) => new Pool(config),
  });
  console.log(formatResults(results));
  return ok ? 0 : 1;
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
