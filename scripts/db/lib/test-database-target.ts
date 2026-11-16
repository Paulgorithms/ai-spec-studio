// The local test database: its exact target, the configuration checks that
// run before any connection, the advisory lock shared by the test-database
// migration and the integration tests, and the read-only preflight
// (scripts/db/test-database-check.ts).
//
// Only TEST_DATABASE_URL is used, as ai_spec_studio_test. DATABASE_URL and
// DATABASE_MIGRATION_URL are only read to prove they name other databases.
// Output is fixed PASS/FAIL labels with codes; nothing here prints a URL,
// password, or driver message, and nothing writes to the database.
import type { Pool, PoolClient } from "pg";
import {
  isLoopbackHost,
  parseTestDatabaseEnv,
  type DatabaseConnection,
  type DatabaseEnv,
} from "../../../src/lib/db/env";
import {
  buildPoolConfig,
  checkPgEnvironment,
} from "../../../src/lib/db/pool-config";
import {
  configurationCodes,
  errorKind,
  type CheckResult,
  type PoolFactory,
} from "./live-verification";
import {
  APPROVED_MIGRATION,
  LOCAL_PORT,
  QUERIES,
  UNEXPECTED_VARIABLES,
  checkRegexCases,
  checkSchemas,
  checkSessionIdentity,
  checkStructure,
  rows,
  type Check,
  type MigrationFiles,
  type SessionProfile,
} from "./migration-checks";

export const TEST_DATABASE_TARGET = {
  user: "ai_spec_studio_test",
  database: "ai_spec_studio_test",
  port: LOCAL_PORT,
} as const;

export const TEST_PROFILE: SessionProfile = {
  role: TEST_DATABASE_TARGET.user,
  database: TEST_DATABASE_TARGET.database,
  environmentLabel: "test",
};

const OTHER_PROJECT_ROLES = ["ai_spec_studio_app", "ai_spec_studio_migrator"];

// ---------------------------------------------------------------------------
// Advisory lock
//
// One fixed, project-specific key: the two-int4 form (classid, objid), so it
// can't collide with single-bigint advisory locks other tools use. classid is
// "AISS" in ASCII (0x41495353); objid 1 means "the test database". The
// test-database migration and the integration test run both take this lock,
// so they exclude each other and themselves.
//
// It's a SESSION-level lock: PostgreSQL ties it to one backend connection.
// So it must be taken and released on the same dedicated PoolClient, never
// through pool.query() (which may use a different connection each time), and
// that client must not go back to the pool while it holds the lock. If the
// connection or process dies, PostgreSQL releases the lock itself. It
// survives COMMIT and ROLLBACK, so it covers transactions run on that client.
export const TEST_DATABASE_LOCK = {
  classId: 0x41495353,
  objectId: 1,
} as const;

export const LOCK_VALUES = [
  TEST_DATABASE_LOCK.classId,
  TEST_DATABASE_LOCK.objectId,
];

export const LOCK_QUERIES = {
  tryLock: `/* try_lock */
SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired`,
  unlock: `/* unlock */
SELECT pg_advisory_unlock($1::int, $2::int) AS released`,
  // Read-only: who holds it now, without taking it. The two-int4 form is
  // stored with objsubid 2.
  holders: `/* lock_holders */
SELECT count(*)::int AS holders
FROM pg_locks
WHERE locktype = 'advisory'
  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND classid = $1::oid AND objid = $2::oid AND objsubid = 2`,
  // Read-only, for a session that has taken the lock: how many granted holds
  // are this session's and how many belong to others.
  holdersWhileLocked: `/* lock_holders_while_locked */
SELECT count(*) FILTER (WHERE pid = pg_backend_pid())::int AS mine,
       count(*) FILTER (WHERE pid <> pg_backend_pid())::int AS others
FROM pg_locks
WHERE locktype = 'advisory' AND granted
  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND classid = $1::oid AND objid = $2::oid AND objsubid = 2`,
} as const;

export type LockClient = Pick<PoolClient, "query">;

export type LockOutcome<T> =
  { acquired: false } | { acquired: true; value: T; released: boolean };

// Runs fn while holding the test-database lock on `client`'s session.
// - Not available (held elsewhere): fn doesn't run; { acquired: false }.
// - Acquisition query fails: the error propagates; fn doesn't run.
// - fn completes: the lock is released; `released` reports PostgreSQL's
//   answer (false would mean this session didn't hold it).
// - fn throws: the lock is still released, then fn's error is rethrown. If the
//   release also fails, fn's error wins; PostgreSQL drops the lock when the
//   session ends.
export async function withTestDatabaseLock<T>(
  client: LockClient,
  fn: () => Promise<T>,
): Promise<LockOutcome<T>> {
  const { rows: lockRows } = await client.query(
    LOCK_QUERIES.tryLock,
    LOCK_VALUES,
  );
  if (lockRows[0]?.acquired !== true) return { acquired: false };

  let value: T;
  try {
    value = await fn();
  } catch (error) {
    try {
      await client.query(LOCK_QUERIES.unlock, LOCK_VALUES);
    } catch {
      // Keep fn's error; the lock ends with the session.
    }
    throw error;
  }
  const { rows: unlockRows } = await client.query(
    LOCK_QUERIES.unlock,
    LOCK_VALUES,
  );
  return { acquired: true, value, released: unlockRows[0]?.released === true };
}

// ---------------------------------------------------------------------------
// Configuration checks (before any connection)

// Database name in a URL, or undefined if the URL can't be read.
function databaseName(raw: string): string | undefined {
  try {
    return decodeURIComponent(new URL(raw).pathname.replace(/^\//, ""));
  } catch {
    return undefined;
  }
}

// Reports each check through `check` and returns the validated connection
// only if every check passed. Fails closed: anything missing, unreadable, or
// unexpected means no connection.
export function checkTestDatabaseConfiguration(
  env: DatabaseEnv,
  check: Check,
): DatabaseConnection | undefined {
  let ok = true;
  const report: Check = (pass, label, detail) => {
    if (!pass) ok = false;
    check(pass, label, detail);
  };

  const unexpected = Object.keys(env).filter(
    (name) => UNEXPECTED_VARIABLES.test(name) && env[name] !== undefined,
  );
  report(
    unexpected.length === 0,
    "environment: no PG*, NODE_TLS_REJECT_UNAUTHORIZED, or NODE_EXTRA_CA_CERTS variables",
    unexpected.length > 0 ? `set: ${unexpected.sort().join(", ")}` : undefined,
  );
  report(
    checkPgEnvironment(env).length === 0,
    "environment: no PGBINARY or PGREPLICATION",
  );
  // The test database never uses TLS; any TLS setting would be ambiguous.
  const sslMode = env.DATABASE_SSL_MODE?.trim();
  report(
    (!sslMode || sslMode === "disable") && !env.DATABASE_SSL_CA?.trim(),
    "environment: no TLS settings (DATABASE_SSL_MODE unset or disable, no DATABASE_SSL_CA)",
  );
  report(
    env.NODE_ENV !== "production",
    "environment: NODE_ENV is not production",
  );

  const parsed = parseTestDatabaseEnv(env);
  if (!parsed.ok) {
    report(
      false,
      "target: TEST_DATABASE_URL passes the project validator",
      `(${configurationCodes(parsed.errors)})`,
    );
  }
  const connection = parsed.ok ? parsed.value.connection : undefined;
  if (connection) {
    report(
      connection.user === TEST_DATABASE_TARGET.user &&
        connection.database === TEST_DATABASE_TARGET.database &&
        connection.port === TEST_DATABASE_TARGET.port &&
        isLoopbackHost(connection.host) &&
        connection.ssl === false,
      `target: TEST_DATABASE_URL is ${TEST_DATABASE_TARGET.user} on loopback port ${TEST_DATABASE_TARGET.port}, database ${TEST_DATABASE_TARGET.database}, TLS off`,
    );
  }

  // Independent of the validator: the other two URLs, when set, must be
  // readable and must name other databases.
  const others = (["DATABASE_URL", "DATABASE_MIGRATION_URL"] as const).flatMap(
    (name) => {
      const raw = env[name]?.trim();
      return raw ? [databaseName(raw)] : [];
    },
  );
  report(
    others.every(
      (name) =>
        name !== undefined &&
        name !== "" &&
        name !== TEST_DATABASE_TARGET.database,
    ),
    "target: DATABASE_URL and DATABASE_MIGRATION_URL (when set) are readable and name other databases",
  );

  return ok ? connection : undefined;
}

// ---------------------------------------------------------------------------
// The read-only preflight

export const TEST_QUERIES = {
  memberships: `/* memberships */
SELECT count(*)::int AS memberships
FROM pg_auth_members AS m
WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
  journalOwner: `/* journal_owner */
SELECT pg_get_userbyid(n.nspowner)::text AS schema_owner,
       pg_get_userbyid(c.relowner)::text AS table_owner
FROM pg_namespace AS n
JOIN pg_class AS c ON c.relnamespace = n.oid AND c.relname = '__drizzle_migrations'
WHERE n.nspname = 'drizzle'`,
  rowCounts: `/* row_counts */
SELECT (SELECT count(*)::int FROM public.projects) AS projects,
       (SELECT count(*)::int FROM public.specifications) AS specifications`,
  foreignGrants: `/* foreign_grants */
SELECT t.name AS table_name,
       has_table_privilege($1::name, t.qualified, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS app_any,
       has_table_privilege($2::name, t.qualified, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS migrator_any,
       has_table_privilege('public', t.qualified, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS public_any
FROM (VALUES ('projects', 'public.projects'), ('specifications', 'public.specifications'))
  AS t (name, qualified)
ORDER BY 1`,
} as const;

export type TestDatabaseState = "fresh" | "applied" | "unexpected";

export type PreflightOutcome = {
  results: CheckResult[];
  state: TestDatabaseState | undefined;
};

export async function runTestDatabasePreflight(
  env: DatabaseEnv,
  createPool: PoolFactory,
  files: MigrationFiles,
): Promise<PreflightOutcome> {
  const results: CheckResult[] = [];
  const check: Check = (pass, label, detail) =>
    results.push(
      detail === undefined ? { pass, label } : { pass, label, detail },
    );

  check(
    files.journalEntries === 1 && files.tag === APPROVED_MIGRATION.tag,
    `files: the journal has exactly one entry, ${APPROVED_MIGRATION.tag}`,
  );
  check(
    files.sha256 === APPROVED_MIGRATION.sha256,
    `files: ${APPROVED_MIGRATION.tag}.sql matches the reviewed SHA-256`,
  );
  const connection = checkTestDatabaseConfiguration(env, check);
  if (results.some((result) => !result.pass) || !connection) {
    check(false, "connection skipped (a check above failed)");
    return { results, state: undefined };
  }

  const config = buildPoolConfig(connection, 1);
  if (!config.ok) {
    check(
      false,
      "pool configuration",
      `(${configurationCodes(config.errors)})`,
    );
    return { results, state: undefined };
  }

  let state: TestDatabaseState | undefined;
  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  try {
    pool = createPool({ ...config.value, max: 1, allowExitOnIdle: true });
    pool.on("error", () => {
      // Reported through the failing call; never log the driver message.
    });
    client = await pool.connect();
    check(true, "connected as the test role");
    await client.query(QUERIES.begin);
    try {
      state = await checkTestDatabase(client, files, check);
    } finally {
      await client.query(QUERIES.rollback);
    }
  } catch (error) {
    check(false, "checks could not finish", `(${errorKind(error)})`);
    state = undefined;
  } finally {
    try {
      client?.release();
    } catch {
      // Already released or broken; ending the pool cleans up.
    }
    if (pool) {
      try {
        await pool.end();
        check(pool.totalCount === 0, "pool closed");
      } catch (error) {
        check(false, "pool closed", `(${errorKind(error)})`);
      }
    }
  }
  return { results, state };
}

// The connected checks, on one client inside a read-only transaction the
// caller opened. `lockHeldBySelf` is for a session that holds the
// test-database lock (the migration runner): the lock check then requires
// that this session, and no other, holds it.
export async function checkTestDatabase(
  client: PoolClient,
  files: MigrationFiles,
  check: Check,
  options: { lockHeldBySelf?: boolean } = {},
): Promise<TestDatabaseState> {
  const role = TEST_PROFILE.role;
  const database = TEST_PROFILE.database;

  await checkSessionIdentity(client, TEST_PROFILE, check);

  const memberships = (await rows(client, TEST_QUERIES.memberships))[0] ?? {};
  check(
    memberships.memberships === 0,
    "role: not a member of any role (no migrator, app, administrator, or predefined roles)",
  );

  const priv = (await rows(client, QUERIES.privileges))[0] ?? {};
  check(
    priv.create_db === true,
    `privileges: CREATE on database ${database} (for the drizzle schema)`,
  );
  check(
    priv.usage_public === true && priv.create_public === true,
    "privileges: USAGE and CREATE on schema public",
  );

  // State: fresh, exactly the approved migration, or anything else.
  const objects = (await rows(client, QUERIES.objects))[0] ?? {};
  const schemaRows = (await rows(client, QUERIES.schemas)).map(
    (row) => row.name,
  );
  const hasDrizzle = schemaRows.includes("drizzle");
  const fresh =
    !hasDrizzle &&
    objects.journal === false &&
    objects.projects === false &&
    objects.specifications === false &&
    objects.public_relations === 0;
  const looksApplied =
    hasDrizzle &&
    objects.journal === true &&
    objects.projects === true &&
    objects.specifications === true;

  await checkSchemas(
    client,
    TEST_PROFILE,
    fresh ? ["public"] : ["drizzle", "public"],
    check,
  );

  let state: TestDatabaseState;
  if (fresh) {
    check(
      true,
      "state: fresh (no drizzle schema, no migration journal, schema public empty)",
    );
    state = "fresh";
  } else if (looksApplied) {
    // Every check in this branch must pass for the "applied exactly" verdict.
    let appliedOk = true;
    const tracked: Check = (pass, label, detail) => {
      if (!pass) appliedOk = false;
      check(pass, label, detail);
    };
    const journal = await rows(client, QUERIES.journal);
    tracked(
      journal.length === 1 &&
        journal[0]?.hash === files.sha256 &&
        journal[0]?.created_at === String(files.when),
      `journal: exactly one applied migration, with the hash and timestamp of ${APPROVED_MIGRATION.tag}`,
    );
    const owner = (await rows(client, TEST_QUERIES.journalOwner))[0];
    tracked(
      owner?.schema_owner === role && owner.table_owner === role,
      `journal: drizzle schema and __drizzle_migrations owned by ${role}`,
    );
    await checkStructure(client, role, tracked);
    const grants = await rows(client, TEST_QUERIES.foreignGrants, [
      ...OTHER_PROJECT_ROLES,
    ]);
    tracked(
      grants.length === 2 &&
        grants.every(
          (row) =>
            row.app_any === false &&
            row.migrator_any === false &&
            row.public_any === false,
        ),
      "grants: the app role, the migrator, and PUBLIC have no table privileges",
    );
    const counts = (await rows(client, TEST_QUERIES.rowCounts))[0] ?? {};
    tracked(
      counts.projects === 0 && counts.specifications === 0,
      "state: both tables are empty (nothing left by earlier runs)",
    );
    check(
      appliedOk,
      "state: the approved migration is applied exactly",
      appliedOk ? undefined : "(see the failures above)",
    );
    state = appliedOk ? "applied" : "unexpected";
  } else {
    const codes = [
      hasDrizzle ? "DRIZZLE_SCHEMA" : "NO_DRIZZLE_SCHEMA",
      objects.journal === true ? "JOURNAL" : "NO_JOURNAL",
      objects.projects === true ? "PROJECTS" : "NO_PROJECTS",
      objects.specifications === true ? "SPECIFICATIONS" : "NO_SPECIFICATIONS",
      objects.public_relations === 0 ? "PUBLIC_EMPTY" : "PUBLIC_NOT_EMPTY",
    ];
    check(
      false,
      "state: neither fresh nor exactly the approved migration (partial or unexpected)",
      `(${codes.join(", ")})`,
    );
    state = "unexpected";
  }

  const sessions = (await rows(client, QUERIES.sessions))[0] ?? {};
  check(
    sessions.other_migrator_sessions === 0,
    `concurrency: no other session is connected as ${role}`,
  );
  if (options.lockHeldBySelf) {
    const lock =
      (await rows(client, LOCK_QUERIES.holdersWhileLocked, LOCK_VALUES))[0] ??
      {};
    check(
      lock.mine === 1 && lock.others === 0,
      "concurrency: this session holds the test-database advisory lock, and no other session does",
    );
  } else {
    const lock =
      (await rows(client, LOCK_QUERIES.holders, LOCK_VALUES))[0] ?? {};
    check(
      lock.holders === 0,
      "concurrency: the test-database advisory lock is free",
    );
  }

  await checkRegexCases(client, check);
  return state;
}
