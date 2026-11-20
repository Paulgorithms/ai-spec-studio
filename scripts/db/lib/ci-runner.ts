// Checks that a CI-only database step is running where it was designed to:
// a GitHub-hosted Linux runner whose environment holds no database settings
// yet, with RUNNER_TEMP and GITHUB_ENV pointing at the runner's own, real
// files.
//
// This is defense in depth, not proof of identity. Anyone can set these
// variables, so passing means only that nothing contradicts a GitHub-hosted
// runner. The protections that matter stay in the existing validators
// (parseTestDatabaseEnv, checkTestDatabaseConfiguration, checkSessionIdentity,
// checkTestDatabase), which this never replaces, calls, or loosens.
//
// Fails closed: anything missing, ambiguous, or unreadable is an error. The
// result is fixed codes only, never a variable's value, a path, or a system
// error message.
import { lstatSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseEnv } from "../../../src/lib/db/env";
import { DATABASE_VARIABLES } from "../../../src/lib/db/testing/integration-run";
import { UNEXPECTED_VARIABLES } from "./migration-checks";

export const CI_RUNNER_CODES = {
  NOT_GITHUB_ACTIONS: "GITHUB_ACTIONS is not exactly true",
  NOT_CI: "CI is not exactly true",
  NOT_GITHUB_HOSTED: "RUNNER_ENVIRONMENT is not exactly github-hosted",
  NOT_LINUX_RUNNER: "RUNNER_OS is not exactly Linux",
  NOT_LINUX_PLATFORM: "the process is not running on Linux",
  UID_UNAVAILABLE: "the process user ID is unavailable",
  DATABASE_VARIABLE_SET:
    "a database variable (DATABASE_*, TEST_DATABASE_URL) is already set",
  UNEXPECTED_VARIABLE_SET:
    "a PG*, NODE_TLS_REJECT_UNAUTHORIZED, or NODE_EXTRA_CA_CERTS variable is set",
  NODE_ENV_PRODUCTION: "NODE_ENV is production",
  RUNNER_TEMP_MISSING: "RUNNER_TEMP is not set",
  RUNNER_TEMP_INVALID: "RUNNER_TEMP is not a plain, normalized absolute path",
  RUNNER_TEMP_UNREADABLE: "RUNNER_TEMP could not be inspected",
  RUNNER_TEMP_UNSAFE:
    "RUNNER_TEMP is not a real directory owned by this user and closed to other users",
  GITHUB_ENV_MISSING: "GITHUB_ENV is not set",
  GITHUB_ENV_INVALID: "GITHUB_ENV is not a plain, normalized absolute path",
  GITHUB_ENV_OUTSIDE_RUNNER_TEMP: "GITHUB_ENV is not inside RUNNER_TEMP",
  GITHUB_ENV_UNREADABLE: "GITHUB_ENV could not be inspected",
  GITHUB_ENV_UNSAFE:
    "GITHUB_ENV is not a real, single-link file owned by this user in directories closed to other users",
} as const;

export type CiRunnerCode = keyof typeof CI_RUNNER_CODES;

export type CiRunnerResult =
  | { ok: true; runnerTemp: string; githubEnv: string }
  | { ok: false; codes: CiRunnerCode[] };

type EntryStats = Pick<
  Stats,
  "isDirectory" | "isFile" | "isSymbolicLink" | "uid" | "mode" | "nlink"
>;

export type CiRunnerOptions = {
  // Defaults to the real process and file system; tests inject them.
  platform?: NodeJS.Platform;
  uid?: number | undefined;
  lstat?: (file: string) => EntryStats;
  realpath?: (file: string) => string;
};

// Only characters a GitHub-hosted runner path uses: no spaces, quotes,
// control characters, backslashes, or anything a shell or parser could read
// two ways.
const PLAIN_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]{1,4095}$/;
const OTHERS_WRITE = 0o002;

// Absolute, already normalized (no "//", ".", "..", or trailing "/"), and
// not the root itself.
function isPlainAbsolutePath(value: string): boolean {
  if (!PLAIN_ABSOLUTE_PATH.test(value)) return false;
  if (path.posix.normalize(value) !== value) return false;
  const segments = value.split("/").slice(1);
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}

// Compares path segments, not string prefixes: /a/b-c is not inside /a/b.
function segmentsBelow(parent: string, child: string): string[] | undefined {
  const parentSegments = parent.split("/").slice(1);
  const childSegments = child.split("/").slice(1);
  if (childSegments.length <= parentSegments.length) return undefined;
  const sameRoot = parentSegments.every(
    (segment, index) => childSegments[index] === segment,
  );
  return sameRoot ? childSegments.slice(parentSegments.length) : undefined;
}

function isOwnedAndClosed(entry: EntryStats, uid: number): boolean {
  return (
    !entry.isSymbolicLink() &&
    entry.uid === uid &&
    (entry.mode & OTHERS_WRITE) === 0
  );
}

export function checkCiRunner(
  env: DatabaseEnv,
  options: CiRunnerOptions = {},
): CiRunnerResult {
  const {
    platform = process.platform,
    lstat = (file: string) => lstatSync(file),
    realpath = (file: string) => realpathSync(file),
  } = options;
  const uid = "uid" in options ? options.uid : process.getuid?.();
  const codes: CiRunnerCode[] = [];
  const fail = (code: CiRunnerCode) => {
    if (!codes.includes(code)) codes.push(code);
  };

  // 1. The runner (exact values: "true " or "linux" is not a match).
  if (env.GITHUB_ACTIONS !== "true") fail("NOT_GITHUB_ACTIONS");
  if (env.CI !== "true") fail("NOT_CI");
  if (env.RUNNER_ENVIRONMENT !== "github-hosted") fail("NOT_GITHUB_HOSTED");
  if (env.RUNNER_OS !== "Linux") fail("NOT_LINUX_RUNNER");
  if (platform !== "linux") fail("NOT_LINUX_PLATFORM");
  if (typeof uid !== "number" || !Number.isInteger(uid) || uid < 0) {
    fail("UID_UNAVAILABLE");
  }

  // 2. The environment: nothing database-related set before this step,
  // even to "".
  if (DATABASE_VARIABLES.some((name) => env[name] !== undefined)) {
    fail("DATABASE_VARIABLE_SET");
  }
  if (
    Object.keys(env).some(
      (name) => UNEXPECTED_VARIABLES.test(name) && env[name] !== undefined,
    )
  ) {
    fail("UNEXPECTED_VARIABLE_SET");
  }
  if (env.NODE_ENV?.trim().toLowerCase() === "production") {
    fail("NODE_ENV_PRODUCTION");
  }

  // 3. RUNNER_TEMP: a real directory (no symbolic link anywhere in the
  // path), owned by this user, not writable by others.
  const runnerTemp = env.RUNNER_TEMP;
  let runnerTempOk = false;
  if (runnerTemp === undefined || runnerTemp === "") {
    fail("RUNNER_TEMP_MISSING");
  } else if (!isPlainAbsolutePath(runnerTemp)) {
    fail("RUNNER_TEMP_INVALID");
  } else if (typeof uid === "number") {
    try {
      const entry = lstat(runnerTemp);
      if (
        realpath(runnerTemp) === runnerTemp &&
        entry.isDirectory() &&
        isOwnedAndClosed(entry, uid)
      ) {
        runnerTempOk = true;
      } else {
        fail("RUNNER_TEMP_UNSAFE");
      }
    } catch {
      fail("RUNNER_TEMP_UNREADABLE");
    }
  }

  // 4. GITHUB_ENV: a real, single-link regular file below RUNNER_TEMP, owned
  // by this user, with every directory between them owned by this user and
  // not writable by others.
  const githubEnv = env.GITHUB_ENV;
  if (githubEnv === undefined || githubEnv === "") {
    fail("GITHUB_ENV_MISSING");
  } else if (!isPlainAbsolutePath(githubEnv)) {
    fail("GITHUB_ENV_INVALID");
  } else if (runnerTemp !== undefined && isPlainAbsolutePath(runnerTemp)) {
    const below = segmentsBelow(runnerTemp, githubEnv);
    if (!below) {
      fail("GITHUB_ENV_OUTSIDE_RUNNER_TEMP");
    } else if (runnerTempOk && typeof uid === "number") {
      try {
        let directory = runnerTemp;
        let safe = true;
        for (const segment of below.slice(0, -1)) {
          directory = `${directory}/${segment}`;
          const entry = lstat(directory);
          if (!entry.isDirectory() || !isOwnedAndClosed(entry, uid)) {
            safe = false;
            break;
          }
        }
        const file = safe ? lstat(githubEnv) : undefined;
        if (
          !file ||
          realpath(githubEnv) !== githubEnv ||
          !file.isFile() ||
          file.nlink !== 1 ||
          !isOwnedAndClosed(file, uid)
        ) {
          fail("GITHUB_ENV_UNSAFE");
        }
      } catch {
        fail("GITHUB_ENV_UNREADABLE");
      }
    }
  }

  if (
    codes.length === 0 &&
    runnerTempOk &&
    runnerTemp !== undefined &&
    githubEnv !== undefined
  ) {
    return { ok: true, runnerTemp, githubEnv };
  }
  // Every path to here records a code; the fallback only keeps it closed.
  return {
    ok: false,
    codes: codes.length > 0 ? codes : ["RUNNER_TEMP_UNSAFE"],
  };
}

// One fixed line per code, for FAIL output.
export function describeCiRunnerCodes(codes: readonly CiRunnerCode[]): string {
  return codes.map((code) => `${code}: ${CI_RUNNER_CODES[code]}`).join("\n");
}
