// Step 3C live check: read-only verification of the app, migration, and test
// database connections. Run it yourself from the project root:
//
//   npx tsx scripts/db/verify-connections.ts
//
// It loads .env.local with Node's process.loadEnvFile() (a variable already
// set in the shell wins), connects only to loopback targets that match the
// expected roles and databases, and prints fixed PASS/FAIL labels with
// SQLSTATE codes. It never prints URLs, passwords, or driver messages.
// Exit code: 0 when every check passes, 1 otherwise.
import { loadEnvFile } from "node:process";
import { Pool } from "pg";
import {
  errorKind,
  formatResults,
  runLiveVerification,
} from "./lib/live-verification";

async function main(): Promise<number> {
  try {
    loadEnvFile(".env.local");
  } catch (error) {
    // Report the code only: the parser's message could quote the file.
    console.log(`FAIL  could not load .env.local (${errorKind(error)})`);
    return 1;
  }
  const results = await runLiveVerification(
    process.env,
    (config) => new Pool(config),
  );
  console.log(formatResults(results));
  return results.every((result) => result.pass) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.log(`FAIL  verification stopped (${errorKind(error)})`);
    process.exitCode = 1;
  },
);
