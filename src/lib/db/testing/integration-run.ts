// One integration test run against the local test database (Step 5D).
//
// startIntegrationRun (from the Vitest globalSetup, in the main process):
//   1. checks the migration files and the configuration before connecting
//      (exactly ai_spec_studio_test@<loopback>:5432/ai_spec_studio_test)
//   2. opens ONE dedicated connection and, read-only, checks the server,
//      role, label, privileges, and that the database has exactly every
//      approved migration applied, with every table empty
//   3. takes the test-database advisory lock on that connection and keeps it
//      (and the connection) for the whole run
//   4. checks the same again while holding the lock
// finish (the globalSetup teardown, after every test file):
//   5. read-only: every table still empty, the journal unchanged, and this
//      connection still holds the lock (no one else does)
//   6. releases the lock, the connection, and the pool, and throws if
//      anything failed, so the run fails. Rows are reported, never deleted.
//
// Errors carry fixed PASS/FAIL labels with codes only.
import type { PoolClient } from "pg";
import {
  errorKind,
  formatResults,
  type CheckResult,
  type PoolFactory,
} from "../../../../scripts/db/lib/live-verification";
import {
  APPROVED_MIGRATIONS,
  QUERIES,
  checkMigrationFiles,
  expectedStructure,
  type Check,
  type MigrationFiles,
} from "../../../../scripts/db/lib/migration-checks";
import {
  LOCK_QUERIES,
  LOCK_VALUES,
  checkTestDatabase,
  checkTestDatabaseConfiguration,
  emptyTables,
  rowCountsQuery,
} from "../../../../scripts/db/lib/test-database-target";
import { buildPoolConfig } from "../pool-config";
import type { DatabaseConnection, DatabaseEnv } from "../env";

// The only setting workers receive (through Vitest's provide/inject, never
// the environment): the validated test-database connection.
export type TestDatabaseConnection = DatabaseConnection;

export const INTEGRATION_OPT_IN = "AI_SPEC_STUDIO_INTEGRATION";

// Variables the integration process must not keep: workers inherit the main
// process's environment, and none of them may reach another database.
export const DATABASE_VARIABLES = [
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "TEST_DATABASE_URL",
  "DATABASE_SSL_MODE",
  "DATABASE_SSL_CA",
  "DATABASE_POOL_MAX",
] as const;

export class IntegrationRunError extends Error {
  override name = "IntegrationRunError";
  constructor(
    readonly phase: "setup" | "teardown",
    readonly results: CheckResult[],
  ) {
    super(
      `The integration test ${phase} failed. Nothing was changed or cleaned up; review the database state.\n${formatResults(results)}`,
    );
  }
}

// The run must be asked for explicitly (npm run test:integration sets it),
// so a bare `vitest` can't start it by accident.
export function requireIntegrationOptIn(env: DatabaseEnv): void {
  if (env[INTEGRATION_OPT_IN] !== "1") {
    throw new Error(
      `Integration tests run only through npm run test:integration (${INTEGRATION_OPT_IN}=1).`,
    );
  }
}

// The settings for this run: .env.local's values, with the shell's taking
// precedence (as process.loadEnvFile does), without writing anything to
// process.env.
export function mergeIntegrationEnvironment(
  fileValues: Readonly<Record<string, string>>,
  processEnv: DatabaseEnv,
): DatabaseEnv {
  return { ...fileValues, ...processEnv };
}

// Removes every database variable from the main process's environment, so
// worker processes (which inherit it) can't see any database URL.
export function isolateIntegrationEnvironment(
  processEnv: Record<string, string | undefined>,
): void {
  for (const name of DATABASE_VARIABLES) delete processEnv[name];
}

// For each worker (setupFiles): no database URL or PG* variable may be
// visible; the test connection comes only through inject().
export function assertWorkerEnvironment(env: DatabaseEnv): void {
  const present = Object.keys(env).filter(
    (name) =>
      env[name] !== undefined &&
      ((DATABASE_VARIABLES as readonly string[]).includes(name) ||
        /^PG[A-Z_]*$/.test(name)),
  );
  if (present.length > 0) {
    throw new Error(
      `Integration test workers must not see database settings in the environment (set: ${present.sort().join(", ")}).`,
    );
  }
}

export type IntegrationRun = {
  connection: TestDatabaseConnection;
  finish: () => Promise<void>;
};

export async function startIntegrationRun(
  env: DatabaseEnv,
  createPool: PoolFactory,
  files: MigrationFiles,
): Promise<IntegrationRun> {
  const results: CheckResult[] = [];
  const check: Check = (pass, label, detail) =>
    results.push(
      detail === undefined ? { pass, label } : { pass, label, detail },
    );
  const failed = () => results.some((result) => !result.pass);

  checkMigrationFiles(files, check);
  const connection = checkTestDatabaseConfiguration(env, check);
  const config = connection ? buildPoolConfig(connection, 1) : undefined;
  if (failed() || !connection || !config?.ok) {
    check(false, "connection skipped (a check above failed)");
    throw new IntegrationRunError("setup", results);
  }

  const pool = createPool({ ...config.value, max: 1, allowExitOnIdle: false });
  let connectionError: unknown;
  pool.on("error", (error) => {
    // An idle-client error on the lock connection means the lock may be
    // gone; finish() reports it.
    connectionError = error;
  });
  let client: PoolClient | undefined;
  let locked = false;

  const readOnly = async (
    session: PoolClient,
    run: () => Promise<void>,
  ): Promise<void> => {
    await session.query(QUERIES.begin);
    try {
      await run();
    } finally {
      await session.query(QUERIES.rollback);
    }
  };

  const close = async (into: Check) => {
    if (locked && client) {
      try {
        const released = (await client.query(LOCK_QUERIES.unlock, LOCK_VALUES))
          .rows[0]?.released;
        into(released === true, "lock: released");
      } catch (error) {
        into(false, "lock: released", `(${errorKind(error)})`);
      }
      locked = false;
    }
    try {
      client?.release();
    } catch (error) {
      into(false, "lock connection released", `(${errorKind(error)})`);
    }
    client = undefined;
    try {
      await pool.end();
      into(pool.totalCount === 0, "pool closed");
    } catch (error) {
      into(false, "pool closed", `(${errorKind(error)})`);
    }
  };

  try {
    client = await pool.connect();
    check(true, "connected as the test role (the lock connection)");
    const session = client;
    const prefixed =
      (phase: string): Check =>
      (pass, label, detail) =>
        check(pass, `${phase}: ${label}`, detail);

    let state = "";
    await readOnly(session, async () => {
      state = (await checkTestDatabase(session, prefixed("before"))).state;
    });
    check(
      state === "applied" && !failed(),
      "before: the test database has exactly every approved migration, with empty tables",
    );
    if (failed()) throw new IntegrationRunError("setup", results);

    const acquired = (await session.query(LOCK_QUERIES.tryLock, LOCK_VALUES))
      .rows[0]?.acquired;
    if (acquired !== true) {
      check(
        false,
        "lock: held by another session (a migration or test run is in progress)",
      );
      throw new IntegrationRunError("setup", results);
    }
    locked = true;
    check(true, "lock: acquired; held on this connection for the whole run");

    await readOnly(session, async () => {
      state = (
        await checkTestDatabase(session, prefixed("locked"), {
          lockHeldBySelf: true,
        })
      ).state;
    });
    check(
      state === "applied" && !failed(),
      "locked: the test database has exactly every approved migration, with empty tables",
    );
    if (failed()) throw new IntegrationRunError("setup", results);
  } catch (error) {
    if (!(error instanceof IntegrationRunError)) {
      check(false, "setup could not finish", `(${errorKind(error)})`);
    }
    await close(check);
    throw new IntegrationRunError("setup", results);
  }

  const tables = expectedStructure(APPROVED_MIGRATIONS.length).tables;
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    const teardown: CheckResult[] = [];
    const record: Check = (pass, label, detail) =>
      teardown.push(
        detail === undefined ? { pass, label } : { pass, label, detail },
      );
    record(
      connectionError === undefined,
      "the lock connection stayed healthy during the run",
      connectionError === undefined
        ? undefined
        : `(${errorKind(connectionError)})`,
    );
    const session = client;
    if (session) {
      try {
        await readOnly(session, async () => {
          const counts =
            (await session.query(rowCountsQuery(tables))).rows[0] ?? {};
          const { empty, detail } = emptyTables(counts, tables);
          record(
            empty,
            `after: all ${tables.length} tables are still empty (no test left rows behind)`,
            empty ? undefined : detail,
          );
          const journal = (await session.query(QUERIES.journal)).rows;
          record(
            journal.length === APPROVED_MIGRATIONS.length &&
              APPROVED_MIGRATIONS.every(
                (m, i) =>
                  journal[i]?.hash === m.sha256 &&
                  journal[i]?.created_at === String(m.when),
              ),
            "after: the migration journal is unchanged",
          );
          const lock =
            (await session.query(LOCK_QUERIES.holdersWhileLocked, LOCK_VALUES))
              .rows[0] ?? {};
          record(
            lock.mine === 1 && lock.others === 0,
            "after: this connection still holds the advisory lock, and no other does",
          );
        });
      } catch (error) {
        record(
          false,
          "after: checks could not finish",
          `(${errorKind(error)})`,
        );
      }
    }
    await close(record);
    if (teardown.some((result) => !result.pass)) {
      throw new IntegrationRunError("teardown", teardown);
    }
  };

  return { connection, finish };
}
