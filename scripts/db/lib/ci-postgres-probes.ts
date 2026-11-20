// Negative security checks for the provisioned CI PostgreSQL server (Phase
// 3D). Run by scripts/db/ci-verify-postgres.ts after ci-provision-postgres.sh,
// on the GitHub-hosted runner only.
//
// Order, failing closed at each step:
//   1. checkCiRunner: a GitHub-hosted Linux runner with no database
//      variables set (this reads the URL from its file, not from the
//      environment).
//   2. The credential directory after provisioning: 0700 and owned by this
//      user, holding only test-database-url (the verifier must already be
//      gone), read with O_NOFOLLOW and validated as the approved CI URL.
//   3. Positive identity: the test role connects and checkSessionIdentity
//      passes (PostgreSQL 18, loopback on both ends, port 5432, no TLS,
//      SCRAM-SHA-256, the test label). No probe runs unless this passes, so
//      a refused probe can't be a server that isn't there.
//   4. The probes, one connection attempt each. Every one must fail in
//      exactly the expected way; a success, another SQLSTATE, a timeout, a
//      refused or lost connection, or a DNS error fails the check.
//   5. Positive identity again, so the server stayed up throughout.
//
// What isn't probed, and why: connections from a non-loopback address or
// over IPv6. The runner has no second host to connect from, and the server
// listens only on 127.0.0.1, so such attempts would fail before reaching
// pg_hba.conf and prove nothing about it. Those rules are covered by the
// static tests of scripts/db/ci/pg_hba.conf, ci-setup.sql's check of
// pg_hba_file_rules and listen_addresses, and checkSessionIdentity's
// loopback check of both ends of the session.
//
// NOLOGIN itself can't be reached over TCP either: pg_hba.conf rejects the
// app and migrator roles (28000) before PostgreSQL looks at the role.
// ci-setup.sql's final checks confirm rolcanlogin is false for both.
//
// Output is fixed labels with outcome codes only: never a URL, password,
// verifier, connection setting, or driver message.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { DatabaseError, type Pool, type PoolClient, type PoolConfig } from "pg";
import {
  parseTestDatabaseEnv,
  type DatabaseConnection,
  type DatabaseEnv,
} from "../../../src/lib/db/env";
import { buildPoolConfig } from "../../../src/lib/db/pool-config";
import {
  CI_CREDENTIAL_DIRECTORY,
  CI_CREDENTIAL_FILES,
} from "./ci-credential-files";
import {
  CI_DATABASE_HOST,
  generatePassword,
  isCiPassword,
  type RandomSource,
} from "./ci-credentials";
import { checkCiRunner } from "./ci-runner";
import type { CheckResult, PoolFactory } from "./live-verification";
import { QUERIES, checkSessionIdentity, type Check } from "./migration-checks";
import {
  TEST_DATABASE_TARGET,
  TEST_PROFILE,
  checkTestDatabaseConfiguration,
} from "./test-database-target";

// ---------------------------------------------------------------------------
// Outcomes

// How a connection attempt ended. Only these values are ever reported.
export type ProbeOutcome =
  | "connected"
  | `sqlstate:${string}`
  | "tls_unsupported"
  | "tls_error"
  | "connection_refused"
  | "connection_lost"
  | "timeout"
  | "dns"
  | "unknown";

const SQLSTATE = /^[0-9A-Z]{5}$/;

// Classifies a failed connection by its error code or by node-postgres's
// fixed messages. The message itself is never reported.
//
// A server ErrorResponse is recognized by class, not by name: pg-protocol
// builds it as new DatabaseError(message, length, "error"), so its name is
// the protocol message type ("error"), never "DatabaseError". Only a real
// DatabaseError (pg's own class) with a well-formed SQLSTATE counts as the
// server's answer; one with a malformed code is "unknown".
export function classifyConnectionError(error: unknown): ProbeOutcome {
  if (!error || typeof error !== "object") return "unknown";
  const code =
    "code" in error && typeof error.code === "string" ? error.code : "";
  if (error instanceof DatabaseError) {
    return SQLSTATE.test(code) ? `sqlstate:${code}` : "unknown";
  }
  const message =
    error instanceof Error && typeof error.message === "string"
      ? error.message
      : "";
  if (message === "The server does not support SSL connections") {
    return "tls_unsupported";
  }
  if (message === "There was an error establishing an SSL connection") {
    return "tls_error";
  }
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (
    code === "ETIMEDOUT" ||
    message === "timeout expired" ||
    message === "Connection terminated due to connection timeout"
  ) {
    return "timeout";
  }
  if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    message === "Connection terminated unexpectedly" ||
    message === "Connection terminated"
  ) {
    return "connection_lost";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// The probes

type Credential = "test" | "decoy";

export type Probe = {
  id: string;
  label: string;
  user: string;
  database: string;
  // "test": the real test-role password. "decoy": a random password made
  // for this run and never stored, so no probe can fall back to PGPASSWORD
  // or ~/.pgpass, and no real credential is offered to another role.
  credential: Credential;
  tls: boolean;
  expected: ProbeOutcome;
};

const TEST_ROLE = TEST_DATABASE_TARGET.user;
const TEST_DB = TEST_DATABASE_TARGET.database;

// 28P01 invalid_password: pg_hba.conf matched the test role's rule and
// SCRAM-SHA-256 rejected the password. 28000
// invalid_authorization_specification: pg_hba.conf rejected the connection
// before any password exchange.
export const PROBES: readonly Probe[] = [
  {
    id: "WRONG_PASSWORD",
    label: "a wrong password for the test role is rejected by SCRAM-SHA-256",
    user: TEST_ROLE,
    database: TEST_DB,
    credential: "decoy",
    tls: false,
    expected: "sqlstate:28P01",
  },
  {
    id: "TEST_ROLE_POSTGRES_DB",
    label: "the test role can't connect to the postgres database",
    user: TEST_ROLE,
    database: "postgres",
    credential: "test",
    tls: false,
    expected: "sqlstate:28000",
  },
  {
    id: "TEST_ROLE_TEMPLATE1",
    label: "the test role can't connect to template1",
    user: TEST_ROLE,
    database: "template1",
    credential: "test",
    tls: false,
    expected: "sqlstate:28000",
  },
  {
    id: "TEST_ROLE_DEV_DB",
    label: "the test role can't connect to ai_spec_studio_dev",
    user: TEST_ROLE,
    database: "ai_spec_studio_dev",
    credential: "test",
    tls: false,
    expected: "sqlstate:28000",
  },
  {
    id: "TLS_REQUESTED",
    label: "a TLS connection is refused (the server has ssl = off)",
    user: TEST_ROLE,
    database: TEST_DB,
    credential: "test",
    tls: true,
    expected: "tls_unsupported",
  },
  {
    id: "APP_ROLE",
    label: "ai_spec_studio_app can't log in over TCP",
    user: "ai_spec_studio_app",
    database: TEST_DB,
    credential: "decoy",
    tls: false,
    expected: "sqlstate:28000",
  },
  {
    id: "MIGRATOR_ROLE",
    label: "ai_spec_studio_migrator can't log in over TCP",
    user: "ai_spec_studio_migrator",
    database: TEST_DB,
    credential: "decoy",
    tls: false,
    expected: "sqlstate:28000",
  },
  {
    id: "ADMIN_TCP",
    label: "postgres (the administrator) can't log in over TCP",
    user: "postgres",
    database: "postgres",
    credential: "decoy",
    tls: false,
    expected: "sqlstate:28000",
  },
  {
    id: "ADMIN_TCP_TEST_DB",
    label: "postgres can't log in over TCP to the test database",
    user: "postgres",
    database: TEST_DB,
    credential: "decoy",
    tls: false,
    expected: "sqlstate:28000",
  },
];

// ---------------------------------------------------------------------------
// The URL file

export type ProbeFileSystem = {
  lstat: (
    path: string,
  ) => Pick<
    Stats,
    | "isFile"
    | "isDirectory"
    | "isSymbolicLink"
    | "uid"
    | "mode"
    | "nlink"
    | "size"
    | "dev"
    | "ino"
  >;
  realpath: (path: string) => string;
  readdir: (path: string) => string[];
  open: (path: string, flags: number) => number;
  fstat: (
    fd: number,
  ) => Pick<
    Stats,
    "isFile" | "uid" | "mode" | "nlink" | "size" | "dev" | "ino"
  >;
  read: (fd: number, buffer: Buffer, offset: number, length: number) => number;
  close: (fd: number) => void;
};

export const nodeProbeFileSystem: ProbeFileSystem = {
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync(path),
  readdir: (path) => readdirSync(path),
  open: (path, flags) => openSync(path, flags),
  fstat: (fd) => fstatSync(fd),
  read: (fd, buffer, offset, length) =>
    readSync(fd, buffer, offset, length, null),
  close: (fd) => closeSync(fd),
};

const MAX_URL_BYTES = 1024;

export type UrlFileResult =
  { ok: true; connection: DatabaseConnection } | { ok: false; code: string };

// The test-database-url file as ci-credentials.ts wrote it and
// ci-provision-postgres.sh left it: the only entry in its 0700 directory,
// 0600, one link, owned by this user, and exactly the approved CI URL.
export function loadCiTestDatabaseConnection(
  runnerTemp: string,
  uid: number,
  fs: ProbeFileSystem = nodeProbeFileSystem,
): UrlFileResult {
  const directory = `${runnerTemp}/${CI_CREDENTIAL_DIRECTORY}`;
  const file = `${directory}/${CI_CREDENTIAL_FILES.testDatabaseUrl}`;
  try {
    const dir = fs.lstat(directory);
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      dir.uid !== uid ||
      (dir.mode & 0o7777) !== 0o700 ||
      fs.realpath(directory) !== directory
    ) {
      return { ok: false, code: "CREDENTIAL_DIRECTORY" };
    }
  } catch {
    return { ok: false, code: "CREDENTIAL_DIRECTORY" };
  }

  let names: string[];
  try {
    names = fs.readdir(directory);
  } catch {
    return { ok: false, code: "CREDENTIAL_DIRECTORY" };
  }
  if (names.includes(CI_CREDENTIAL_FILES.testRoleVerifier)) {
    return { ok: false, code: "VERIFIER_STILL_PRESENT" };
  }
  if (names.length !== 1 || names[0] !== CI_CREDENTIAL_FILES.testDatabaseUrl) {
    return { ok: false, code: "CREDENTIAL_CONTENTS" };
  }

  let text: string;
  let fd: number | undefined;
  try {
    const entry = fs.lstat(file);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.uid !== uid ||
      (entry.mode & 0o7777) !== 0o600 ||
      entry.nlink !== 1 ||
      entry.size < 1 ||
      entry.size > MAX_URL_BYTES
    ) {
      return { ok: false, code: "URL_FILE_UNSAFE" };
    }
    fd = fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fs.fstat(fd);
    if (
      !opened.isFile() ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino ||
      opened.nlink !== 1 ||
      opened.size !== entry.size
    ) {
      return { ok: false, code: "URL_FILE_UNSAFE" };
    }
    const buffer = Buffer.alloc(entry.size + 1);
    let length = 0;
    for (;;) {
      const read = fs.read(fd, buffer, length, buffer.length - length);
      if (!Number.isInteger(read) || read < 0) {
        return { ok: false, code: "URL_FILE_UNREADABLE" };
      }
      if (read === 0) break;
      length += read;
      if (length > entry.size) return { ok: false, code: "URL_FILE_UNSAFE" };
    }
    if (length !== entry.size) return { ok: false, code: "URL_FILE_UNSAFE" };
    text = buffer.subarray(0, length).toString("utf8");
    buffer.fill(0);
  } catch {
    return { ok: false, code: "URL_FILE_UNREADABLE" };
  } finally {
    if (fd !== undefined) {
      try {
        fs.close(fd);
      } catch {
        // Already read or already failing.
      }
    }
  }

  // Exactly the bytes ci-credentials.ts wrote: printable ASCII with no
  // whitespace (the validators below trim, so check first).
  if (!/^[\x21-\x7e]+$/.test(text)) return { ok: false, code: "URL_INVALID" };

  // Exactly the URL ci-credentials.ts builds, as the project's validators
  // and the CI target see it.
  const env = { TEST_DATABASE_URL: text };
  const parsed = parseTestDatabaseEnv(env);
  let configurationOk = true;
  const checked = checkTestDatabaseConfiguration(env, (pass) => {
    if (!pass) configurationOk = false;
  });
  if (
    !parsed.ok ||
    !configurationOk ||
    checked === undefined ||
    parsed.value.connection.host !== CI_DATABASE_HOST ||
    !isCiPassword(parsed.value.connection.password)
  ) {
    return { ok: false, code: "URL_INVALID" };
  }
  return { ok: true, connection: parsed.value.connection };
}

// ---------------------------------------------------------------------------
// Connecting

// Upper bounds: tests may shorten these, never lengthen them.
export const PROBE_TIMEOUT_MS = 10_000;
export const POOL_END_TIMEOUT_MS = 5_000;

type Timeouts = { probeMs: number; endMs: number };

export function boundedTimeouts(timeouts: Partial<Timeouts> = {}): Timeouts {
  const pick = (value: number | undefined, max: number) =>
    value !== undefined && Number.isInteger(value) && value > 0 && value <= max
      ? value
      : max;
  return {
    probeMs: pick(timeouts.probeMs, PROBE_TIMEOUT_MS),
    endMs: pick(timeouts.endMs, POOL_END_TIMEOUT_MS),
  };
}

const TIMED_OUT = Symbol("timed out");

// Resolves with the promise's value, or TIMED_OUT after `ms`. A late
// rejection is absorbed so it can't surface as an unhandled rejection.
async function within<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Ends the pool within its own bound; a pool that won't end is reported.
async function endPool(pool: Pool, ms: number): Promise<boolean> {
  try {
    const ended = await within(pool.end(), ms);
    return ended !== TIMED_OUT;
  } catch {
    return false;
  }
}

// One pool per attempt (max 1), ended on every path within its own bound.
type Attempt<T> =
  | { kind: "used"; value: T; ended: boolean }
  | { kind: "failed"; outcome: ProbeOutcome; ended: boolean };

async function withConnection<T>(
  createPool: PoolFactory,
  config: PoolConfig,
  timeouts: Timeouts,
  run: (client: PoolClient) => Promise<T>,
): Promise<Attempt<T>> {
  let pool: Pool | undefined;
  let result:
    { kind: "used"; value: T } | { kind: "failed"; outcome: ProbeOutcome };
  try {
    pool = createPool({ ...config, max: 1, allowExitOnIdle: true });
    pool.on("error", () => {
      // Reported through the attempt; never log the driver message.
    });
    const connecting = pool.connect();
    const client = await within(connecting, timeouts.probeMs);
    if (client === TIMED_OUT) {
      // A connection that arrives late is released at once.
      connecting.then(
        (late) => {
          try {
            late.release();
          } catch {
            // Ending the pool closes it either way.
          }
        },
        () => {},
      );
      result = { kind: "failed", outcome: "timeout" };
    } else {
      try {
        result = { kind: "used", value: await run(client) };
      } finally {
        try {
          client.release();
        } catch {
          // Ending the pool closes it either way.
        }
      }
    }
  } catch (error) {
    result = { kind: "failed", outcome: classifyConnectionError(error) };
  }
  const ended = pool ? await endPool(pool, timeouts.endMs) : true;
  return { ...result, ended };
}

// One probe's connection attempt: "connected" if it got a connection (the
// probe then fails), otherwise how it was refused. The pool is always ended;
// `ended` says whether that finished within its bound.
export async function attemptProbe(
  createPool: PoolFactory,
  config: PoolConfig,
  timeouts: Partial<Timeouts> = {},
): Promise<{ outcome: ProbeOutcome; ended: boolean }> {
  const attempt = await withConnection(
    createPool,
    config,
    boundedTimeouts(timeouts),
    () => Promise.resolve(undefined),
  );
  return {
    outcome: attempt.kind === "used" ? "connected" : attempt.outcome,
    ended: attempt.ended,
  };
}

// ---------------------------------------------------------------------------
// Running

export type ProbeRunOptions = {
  env: DatabaseEnv;
  createPool: PoolFactory;
  platform?: NodeJS.Platform;
  uid?: number | undefined;
  fs?: ProbeFileSystem;
  random?: RandomSource;
  timeouts?: Partial<Timeouts>;
};

export type ProbeRun = { results: CheckResult[]; ok: boolean };

export async function runPostgresProbes(
  options: ProbeRunOptions,
): Promise<ProbeRun> {
  const {
    env,
    createPool,
    platform = process.platform,
    fs = nodeProbeFileSystem,
    random,
  } = options;
  const uid = "uid" in options ? options.uid : process.getuid?.();
  const timeouts = boundedTimeouts(options.timeouts);
  const results: CheckResult[] = [];
  const check: Check = (pass, label, detail) =>
    results.push(
      detail === undefined ? { pass, label } : { pass, label, detail },
    );
  const done = (): ProbeRun => ({
    results,
    ok: results.length > 0 && results.every((r) => r.pass),
  });

  // 1. The runner.
  const runner = checkCiRunner(env, {
    platform,
    uid,
    lstat: fs.lstat,
    realpath: fs.realpath,
  });
  if (!runner.ok || typeof uid !== "number") {
    check(
      false,
      "runner: a GitHub-hosted Linux runner with no database variables set",
      runner.ok ? "(UID_UNAVAILABLE)" : `(${runner.codes.join(", ")})`,
    );
    return done();
  }
  check(
    true,
    "runner: a GitHub-hosted Linux runner with no database variables set",
  );

  // 2. The URL file.
  const loaded = loadCiTestDatabaseConnection(runner.runnerTemp, uid, fs);
  check(
    loaded.ok,
    "credentials: only test-database-url remains, and it is the approved CI URL",
    loaded.ok ? undefined : `(${loaded.code})`,
  );
  if (!loaded.ok) return done();
  const base = buildPoolConfig(loaded.connection, 1);
  if (!base.ok) {
    check(false, "credentials: pool configuration");
    return done();
  }

  // 3. Positive identity before any probe.
  const identity = async (phase: "before" | "after") => {
    const label = `identity (${phase} the probes): the test role reaches the intended CI server`;
    let identityOk = true;
    const tracked: Check = (pass, l, detail) => {
      if (!pass) identityOk = false;
      check(pass, `identity (${phase}): ${l}`, detail);
    };
    const attempt = await withConnection(
      createPool,
      base.value,
      timeouts,
      async (client) => {
        await client.query(QUERIES.begin);
        try {
          await checkSessionIdentity(client, TEST_PROFILE, tracked);
        } finally {
          await client.query(QUERIES.rollback);
        }
      },
    );
    if (attempt.kind === "failed") {
      check(false, label, `(${attempt.outcome})`);
      return false;
    }
    if (!attempt.ended)
      check(false, `identity (${phase}): its connection pool was closed`);
    check(identityOk && attempt.ended, label);
    return identityOk && attempt.ended;
  };

  if (!(await identity("before"))) {
    check(false, "probes skipped (the server's identity was not established)");
    return done();
  }

  // 4. The probes.
  let decoy: string;
  try {
    decoy = generatePassword(random);
  } catch {
    check(false, "probes: a decoy password could not be generated");
    return done();
  }
  for (const probe of PROBES) {
    const config: PoolConfig = {
      ...base.value,
      user: probe.user,
      database: probe.database,
      password: probe.credential === "test" ? base.value.password : decoy,
      ssl: probe.tls ? { rejectUnauthorized: true } : false,
    };
    const attempt = await attemptProbe(createPool, config, timeouts);
    const outcome = attempt.outcome;
    check(
      outcome === probe.expected,
      `probe ${probe.id}: ${probe.label} (${probe.expected})`,
      outcome === probe.expected ? undefined : `(got ${outcome})`,
    );
    if (!attempt.ended) {
      check(false, `probe ${probe.id}: its connection pool was closed`);
    }
  }

  // 5. Positive identity again.
  await identity("after");
  return done();
}
