// Rollback-only database access for integration tests.
//
// withRollback(fn) checks out ONE client, opens an outer transaction on it,
// binds Drizzle to that client, and gives fn the transaction object `tx`.
// The outer transaction is always rolled back, never committed: Drizzle
// commits only when its callback returns, and ours always throws a private
// sentinel instead. Nested tx.transaction() calls are savepoints inside the
// outer transaction, so they can't commit anything either. The client is
// released on every path (and destroyed if cleanup failed).
//
// A test can still send a raw COMMIT through tx.execute(); withRollback
// detects that (the transaction id changes) and fails the test, and the
// run's teardown reports any row that persisted. It never deletes anything.
//
// This module never imports the application's client.ts or reads
// DATABASE_URL: it only uses the test pool (test-pool.ts).
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { projects, specifications } from "../schema";

const schema = { projects, specifications };

export type TestDatabase = NodePgDatabase<typeof schema>;
export type TestTransaction = Parameters<
  Parameters<TestDatabase["transaction"]>[0]
>[0];

export type ClientSource = () => Promise<PoolClient>;

// Thrown when the test failed AND cleanup failed: errors[0] is the test's own
// error, unchanged; the rest are the cleanup failures.
export class RollbackCleanupError extends AggregateError {
  override name = "RollbackCleanupError";
}

class AlwaysRollBack extends Error {}

async function transactionId(tx: TestTransaction): Promise<string> {
  const result = await tx.execute<{ xid: string }>(
    sql`select txid_current()::text as xid`,
  );
  return String(result.rows[0]?.xid ?? "");
}

export function createWithRollback(acquire: ClientSource) {
  return async function withRollback<T>(
    fn: (tx: TestTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await acquire();
    const db = drizzle({ client, schema });
    let outcome:
      { ok: true; value: T } | { ok: false; error: unknown } | undefined;
    const problems: unknown[] = [];
    let destroy = false;

    try {
      await db.transaction(async (tx) => {
        const before = await transactionId(tx);
        try {
          outcome = { ok: true, value: await fn(tx) };
        } catch (error) {
          outcome = { ok: false, error };
        }
        if (outcome.ok) {
          // The outer transaction must still be the one that started. If a
          // statement failed and was swallowed, this query fails (25P02); if
          // the test committed, the id differs.
          let after: string | undefined;
          try {
            after = await transactionId(tx);
          } catch (error) {
            problems.push(
              new Error(
                "The test left its transaction aborted: a failed statement was caught without expectPgError.",
                { cause: error },
              ),
            );
          }
          if (after !== undefined && after !== before) {
            problems.push(
              new Error(
                "The test ended the rollback-only transaction (for example with a raw COMMIT). Its changes may have persisted; the run's teardown will report them.",
              ),
            );
          }
        }
        throw new AlwaysRollBack();
      });
    } catch (error) {
      if (!(error instanceof AlwaysRollBack)) {
        // BEGIN or ROLLBACK failed: the connection can't be trusted.
        destroy = true;
        problems.push(error);
      }
    }

    try {
      client.release(destroy ? true : undefined);
    } catch (error) {
      problems.push(error);
    }

    if (outcome === undefined) {
      throw problems.length === 1
        ? problems[0]
        : new AggregateError(problems, "The test transaction could not start.");
    }
    if (!outcome.ok) {
      if (problems.length > 0) {
        throw new RollbackCleanupError(
          [outcome.error, ...problems],
          "The test failed, and cleaning up its transaction also failed.",
        );
      }
      throw outcome.error;
    }
    if (problems.length > 0) {
      throw problems.length === 1
        ? problems[0]
        : new AggregateError(
            problems,
            "Cleaning up the test transaction failed.",
          );
    }
    return outcome.value;
  };
}

export type ExpectedPgError = { code: string; constraint?: string };

export type PgErrorDetails = {
  code: string;
  constraint?: string;
  table?: string;
  column?: string;
};

// The PostgreSQL error inside an error (Drizzle wraps it in
// DrizzleQueryError's `cause`).
export function findPgError(error: unknown): PgErrorDetails | undefined {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth++
  ) {
    const candidate = current as Record<string, unknown>;
    if (
      typeof candidate.code === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    ) {
      const details: PgErrorDetails = { code: candidate.code };
      if (typeof candidate.constraint === "string")
        details.constraint = candidate.constraint;
      if (typeof candidate.table === "string") details.table = candidate.table;
      if (typeof candidate.column === "string")
        details.column = candidate.column;
      return details;
    }
    current = candidate.cause;
  }
  return undefined;
}

// Runs fn inside a savepoint and requires it to fail with `expected.code`
// (and constraint, when given). The savepoint is rolled back, so the outer
// test transaction stays usable. Returns the error's details.
export async function expectPgError(
  tx: TestTransaction,
  expected: ExpectedPgError,
  fn: (savepoint: TestTransaction) => Promise<unknown>,
): Promise<PgErrorDetails> {
  let caught: unknown;
  let succeeded = false;
  try {
    await tx.transaction(async (savepoint) => {
      await fn(savepoint);
    });
    succeeded = true;
  } catch (error) {
    caught = error;
  }
  if (succeeded) {
    throw new Error(
      `Expected PostgreSQL error ${expected.code}, but the statement succeeded.`,
    );
  }
  const pg = findPgError(caught);
  if (!pg) {
    throw new Error(
      `Expected PostgreSQL error ${expected.code}, but the failure wasn't a database error.`,
      { cause: caught },
    );
  }
  if (pg.code !== expected.code) {
    throw new Error(
      `Expected PostgreSQL error ${expected.code}, got ${pg.code}.`,
      { cause: caught },
    );
  }
  if (
    expected.constraint !== undefined &&
    pg.constraint !== expected.constraint
  ) {
    throw new Error(
      `Expected constraint ${expected.constraint}, got ${pg.constraint ?? "none"}.`,
      { cause: caught },
    );
  }
  return pg;
}
