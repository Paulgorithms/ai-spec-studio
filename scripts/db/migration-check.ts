// Read-only checks before and after the first migration (Step 4B-S).
// Run them yourself from the project root:
//
//   ./node_modules/.bin/tsx scripts/db/migration-check.ts pre
//   ./node_modules/.bin/tsx scripts/db/migration-check.ts post
//   ./node_modules/.bin/tsx scripts/db/migration-check.ts constraints
//
// (constraints is a diagnostic: it lists every constraint in schema public as
// PostgreSQL stores it.)
//
// Loads .env.local with Node's process.loadEnvFile() (a variable already set
// in the shell wins), connects once as DATABASE_MIGRATION_URL, and prints
// fixed PASS/FAIL labels with codes. Never prints URLs, passwords, or driver
// messages, and never writes to the database.
// Exit code: 0 when every check passes, 1 when any fails, 2 for bad usage.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { Pool } from "pg";
import { errorKind, formatResults } from "./lib/live-verification";
import {
  runMigrationChecks,
  type MigrationFiles,
  type Phase,
} from "./lib/migration-checks";

// The migration as the drizzle-orm migrator reads it: the first journal
// entry, and the SHA-256 of its whole SQL file.
function readMigrationFiles(): MigrationFiles {
  const journal = JSON.parse(
    readFileSync("drizzle/meta/_journal.json", "utf8"),
  ) as { entries?: Array<{ tag?: unknown; when?: unknown }> };
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const first = entries[0];
  const tag = typeof first?.tag === "string" ? first.tag : "";
  const when = typeof first?.when === "number" ? first.when : Number.NaN;
  const sql = /^[0-9a-z_]+$/.test(tag)
    ? readFileSync(`drizzle/${tag}.sql`, "utf8")
    : "";
  return {
    journalEntries: entries.length,
    tag,
    when,
    sha256: createHash("sha256").update(sql).digest("hex"),
  };
}

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
  try {
    loadEnvFile(".env.local");
  } catch (error) {
    console.log(`FAIL  could not load .env.local (${errorKind(error)})`);
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
