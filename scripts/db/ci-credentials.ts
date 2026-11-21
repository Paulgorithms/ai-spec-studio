// The CI-only credential step (Phase 2C). Runs on a GitHub-hosted Linux
// runner, from the project root, before the CI database is provisioned:
//
//   ./node_modules/.bin/tsx scripts/db/ci-credentials.ts
//
// Refuses to run anywhere else (lib/ci-runner.ts) or when any POSTGRES_*
// variable is set. Generates the test role's disposable password, its
// TEST_DATABASE_URL, and its SCRAM-SHA-256 verifier; prints ::add-mask:: for
// the password and the verifier first; then writes the URL and the verifier
// to two 0600 files in a new 0700 directory under RUNNER_TEMP
// (lib/ci-credential-files.ts). Later steps read those files into their own
// environment; this never writes GITHUB_ENV or process.env, never runs a
// shell or child process, and never handles the administrator credential.
//
// Doesn't read .env.local. Prints fixed PASS/FAIL lines with codes only.
// Exit code: 0 when both files were written, 1 otherwise, 2 for bad usage.
import { runCiCredentialStep, writeStdout } from "./lib/ci-credential-files";

function main(): number {
  if (process.argv.length > 2) {
    writeStdout("Usage: tsx scripts/db/ci-credentials.ts\n");
    return 2;
  }
  return runCiCredentialStep({ env: process.env });
}

try {
  process.exitCode = main();
} catch {
  try {
    writeStdout("FAIL  CI credential step stopped (unexpected error)\n");
  } catch {
    // Nothing else can be reported; the exit code says it failed.
  }
  process.exitCode = 1;
}
