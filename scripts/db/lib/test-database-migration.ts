// Applies the pending approved migrations to the local test database, in
// order (Step 5B-3; extended to the ordered migration list in Task 1.2.3
// Phase 3D).
//
// One dedicated connection, as ai_spec_studio_test, does everything:
//   1. before   read-only checks (as the preflight): files, target, server,
//               role, label, privileges, state, concurrency, regex
//   2. lock     pg_try_advisory_lock on that same connection
//   3. locked   the read-only checks again, while holding the lock
//   4. migrate  only from a verified state: fresh (nothing applied) or
//               partial (exactly the first approved migrations), with
//               drizzle-orm's migrator bound to that same connection. It
//               applies every pending migration in ONE transaction, so a
//               failure leaves the state as it was before. Every approved
//               migration already applied is a no-op.
//   5. after    the read-only checks again: every approved migration, exactly
//   6. unlock, release the client, end the pool (on every path)
//
// Anything else (unexpected, a failed migration, a failed check) stops for
// review. There is no reset, rollback, or cleanup step.
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import type { DatabaseEnv } from "../../../src/lib/db/env";
import { buildPoolConfig } from "../../../src/lib/db/pool-config";
import {
  configurationCodes,
  errorKind,
  type CheckResult,
  type PoolFactory,
} from "./live-verification";
import {
  QUERIES,
  checkMigrationFiles,
  pendingTags,
  type Check,
  type MigrationFiles,
} from "./migration-checks";
import {
  checkTestDatabase,
  checkTestDatabaseConfiguration,
  withTestDatabaseLock,
  type TestDatabaseCheck,
} from "./test-database-target";

export type MigrationOutcome = "migrated" | "up-to-date" | "not-migrated";

// Applies the migrations in drizzle/ on `client`. The default is drizzle-orm's
// own migrator; tests can substitute it.
export type ApplyMigration = (client: PoolClient) => Promise<void>;

// drizzle-orm 0.45.4 (node-postgres session.transaction) checks out a NEW
// connection when its client looks like a pool (`instanceof Pool`, or a
// constructor name containing "Pool"), and otherwise runs begin/commit on
// the client it was given. The migration must stay on the locked session, so
// refuse anything that could be a pool.
export function assertDedicatedClient(
  client: unknown,
): asserts client is PoolClient {
  const name =
    client && typeof client === "object"
      ? (Object.getPrototypeOf(client)?.constructor?.name ?? "")
      : "";
  if (
    !client ||
    typeof client !== "object" ||
    client instanceof Pool ||
    String(name).includes("Pool") ||
    typeof (client as { query?: unknown }).query !== "function" ||
    typeof (client as { release?: unknown }).release !== "function"
  ) {
    throw new TypeError(
      "The migration must run on one checked-out client (the session holding the lock), not a pool.",
    );
  }
}

// drizzle-orm wraps database errors in DrizzleQueryError, whose message
// quotes the query and its parameters; the PostgreSQL error (with the
// SQLSTATE) is its `cause`. Report that code, never a message.
export function migrationErrorKind(error: unknown): string {
  const cause =
    error && typeof error === "object" && "cause" in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  return errorKind(cause ?? error);
}

export const drizzleApplyMigration: ApplyMigration = async (client) => {
  assertDedicatedClient(client);
  await migrate(drizzle({ client }), {
    migrationsFolder: resolve("drizzle"),
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });
};

export async function runTestDatabaseMigration(
  env: DatabaseEnv,
  createPool: PoolFactory,
  files: MigrationFiles,
  applyMigration: ApplyMigration = drizzleApplyMigration,
): Promise<{ results: CheckResult[]; outcome: MigrationOutcome }> {
  const results: CheckResult[] = [];
  const check: Check = (pass, label, detail) =>
    results.push(
      detail === undefined ? { pass, label } : { pass, label, detail },
    );
  const failedSince = (index: number) =>
    results.slice(index).some((result) => !result.pass);
  let outcome: MigrationOutcome = "not-migrated";

  // 0. Before any connection.
  checkMigrationFiles(files, check);
  const connection = checkTestDatabaseConfiguration(env, check);
  if (results.some((result) => !result.pass) || !connection) {
    check(false, "connection skipped (a check above failed)");
    return { results, outcome };
  }
  const config = buildPoolConfig(connection, 1);
  if (!config.ok) {
    check(
      false,
      "pool configuration",
      `(${configurationCodes(config.errors)})`,
    );
    return { results, outcome };
  }

  // Read-only checks on the dedicated client, each phase's labels prefixed.
  const readOnlyChecks = async (
    client: PoolClient,
    phase: string,
    lockHeldBySelf: boolean,
  ): Promise<TestDatabaseCheck | undefined> => {
    const start = results.length;
    const prefixed: Check = (pass, label, detail) =>
      check(pass, `${phase}: ${label}`, detail);
    await client.query(QUERIES.begin);
    let state: TestDatabaseCheck;
    try {
      state = await checkTestDatabase(client, prefixed, { lockHeldBySelf });
    } finally {
      await client.query(QUERIES.rollback);
    }
    return failedSince(start) ? undefined : state;
  };
  const migratable = (found: TestDatabaseCheck | undefined) =>
    found?.state === "fresh" || found?.state === "partial";

  let pool: ReturnType<PoolFactory> | undefined;
  let client: PoolClient | undefined;
  try {
    pool = createPool({ ...config.value, max: 1, allowExitOnIdle: true });
    pool.on("error", () => {
      // Reported through the failing call; never log the driver message.
    });
    client = await pool.connect();
    check(true, "connected as the test role (one dedicated connection)");
    const session = client;

    // 1. Before taking the lock.
    const before = await readOnlyChecks(session, "before", false);
    if (!migratable(before) && before?.state !== "applied") {
      check(false, "stopped before taking the lock (see the failures above)");
      return { results, outcome };
    }

    // 2-5. Under the lock, on the same session.
    const locked = await withTestDatabaseLock(session, async () => {
      check(true, "lock: acquired on this session");
      const state = await readOnlyChecks(session, "locked", true);
      if (state?.state === "applied") {
        check(
          true,
          "migration: not needed (every approved migration is already applied)",
        );
        return "up-to-date" as const;
      }
      if (!migratable(state) || state?.applied === undefined) {
        check(
          false,
          "migration: not run (the state changed or a check failed under the lock)",
        );
        return "not-migrated" as const;
      }

      const pending = pendingTags(state.applied);
      try {
        await applyMigration(session);
      } catch (error) {
        check(
          false,
          "migration: failed; stopped for review (don't rerun it)",
          `(${migrationErrorKind(error)})`,
        );
        // Leave no transaction open on this session, then record the state.
        await session.query(QUERIES.rollback).catch(() => undefined);
        await readOnlyChecks(session, "after failure", true).catch(
          (stateError: unknown) =>
            check(
              false,
              "after failure: state could not be read",
              `(${errorKind(stateError)})`,
            ),
        );
        return "not-migrated" as const;
      }
      check(true, `migration: applied ${pending}, in one transaction`);

      const after = await readOnlyChecks(session, "after", true);
      if (after?.state !== "applied") {
        check(
          false,
          "after: the result isn't exactly every approved migration; stopped for review",
        );
        return "not-migrated" as const;
      }
      return "migrated" as const;
    });

    if (!locked.acquired) {
      check(
        false,
        "lock: held by another session (a migration or test run is in progress); nothing was changed",
      );
    } else {
      outcome = locked.value;
      check(locked.released, "lock: released");
    }
  } catch (error) {
    check(false, "migration runner could not finish", `(${errorKind(error)})`);
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
  return { results, outcome };
}
