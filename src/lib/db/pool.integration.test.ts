// Integration tests for the pool and session settings, against the local test
// database (npm run test:integration only). Tests never get the pool itself:
// they use withRollback, change session settings only with SET LOCAL (which
// ends with the transaction), and observe the pool through the read-only
// checkedOutTestClients() counter.
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  APPLICATION_NAME,
  CONNECTION_TIMEOUT_MS,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  MAX_LIFETIME_SECONDS,
  STATEMENT_TIMEOUT_MS,
  buildPoolConfig,
} from "@/lib/db/pool-config";
import {
  expectPgError,
  withRollback,
  type TestTransaction,
} from "@/lib/db/testing";
import {
  TEST_POOL_MAX,
  checkedOutTestClients,
} from "@/lib/db/testing/test-pool";

type Settings = Record<string, unknown>;

const sessionSettings = (tx: TestTransaction) =>
  tx
    .execute<Settings>(
      sql`select current_setting('application_name') as application_name,
                 current_setting('statement_timeout') as statement_timeout,
                 current_setting('idle_in_transaction_session_timeout') as idle_in_transaction,
                 current_setting('client_encoding') as client_encoding,
                 pg_backend_pid() as pid`,
    )
    .then((result) => result.rows[0] ?? {});

describe("pool configuration", () => {
  test("uses the app's pool settings, with the test pool's own size", () => {
    const config = buildPoolConfig(
      {
        host: "127.0.0.1",
        port: 5432,
        user: "ai_spec_studio_test",
        password: "unused-in-this-assertion",
        database: "ai_spec_studio_test",
        ssl: false,
      },
      TEST_POOL_MAX,
    );
    if (!config.ok) throw new Error("expected a pool config");
    expect(config.value).toMatchObject({
      max: TEST_POOL_MAX,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      maxLifetimeSeconds: MAX_LIFETIME_SECONDS,
      application_name: APPLICATION_NAME,
      client_encoding: "UTF8",
      ssl: false,
    });
    expect(TEST_POOL_MAX).toBe(2);
  });
});

describe("session settings from the pool configuration", () => {
  test("application_name, timeouts, and encoding are applied to every session", async () => {
    await withRollback(async (tx) => {
      expect(await sessionSettings(tx)).toMatchObject({
        application_name: APPLICATION_NAME,
        statement_timeout: `${STATEMENT_TIMEOUT_MS / 1000}s`,
        idle_in_transaction: `${IDLE_IN_TRANSACTION_TIMEOUT_MS / 60_000}min`,
        client_encoding: "UTF8",
      });
    });
  });
});

describe("statement timeout", () => {
  test("a statement over a SET LOCAL timeout fails with 57014, and the transaction recovers", async () => {
    await withRollback(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '100ms'`);
      // pg_sleep is cut off by the 100 ms timeout: the test waits about that
      // long, never the full sleep.
      await expectPgError(tx, { code: "57014" }, (sp) =>
        sp.execute(sql`select pg_sleep(30)`),
      );
      // The savepoint absorbed the cancellation; the transaction still works
      // and SET LOCAL is still in effect inside it.
      expect(await sessionSettings(tx)).toMatchObject({
        statement_timeout: "100ms",
      });
    });
  });

  test("SET LOCAL ends with the transaction: the next one has the pool's timeout again", async () => {
    await withRollback(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '100ms'`);
    });
    await withRollback(async (tx) => {
      expect(await sessionSettings(tx)).toMatchObject({
        statement_timeout: `${STATEMENT_TIMEOUT_MS / 1000}s`,
      });
    });
  });
});

describe("connection lifecycle", () => {
  test("a connection is released after a passing and after a failing test", async () => {
    await withRollback(async () => {
      expect(checkedOutTestClients()).toBe(1);
    });
    expect(checkedOutTestClients()).toBe(0);

    await withRollback(async () => {
      throw new Error("deliberate failure");
    }).catch(() => undefined);
    expect(checkedOutTestClients()).toBe(0);
  });

  test("a connection is usable after its transaction was rolled back, in a new transaction", async () => {
    const first = await withRollback(async (tx) => {
      await tx.execute(sql`set local application_name = 'changed-in-test'`);
      return (
        await tx.execute<{ xid: string }>(
          sql`select txid_current()::text as xid`,
        )
      ).rows[0]?.xid;
    });
    await withRollback(async (tx) => {
      const settings = await sessionSettings(tx);
      expect(settings.application_name).toBe(APPLICATION_NAME);
      const xid = (
        await tx.execute<{ xid: string }>(
          sql`select txid_current()::text as xid`,
        )
      ).rows[0]?.xid;
      expect(xid).not.toBe(first);
    });
  });

  test("concurrent transactions never use more connections than the pool allows", async () => {
    const pids = await Promise.all(
      Array.from({ length: TEST_POOL_MAX + 2 }, () =>
        withRollback(async (tx) => (await sessionSettings(tx)).pid),
      ),
    );
    expect(new Set(pids).size).toBeLessThanOrEqual(TEST_POOL_MAX);
    expect(checkedOutTestClients()).toBe(0);
  });

  test("each transaction runs on its own connection while another is open", async () => {
    await withRollback(async (outer) => {
      const outerPid = (await sessionSettings(outer)).pid;
      const innerPid = await withRollback(
        async (inner) => (await sessionSettings(inner)).pid,
      );
      expect(innerPid).not.toBe(outerPid);
      expect(checkedOutTestClients()).toBe(1);
    });
    expect(checkedOutTestClients()).toBe(0);
  });
});
