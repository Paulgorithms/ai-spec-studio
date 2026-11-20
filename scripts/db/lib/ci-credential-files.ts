// The CI credential step (Phase 2C): checks the runner, generates the test
// role's disposable credentials, masks them, and writes them to two private
// files under RUNNER_TEMP for the later steps that read them:
//
//   $RUNNER_TEMP/ai-spec-studio-db/          0700, created by this run
//     test-database-url                      0600, TEST_DATABASE_URL's value
//     test-role-verifier                     0600, the SCRAM-SHA-256 verifier
//
// Order: checkCiRunner and the POSTGRES_* check (no randomness drawn when
// either fails) -> CiCredentials.create -> the ::add-mask:: lines, as the
// first output -> the files. Nothing is written to GITHUB_ENV or
// process.env, nothing is run in a shell or child process, and the
// administrator credential is never part of this step.
//
// Files are published without replacement: each is written under a
// temporary name opened O_CREAT|O_EXCL|O_NOFOLLOW, synced, then hard-linked
// to its final name (link(2) fails with EEXIST rather than replacing
// anything) and the temporary name removed. Identity (device and inode),
// owner, mode, and link count are checked at each step.
//
// Threat model: RUNNER_TEMP is owned by this user and closed to others
// (checkCiRunner), so other accounts can't plant or swap entries. A process
// running as the same user can, and is out of scope: it could read this
// process's memory anyway. Whatever ends up in the file still has to pass
// the consumers' own validators.
//
// Output is fixed PASS/FAIL lines with codes only. Failure cleanup removes
// only what this invocation created, verified by identity first, and never
// recursively.
import {
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import type { DatabaseEnv } from "../../../src/lib/db/env";
import {
  CiCredentialError,
  CiCredentials,
  type RandomSource,
} from "./ci-credentials";
import { checkCiRunner, describeCiRunnerCodes } from "./ci-runner";
import { errorKind } from "./live-verification";

export const CI_CREDENTIAL_DIRECTORY = "ai-spec-studio-db";
export const CI_CREDENTIAL_FILES = {
  testDatabaseUrl: "test-database-url",
  testRoleVerifier: "test-role-verifier",
} as const;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const PERMISSION_BITS = 0o7777;
const POSTGRES_VARIABLE = /^POSTGRES_/i;

export const CI_CREDENTIAL_STEP_CODES = {
  POSTGRES_VARIABLE_SET:
    "a POSTGRES_* variable is set (the administrator credential must not reach this step)",
  CREDENTIALS_FAILED: "the credentials could not be generated",
  MASK_OUTPUT_FAILED: "the mask commands could not be written",
  DIRECTORY_EXISTS: "the credential directory already exists",
  DIRECTORY_CREATE_FAILED: "the credential directory could not be created",
  DIRECTORY_UNSAFE:
    "the credential directory is not a 0700 directory owned by this user",
  DIRECTORY_REPLACED: "the credential directory changed while in use",
  DIRECTORY_CONTENTS_UNEXPECTED:
    "the credential directory holds something other than the two credential files",
  DIRECTORY_SYNC_FAILED: "the credential directory could not be synced",
  PARTIAL_EXISTS: "a temporary credential file already exists",
  FILE_CREATE_FAILED: "a credential file could not be created",
  FILE_UNSAFE:
    "a new credential file is not an empty, single-link 0600 file owned by this user",
  WRITE_FAILED: "a credential file could not be written",
  WRITE_INCOMPLETE: "a credential file's size doesn't match what was written",
  FSYNC_FAILED: "a credential file could not be synced",
  FILE_REPLACED: "a temporary credential file changed while in use",
  DESTINATION_EXISTS: "a credential file already exists at its final name",
  PUBLISH_FAILED: "a credential file could not be published",
  PUBLISH_VERIFY_FAILED:
    "a published credential file is not the single-link file that was written",
  CLOSE_FAILED: "a credential file could not be closed",
} as const;

export type CiCredentialStepCode = keyof typeof CI_CREDENTIAL_STEP_CODES;

type Identity = { dev: number; ino: number };

export type EntryStats = Identity &
  Pick<
    Stats,
    | "isFile"
    | "isDirectory"
    | "isSymbolicLink"
    | "uid"
    | "mode"
    | "nlink"
    | "size"
  >;

// Every file-system call the step makes. Tests inject failures and races.
export type CredentialFileSystem = {
  lstat: (path: string) => EntryStats;
  realpath: (path: string) => string;
  mkdir: (path: string, mode: number) => void;
  open: (path: string, flags: number, mode: number) => number;
  fstat: (fd: number) => EntryStats;
  write: (fd: number, buffer: Buffer, offset: number, length: number) => number;
  fsync: (fd: number) => void;
  close: (fd: number) => void;
  link: (existingPath: string, newPath: string) => void;
  unlink: (path: string) => void;
  rmdir: (path: string) => void;
  readdir: (path: string) => string[];
};

export const nodeCredentialFileSystem: CredentialFileSystem = {
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync(path),
  mkdir: (path, mode) => {
    mkdirSync(path, { mode });
  },
  open: (path, flags, mode) => openSync(path, flags, mode),
  fstat: (fd) => fstatSync(fd),
  write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
  link: (existingPath, newPath) => linkSync(existingPath, newPath),
  unlink: (path) => unlinkSync(path),
  rmdir: (path) => rmdirSync(path),
  readdir: (path) => readdirSync(path),
};

// Node opens every descriptor close-on-exec already.
const CREATE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;
const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export type CredentialFile = { name: string; content: string };

export type WriteResult =
  | { ok: true }
  | {
      ok: false;
      code: CiCredentialStepCode;
      // A system error code (EACCES, ENOSPC, ...), never a message.
      detail?: string;
      // What failure cleanup did: nothing was created, everything created
      // was removed, or something created had to be left in place.
      cleanup: "nothing-created" | "complete" | "incomplete";
    };

class StepFailure extends Error {
  constructor(
    readonly code: CiCredentialStepCode,
    readonly detail?: string,
  ) {
    super(code);
  }
}

function fail(code: CiCredentialStepCode, error?: unknown): never {
  throw new StepFailure(
    code,
    error === undefined ? undefined : errorKind(error),
  );
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

// What this invocation created, newest last, for failure cleanup.
type Created =
  | { kind: "directory"; path: string; identity: Identity }
  | { kind: "file"; path: string; identity: Identity };

// Writes the files into a new private directory under runnerTemp (a path
// checkCiRunner already validated). On failure, removes what it created.
export function writeCiCredentialFiles(
  runnerTemp: string,
  files: readonly CredentialFile[],
  uid: number,
  fs: CredentialFileSystem = nodeCredentialFileSystem,
): WriteResult {
  const directory = `${runnerTemp}/${CI_CREDENTIAL_DIRECTORY}`;
  const created: Created[] = [];
  // Set when something was created that can't be identified, so cleanup
  // must leave it.
  let unidentified = false;

  const checkDirectory = (identity: Identity, code: CiCredentialStepCode) => {
    let entry: EntryStats;
    try {
      entry = fs.lstat(directory);
    } catch (error) {
      fail(code, error);
    }
    if (
      !sameIdentity(entry, identity) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      entry.uid !== uid ||
      (entry.mode & PERMISSION_BITS) !== DIRECTORY_MODE
    ) {
      fail(code);
    }
  };

  try {
    // 1. The directory: new (not recursive, so an existing one fails), then
    // identified.
    try {
      fs.mkdir(directory, DIRECTORY_MODE);
    } catch (error) {
      fail(
        errorCode(error) === "EEXIST"
          ? "DIRECTORY_EXISTS"
          : "DIRECTORY_CREATE_FAILED",
        error,
      );
    }
    let directoryEntry: EntryStats;
    try {
      directoryEntry = fs.lstat(directory);
    } catch (error) {
      unidentified = true;
      fail("DIRECTORY_UNSAFE", error);
    }
    if (
      !directoryEntry.isDirectory() ||
      directoryEntry.isSymbolicLink() ||
      directoryEntry.uid !== uid ||
      (directoryEntry.mode & PERMISSION_BITS) !== DIRECTORY_MODE
    ) {
      // Not provably the directory just made: leave it alone.
      unidentified = true;
      fail("DIRECTORY_UNSAFE");
    }
    const directoryIdentity: Identity = {
      dev: directoryEntry.dev,
      ino: directoryEntry.ino,
    };
    created.push({
      kind: "directory",
      path: directory,
      identity: directoryIdentity,
    });

    // 2. Each file.
    for (const file of files) {
      checkDirectory(directoryIdentity, "DIRECTORY_REPLACED");
      publishFile(directory, file, uid, fs, created, () => {
        unidentified = true;
      });
    }

    // 3. Exactly the expected files, in the same directory, synced.
    checkDirectory(directoryIdentity, "DIRECTORY_REPLACED");
    let names: string[];
    try {
      names = fs.readdir(directory);
    } catch (error) {
      fail("DIRECTORY_CONTENTS_UNEXPECTED", error);
    }
    const expected = files.map((file) => file.name).sort();
    if (names.slice().sort().join("/") !== expected.join("/")) {
      fail("DIRECTORY_CONTENTS_UNEXPECTED");
    }
    syncDirectory(directory, directoryIdentity, fs);
    return { ok: true };
  } catch (error) {
    const failure =
      error instanceof StepFailure ? error : new StepFailure("PUBLISH_FAILED");
    const cleanedUp = cleanUp(created, fs);
    return {
      ok: false,
      code: failure.code,
      ...(failure.detail ? { detail: failure.detail } : {}),
      cleanup:
        created.length === 0 && !unidentified
          ? "nothing-created"
          : cleanedUp && !unidentified
            ? "complete"
            : "incomplete",
    };
  }
}

function publishFile(
  directory: string,
  file: CredentialFile,
  uid: number,
  fs: CredentialFileSystem,
  created: Created[],
  markUnidentified: () => void,
): void {
  const partial = `${directory}/.${file.name}.partial`;
  const final = `${directory}/${file.name}`;
  const bytes = Buffer.from(file.content, "utf8");
  let fd: number | undefined;
  try {
    try {
      fd = fs.open(partial, CREATE_FLAGS, FILE_MODE);
    } catch (error) {
      fail(
        errorCode(error) === "EEXIST" ? "PARTIAL_EXISTS" : "FILE_CREATE_FAILED",
        error,
      );
    }
    let opened: EntryStats;
    try {
      opened = fs.fstat(fd);
    } catch (error) {
      markUnidentified();
      fail("FILE_UNSAFE", error);
    }
    const identity: Identity = { dev: opened.dev, ino: opened.ino };
    created.push({ kind: "file", path: partial, identity });
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.uid !== uid ||
      (opened.mode & PERMISSION_BITS) !== FILE_MODE ||
      opened.size !== 0
    ) {
      fail("FILE_UNSAFE");
    }

    // Every byte, however many calls it takes; no progress is a failure.
    let offset = 0;
    while (offset < bytes.length) {
      let written: number;
      try {
        written = fs.write(fd, bytes, offset, bytes.length - offset);
      } catch (error) {
        fail("WRITE_FAILED", error);
      }
      if (
        !Number.isInteger(written) ||
        written <= 0 ||
        written > bytes.length - offset
      ) {
        fail("WRITE_FAILED");
      }
      offset += written;
    }
    try {
      fs.fsync(fd);
    } catch (error) {
      fail("FSYNC_FAILED", error);
    }
    const synced = safeFstat(fs, fd, "WRITE_INCOMPLETE");
    if (!sameIdentity(synced, identity) || synced.size !== bytes.length) {
      fail("WRITE_INCOMPLETE");
    }

    // The temporary name must still be this file before it's published.
    expectEntry(fs, partial, identity, "FILE_REPLACED");

    // Publish without replacement: link(2) fails with EEXIST instead of
    // replacing a destination, unlike rename(2).
    try {
      fs.link(partial, final);
    } catch (error) {
      fail(
        errorCode(error) === "EEXIST" ? "DESTINATION_EXISTS" : "PUBLISH_FAILED",
        error,
      );
    }
    created.push({ kind: "file", path: final, identity });
    // Remove the temporary name only while it's still this file.
    expectEntry(fs, partial, identity, "FILE_REPLACED");
    try {
      fs.unlink(partial);
    } catch (error) {
      fail("PUBLISH_FAILED", error);
    }
    created.splice(
      created.findIndex((entry) => entry.path === partial),
      1,
    );

    // Exactly one name left (no extra hard link), and it's the final one.
    const published = safeFstat(fs, fd, "PUBLISH_VERIFY_FAILED");
    if (!sameIdentity(published, identity) || published.nlink !== 1) {
      fail("PUBLISH_VERIFY_FAILED");
    }
    expectEntry(fs, final, identity, "PUBLISH_VERIFY_FAILED");

    const closing = fd;
    fd = undefined;
    try {
      fs.close(closing);
    } catch (error) {
      fail("CLOSE_FAILED", error);
    }
  } finally {
    bytes.fill(0);
    if (fd !== undefined) {
      try {
        fs.close(fd);
      } catch {
        // Already failing; the original code is the one reported.
      }
    }
  }
}

function safeFstat(
  fs: CredentialFileSystem,
  fd: number,
  code: CiCredentialStepCode,
): EntryStats {
  try {
    return fs.fstat(fd);
  } catch (error) {
    fail(code, error);
  }
}

// The path is a regular file (not a link) with this identity.
function expectEntry(
  fs: CredentialFileSystem,
  path: string,
  identity: Identity,
  code: CiCredentialStepCode,
): void {
  let entry: EntryStats;
  try {
    entry = fs.lstat(path);
  } catch (error) {
    fail(code, error);
  }
  if (
    !sameIdentity(entry, identity) ||
    !entry.isFile() ||
    entry.isSymbolicLink()
  ) {
    fail(code);
  }
}

function syncDirectory(
  directory: string,
  identity: Identity,
  fs: CredentialFileSystem,
): void {
  let fd: number;
  try {
    fd = fs.open(directory, DIRECTORY_FLAGS, 0);
  } catch (error) {
    fail("DIRECTORY_SYNC_FAILED", error);
  }
  try {
    const entry = fs.fstat(fd);
    if (!sameIdentity(entry, identity) || !entry.isDirectory()) {
      fail("DIRECTORY_REPLACED");
    }
    fs.fsync(fd);
  } catch (error) {
    if (error instanceof StepFailure) throw error;
    fail("DIRECTORY_SYNC_FAILED", error);
  } finally {
    try {
      fs.close(fd);
    } catch {
      // Nothing more to do; the directory's contents are already checked.
    }
  }
}

// Removes, newest first, only entries that are still exactly what this
// invocation created. Returns false if anything had to be left.
function cleanUp(
  created: readonly Created[],
  fs: CredentialFileSystem,
): boolean {
  let complete = true;
  for (const entry of [...created].reverse()) {
    let current: EntryStats;
    try {
      current = fs.lstat(entry.path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      complete = false;
      continue;
    }
    const matches =
      sameIdentity(current, entry.identity) &&
      !current.isSymbolicLink() &&
      (entry.kind === "file" ? current.isFile() : current.isDirectory());
    if (!matches) {
      complete = false;
      continue;
    }
    try {
      if (entry.kind === "file") fs.unlink(entry.path);
      // rmdir, never recursive: anything else inside keeps it in place.
      else fs.rmdir(entry.path);
    } catch {
      complete = false;
    }
  }
  return complete;
}

// ---------------------------------------------------------------------------
// The step

export type CiCredentialStepOptions = {
  env: DatabaseEnv;
  // Defaults to the real process, file system, random source, and stdout.
  platform?: NodeJS.Platform;
  uid?: number | undefined;
  fs?: CredentialFileSystem;
  random?: RandomSource;
  write?: (text: string) => void;
};

// All of it, on file descriptor 1, before returning.
export function writeStdout(text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(1, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("stdout made no progress");
    offset += written;
  }
}

function describeStepCode(code: CiCredentialStepCode): string {
  return `${code}: ${CI_CREDENTIAL_STEP_CODES[code]}`;
}

// Returns the exit code: 0 when both files were written, 1 otherwise.
export function runCiCredentialStep(options: CiCredentialStepOptions): number {
  const {
    env,
    platform = process.platform,
    fs = nodeCredentialFileSystem,
    random,
    write = writeStdout,
  } = options;
  const uid = "uid" in options ? options.uid : process.getuid?.();
  const report = (text: string) => {
    try {
      write(text);
    } catch {
      // The exit code still says it failed.
    }
  };

  // 1. Where this runs, before any randomness is drawn.
  const runner = checkCiRunner(env, {
    platform,
    uid,
    lstat: fs.lstat,
    realpath: fs.realpath,
  });
  const postgresSet = Object.keys(env).some(
    (name) => POSTGRES_VARIABLE.test(name) && env[name] !== undefined,
  );
  if (!runner.ok || postgresSet || typeof uid !== "number") {
    const lines = [
      ...(runner.ok ? [] : [describeCiRunnerCodes(runner.codes)]),
      ...(postgresSet ? [describeStepCode("POSTGRES_VARIABLE_SET")] : []),
    ];
    report(`FAIL  CI credential step refused\n${lines.join("\n")}\n`);
    return 1;
  }

  // 2. The credentials, in memory.
  let credentials: CiCredentials;
  try {
    credentials = CiCredentials.create({ random });
  } catch (error) {
    const detail =
      error instanceof CiCredentialError ? error.code : "unknown error";
    report(`FAIL  ${describeStepCode("CREDENTIALS_FAILED")} (${detail})\n`);
    return 1;
  }

  // 3. The masks, before anything else is written anywhere.
  try {
    write(credentials.maskCommands().join(""));
  } catch {
    report(`FAIL  ${describeStepCode("MASK_OUTPUT_FAILED")}\n`);
    return 1;
  }

  // 4. The files.
  const result = writeCiCredentialFiles(
    runner.runnerTemp,
    [
      {
        name: CI_CREDENTIAL_FILES.testDatabaseUrl,
        content: credentials.testDatabaseUrl,
      },
      {
        name: CI_CREDENTIAL_FILES.testRoleVerifier,
        content: credentials.verifier,
      },
    ],
    uid,
    fs,
  );
  if (!result.ok) {
    report(
      `FAIL  ${describeStepCode(result.code)}${result.detail ? ` (${result.detail})` : ""}\n` +
        `      cleanup: ${result.cleanup}\n`,
    );
    return 1;
  }
  report(
    `PASS  CI test database credentials written (${CI_CREDENTIAL_DIRECTORY}: ${CI_CREDENTIAL_FILES.testDatabaseUrl}, ${CI_CREDENTIAL_FILES.testRoleVerifier})\n`,
  );
  return 0;
}
