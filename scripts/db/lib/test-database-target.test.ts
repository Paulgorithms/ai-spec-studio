import type { Pool, PoolConfig } from "pg";
import { describe, expect, test } from "vitest";
import {
  APPLIED,
  BROKEN,
  FILES,
  FRESH,
  PARTIAL,
  SESSION,
  journalRows,
  pg18Constraints,
  rowCounts,
  testDatabaseAfter,
  type Answers,
  type Rows,
} from "./fixtures/test-database-answers";
import { formatResults, type CheckResult } from "./live-verification";
import {
  APPROVED_MIGRATIONS,
  QUERIES,
  type MigrationFiles,
} from "./migration-checks";
import {
  LOCK_QUERIES,
  TEST_DATABASE_LOCK,
  TEST_QUERIES,
  checkTestDatabaseConfiguration,
  emptyTables,
  rowCountsQuery,
  runTestDatabasePreflight,
  withTestDatabaseLock,
  type LockClient,
} from "./test-database-target";

const PASSWORD = "FakeTest:p@ss/word";
const enc = encodeURIComponent;
const TEST_URL = `postgresql://ai_spec_studio_test:${enc(PASSWORD)}@127.0.0.1:5432/ai_spec_studio_test`;
const DEV_URL = `postgresql://ai_spec_studio_app:${enc("FakeApp-pw")}@127.0.0.1:5432/ai_spec_studio_dev`;
const MIGRATION_URL = `postgresql://ai_spec_studio_migrator:${enc("FakeMig-pw")}@127.0.0.1:5432/ai_spec_studio_dev`;
const ENV = {
  TEST_DATABASE_URL: TEST_URL,
  DATABASE_URL: DEV_URL,
  DATABASE_MIGRATION_URL: MIGRATION_URL,
  DATABASE_SSL_MODE: "disable",
};

function configuration(env: Record<string, string | undefined>) {
  const results: CheckResult[] = [];
  const connection = checkTestDatabaseConfiguration(
    env,
    (pass, label, detail) =>
      results.push(
        detail === undefined ? { pass, label } : { pass, label, detail },
      ),
  );
  return { connection, results, failed: results.filter((r) => !r.pass) };
}

function expectNoSecrets(output: string) {
  for (const secret of [PASSWORD, "FakeApp-pw", "FakeMig-pw"]) {
    expect(output).not.toContain(secret);
    expect(output).not.toContain(enc(secret));
  }
  expect(output).not.toContain("postgresql://");
}

describe("checkTestDatabaseConfiguration", () => {
  test.each(["127.0.0.1", "localhost", "[::1]"])(
    "accepts the exact target on %s",
    (host) => {
      const { connection, failed } = configuration({
        ...ENV,
        TEST_DATABASE_URL: TEST_URL.replace("127.0.0.1", host),
      });
      expect(failed).toEqual([]);
      expect(connection).toMatchObject({
        user: "ai_spec_studio_test",
        database: "ai_spec_studio_test",
        port: 5432,
        ssl: false,
      });
    },
  );

  test("accepts the test URL alone (no dev or migration URL set)", () => {
    expect(configuration({ TEST_DATABASE_URL: TEST_URL }).failed).toEqual([]);
  });

  const exactLabel =
    "target: TEST_DATABASE_URL is ai_spec_studio_test on loopback port 5432, database ai_spec_studio_test, TLS off";
  const validatorLabel =
    "target: TEST_DATABASE_URL passes the project validator";

  test.each([
    [
      "a remote host",
      { TEST_DATABASE_URL: TEST_URL.replace("127.0.0.1", "db.example.com") },
      [validatorLabel],
      "(TEST_HOST_NOT_LOOPBACK)",
    ],
    [
      "the app role",
      {
        TEST_DATABASE_URL: TEST_URL.replace(
          "ai_spec_studio_test:",
          "ai_spec_studio_app:",
        ),
      },
      [exactLabel],
      undefined,
    ],
    [
      "the migrator role",
      {
        TEST_DATABASE_URL: TEST_URL.replace(
          "ai_spec_studio_test:",
          "ai_spec_studio_migrator:",
        ),
      },
      [exactLabel],
      undefined,
    ],
    [
      "another _test database",
      {
        TEST_DATABASE_URL: TEST_URL.replace(
          /ai_spec_studio_test$/,
          "other_test",
        ),
      },
      [exactLabel],
      undefined,
    ],
    [
      "the development database",
      {
        TEST_DATABASE_URL: TEST_URL.replace(
          /ai_spec_studio_test$/,
          "ai_spec_studio_dev",
        ),
      },
      [validatorLabel],
      "(TEST_DATABASE_NAME, TEST_SAME_DATABASE)",
    ],
    [
      "port 5433",
      { TEST_DATABASE_URL: TEST_URL.replace(":5432/", ":5433/") },
      [exactLabel],
      undefined,
    ],
    [
      "a missing TEST_DATABASE_URL",
      { TEST_DATABASE_URL: undefined },
      [validatorLabel],
      "(NOT_SET)",
    ],
    [
      "production",
      { NODE_ENV: "production" },
      ["environment: NODE_ENV is not production", validatorLabel],
      undefined,
    ],
  ])("rejects %s", (_, change, labels, detail) => {
    const { connection, failed, results } = configuration({
      ...ENV,
      ...change,
    });
    expect(connection).toBeUndefined();
    expect(failed.map((r) => r.label)).toEqual(labels);
    if (detail)
      expect(failed.find((r) => r.label === validatorLabel)?.detail).toBe(
        detail,
      );
    expectNoSecrets(formatResults(results));
  });

  test.each([
    ["DATABASE_SSL_MODE=verify-full", { DATABASE_SSL_MODE: "verify-full" }],
    ["DATABASE_SSL_MODE=require", { DATABASE_SSL_MODE: "require" }],
    ["a CA bundle", { DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----" }],
  ])("rejects TLS settings: %s", (_, change) => {
    const { connection, failed } = configuration({ ...ENV, ...change });
    expect(connection).toBeUndefined();
    expect(failed.map((r) => r.label)).toContain(
      "environment: no TLS settings (DATABASE_SSL_MODE unset or disable, no DATABASE_SSL_CA)",
    );
  });

  test.each([
    ["PGPASSWORD", "FakeEnv-1"],
    ["PGHOST", "FakeEnv-2"],
    ["PGDATABASE", "ai_spec_studio_dev"],
    ["PGOPTIONS", "-c FakeEnv=3"],
    ["PGBINARY", "1"],
    ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
    ["NODE_EXTRA_CA_CERTS", "/tmp/FakeEnv.pem"],
  ])("rejects the ambient variable %s, by name only", (name, value) => {
    const { connection, results } = configuration({ ...ENV, [name]: value });
    expect(connection).toBeUndefined();
    expect(results[0]).toEqual({
      pass: false,
      label:
        "environment: no PG*, NODE_TLS_REJECT_UNAUTHORIZED, or NODE_EXTRA_CA_CERTS variables",
      detail: `set: ${name}`,
    });
    expect(formatResults(results)).not.toContain(value);
  });

  const otherLabel =
    "target: DATABASE_URL and DATABASE_MIGRATION_URL (when set) are readable and name other databases";
  test.each([
    [
      "DATABASE_URL names the test database",
      {
        DATABASE_URL: TEST_URL.replace(
          "ai_spec_studio_test:",
          "ai_spec_studio_app:",
        ),
      },
    ],
    [
      "DATABASE_MIGRATION_URL names the test database",
      { DATABASE_MIGRATION_URL: TEST_URL },
    ],
    ["DATABASE_URL can't be read", { DATABASE_URL: "not a url" }],
  ])("rejects when %s", (_, change) => {
    const { connection, failed } = configuration({ ...ENV, ...change });
    expect(connection).toBeUndefined();
    expect(failed.map((r) => r.label)).toContain(otherLabel);
  });
});

describe("withTestDatabaseLock", () => {
  type Call = { client: string; text: string; values?: unknown[] };
  function lockClient(
    name: string,
    calls: Call[],
    answers: {
      acquired?: unknown;
      released?: unknown;
      tryError?: Error;
      unlockError?: Error;
    },
  ): LockClient {
    return {
      query: (async (text: string, values?: unknown[]) => {
        calls.push({ client: name, text, values });
        if (text === LOCK_QUERIES.tryLock) {
          if (answers.tryError) throw answers.tryError;
          return { rows: [{ acquired: answers.acquired }] };
        }
        if (text === LOCK_QUERIES.unlock) {
          if (answers.unlockError) throw answers.unlockError;
          return { rows: [{ released: answers.released }] };
        }
        throw new Error("unexpected query");
      }) as LockClient["query"],
    };
  }
  const KEYS = [TEST_DATABASE_LOCK.classId, TEST_DATABASE_LOCK.objectId];

  test("uses one fixed project key in the two-int4 form", () => {
    expect(TEST_DATABASE_LOCK).toEqual({ classId: 0x41495353, objectId: 1 });
    expect(LOCK_QUERIES.tryLock).toContain(
      "pg_try_advisory_lock($1::int, $2::int)",
    );
    expect(LOCK_QUERIES.unlock).toContain(
      "pg_advisory_unlock($1::int, $2::int)",
    );
    expect(LOCK_QUERIES.holders).toContain("objsubid = 2");
  });

  test("lock available: runs fn, then releases on the same session", async () => {
    const calls: Call[] = [];
    let ran = false;
    const outcome = await withTestDatabaseLock(
      lockClient("A", calls, { acquired: true, released: true }),
      async () => {
        ran = true;
        expect(calls.map((c) => c.text)).toEqual([LOCK_QUERIES.tryLock]);
        return "done";
      },
    );
    expect(ran).toBe(true);
    expect(outcome).toEqual({ acquired: true, value: "done", released: true });
    expect(calls).toEqual([
      { client: "A", text: LOCK_QUERIES.tryLock, values: KEYS },
      { client: "A", text: LOCK_QUERIES.unlock, values: KEYS },
    ]);
  });

  test("lock already held: fn never runs and nothing is released", async () => {
    const calls: Call[] = [];
    let ran = false;
    const outcome = await withTestDatabaseLock(
      lockClient("A", calls, { acquired: false }),
      async () => {
        ran = true;
      },
    );
    expect(outcome).toEqual({ acquired: false });
    expect(ran).toBe(false);
    expect(calls.map((c) => c.text)).toEqual([LOCK_QUERIES.tryLock]);
  });

  test("an unexpected answer counts as not acquired", async () => {
    const calls: Call[] = [];
    expect(
      await withTestDatabaseLock(
        lockClient("A", calls, { acquired: "t" }),
        async () => 1,
      ),
    ).toEqual({ acquired: false });
  });

  test("acquisition failure: the error propagates, fn doesn't run, no unlock", async () => {
    const calls: Call[] = [];
    let ran = false;
    const error = Object.assign(new Error("x"), { code: "57P01" });
    await expect(
      withTestDatabaseLock(
        lockClient("A", calls, { tryError: error }),
        async () => {
          ran = true;
        },
      ),
    ).rejects.toBe(error);
    expect(ran).toBe(false);
    expect(calls.map((c) => c.text)).toEqual([LOCK_QUERIES.tryLock]);
  });

  test("fn throws: the lock is released, then fn's error is rethrown", async () => {
    const calls: Call[] = [];
    const failure = new Error("test failure");
    await expect(
      withTestDatabaseLock(
        lockClient("A", calls, { acquired: true, released: true }),
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(calls.map((c) => [c.client, c.text])).toEqual([
      ["A", LOCK_QUERIES.tryLock],
      ["A", LOCK_QUERIES.unlock],
    ]);
  });

  test("fn throws and the release fails too: fn's error wins", async () => {
    const calls: Call[] = [];
    const failure = new Error("test failure");
    await expect(
      withTestDatabaseLock(
        lockClient("A", calls, {
          acquired: true,
          unlockError: new Error("gone"),
        }),
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
  });

  test("a release PostgreSQL rejects (not held by this session) is reported", async () => {
    const calls: Call[] = [];
    expect(
      await withTestDatabaseLock(
        lockClient("A", calls, { acquired: true, released: false }),
        async () => "v",
      ),
    ).toEqual({ acquired: true, value: "v", released: false });
  });

  test("a failing release after fn succeeded propagates", async () => {
    const calls: Call[] = [];
    const error = new Error("gone");
    await expect(
      withTestDatabaseLock(
        lockClient("A", calls, { acquired: true, unlockError: error }),
        async () => "v",
      ),
    ).rejects.toBe(error);
  });

  test("never touches another client: lock and unlock go to the session given", async () => {
    const calls: Call[] = [];
    const a = lockClient("A", calls, { acquired: true, released: true });
    const b = lockClient("B", calls, { acquired: true, released: true });
    await withTestDatabaseLock(a, async () => {
      await withTestDatabaseLock(b, async () => undefined);
    });
    expect(calls.map((c) => c.client)).toEqual(["A", "B", "B", "A"]);
  });
});

// --- The preflight, with a fake pool ----------------------------------------

type Call = { text: string; values?: unknown[] };

async function preflight(
  answers: Answers,
  options: {
    env?: Record<string, string | undefined>;
    files?: MigrationFiles;
    connectError?: Error;
  } = {},
) {
  const fake = {
    created: 0,
    ended: false,
    released: false,
    calls: [] as Call[],
  };
  const createPool = (config: PoolConfig): Pool => {
    fake.created += 1;
    expect(config).toMatchObject({
      user: "ai_spec_studio_test",
      database: "ai_spec_studio_test",
      max: 1,
      ssl: false,
    });
    const client = {
      query: async (text: string, values?: unknown[]) => {
        fake.calls.push(values === undefined ? { text } : { text, values });
        if (text === QUERIES.begin || text === QUERIES.rollback)
          return { rows: [] };
        const name = /^\/\* (\w+) \*\//.exec(text)?.[1] ?? "";
        const answer = answers[name];
        if (answer instanceof Error) throw answer;
        return { rows: answer ?? [] };
      },
      release: () => {
        fake.released = true;
      },
    };
    const pool = {
      totalCount: 1,
      on: () => pool,
      connect: async () => {
        if (options.connectError) throw options.connectError;
        return client;
      },
      end: async () => {
        fake.ended = true;
        pool.totalCount = 0;
      },
    };
    return pool as unknown as Pool;
  };
  const outcome = await runTestDatabasePreflight(
    options.env ?? ENV,
    createPool,
    options.files ?? FILES,
  );
  return {
    ...outcome,
    fake,
    output: formatResults(outcome.results),
    failed: outcome.results.filter((r) => !r.pass).map((r) => r.label),
  };
}

const ALL_TABLES = [
  "accounts",
  "projects",
  "sessions",
  "specifications",
  "users",
  "verifications",
];
const EVERY_APPLIED =
  "state: every approved migration is applied exactly (0000_initial_schema, 0001_auth_tables)";
const PARTIAL_EXACT =
  "state: partially migrated, exactly as reviewed (applied: 0000_initial_schema; pending: 0001_auth_tables)";
const UNEXPECTED =
  "state: neither fresh nor exactly the first approved migrations, in order";

describe("runTestDatabasePreflight", () => {
  test("a fresh test database passes, read-only, and the pool closes", async () => {
    const result = await preflight(FRESH);
    expect(result.failed).toEqual([]);
    expect(result.state).toBe("fresh");
    expect(result.applied).toBe(0);
    expect(result.output).toMatch(/ALL 36 CHECKS PASSED$/);
    expect(result.output).toContain(
      "PASS  state: fresh (no drizzle schema, no migration journal, schema public empty)",
    );
    expect(result.fake.created).toBe(1);
    expect(result.fake.released && result.fake.ended).toBe(true);
    expect(result.fake.calls[0]?.text).toBe("BEGIN TRANSACTION READ ONLY");
    expect(result.fake.calls.at(-1)?.text).toBe("ROLLBACK");
    for (const call of result.fake.calls.slice(1, -1)) {
      expect(call.text).toMatch(/^\/\* \w+ \*\/\nSELECT /);
    }
    // The preflight only looks at the lock; it never takes it.
    expect(
      result.fake.calls.some(
        (c) =>
          c.text === LOCK_QUERIES.tryLock || c.text === LOCK_QUERIES.unlock,
      ),
    ).toBe(false);
    expect(
      result.fake.calls.find((c) => c.text === LOCK_QUERIES.holders)?.values,
    ).toEqual([TEST_DATABASE_LOCK.classId, TEST_DATABASE_LOCK.objectId]);
    expectNoSecrets(result.output);
  });

  test("a database with every approved migration applied exactly passes", async () => {
    const result = await preflight(APPLIED);
    expect(result.failed).toEqual([]);
    expect(result.state).toBe("applied");
    expect(result.applied).toBe(2);
    expect(result.output).toMatch(/ALL 46 CHECKS PASSED$/);
    expect(result.output).toContain(`PASS  ${EVERY_APPLIED}`);
    expect(result.output).toContain(
      "PASS  tables: exactly accounts, projects, sessions, specifications, users, and verifications in public, owned by ai_spec_studio_test, no row-level security",
    );
    expect(result.output).toContain(
      "PASS  state: all 6 tables are empty (nothing left by earlier runs)",
    );
    expect(
      result.fake.calls.find((c) => c.text === TEST_QUERIES.foreignGrants)
        ?.values,
    ).toEqual(["ai_spec_studio_app", "ai_spec_studio_migrator", ALL_TABLES]);
    expect(
      result.fake.calls.some((c) => c.text === rowCountsQuery(ALL_TABLES)),
    ).toBe(true);
  });

  test("a database with exactly 0000_initial_schema applied is partially migrated", async () => {
    const result = await preflight(PARTIAL);
    expect(result.failed).toEqual([]);
    expect(result.state).toBe("partial");
    expect(result.applied).toBe(1);
    expect(result.output).toContain(`PASS  ${PARTIAL_EXACT}`);
    expect(result.output).toContain(
      "PASS  tables: exactly projects and specifications in public, owned by ai_spec_studio_test, no row-level security",
    );
    // Only the tables that exist are counted and checked.
    expect(
      result.fake.calls.some(
        (c) => c.text === rowCountsQuery(["projects", "specifications"]),
      ),
    ).toBe(true);
    expect(
      result.fake.calls.find((c) => c.text === TEST_QUERIES.foreignGrants)
        ?.values,
    ).toEqual([
      "ai_spec_studio_app",
      "ai_spec_studio_migrator",
      ["projects", "specifications"],
    ]);
  });

  test.each([
    [
      "a drizzle schema without a journal",
      BROKEN,
      "(DRIZZLE_SCHEMA, NO_JOURNAL, PUBLIC_EMPTY)",
    ],
    [
      "tables without a journal",
      { ...FRESH, objects: [{ journal: false, public_relations: 8 }] },
      "(NO_DRIZZLE_SCHEMA, NO_JOURNAL, PUBLIC_NOT_EMPTY)",
    ],
    [
      "something else in public",
      { ...FRESH, objects: [{ journal: false, public_relations: 1 }] },
      "(NO_DRIZZLE_SCHEMA, NO_JOURNAL, PUBLIC_NOT_EMPTY)",
    ],
    [
      "an empty journal",
      { ...APPLIED, journal: [] },
      "(DRIZZLE_SCHEMA, JOURNAL, PUBLIC_NOT_EMPTY, JOURNAL_ROWS_0, JOURNAL_EMPTY)",
    ],
    [
      "the migrations journaled out of order",
      { ...APPLIED, journal: [...journalRows(2)].reverse() },
      "(DRIZZLE_SCHEMA, JOURNAL, PUBLIC_NOT_EMPTY, JOURNAL_ROWS_2, JOURNAL_NOT_APPROVED_PREFIX)",
    ],
    [
      "0001 journaled without 0000",
      { ...APPLIED, journal: journalRows(2).slice(1) },
      "(DRIZZLE_SCHEMA, JOURNAL, PUBLIC_NOT_EMPTY, JOURNAL_ROWS_1, JOURNAL_NOT_APPROVED_PREFIX)",
    ],
    [
      "a different migration hash",
      {
        ...APPLIED,
        journal: [
          journalRows(2)[0]!,
          {
            hash: "0".repeat(64),
            created_at: String(APPROVED_MIGRATIONS[1]!.when),
          },
        ],
      },
      "(DRIZZLE_SCHEMA, JOURNAL, PUBLIC_NOT_EMPTY, JOURNAL_ROWS_2, JOURNAL_NOT_APPROVED_PREFIX)",
    ],
    [
      "an unknown later migration",
      {
        ...APPLIED,
        journal: [
          ...journalRows(2),
          { hash: "f".repeat(64), created_at: "1999999999999" },
        ],
      },
      "(DRIZZLE_SCHEMA, JOURNAL, PUBLIC_NOT_EMPTY, JOURNAL_ROWS_3, JOURNAL_NOT_APPROVED_PREFIX)",
    ],
  ])("rejects an unknown state: %s", async (_, answers, detail) => {
    const result = await preflight(answers as Answers);
    expect(result.state).toBe("unexpected");
    expect(result.applied).toBeUndefined();
    expect(result.results.find((r) => r.label === UNEXPECTED)?.detail).toBe(
      detail,
    );
  });

  const appliedTables = APPLIED.tables as Rows;
  test.each([
    [
      "a journal owned by the migrator",
      {
        journal_owner: [
          {
            schema_owner: "ai_spec_studio_migrator",
            table_owner: "ai_spec_studio_migrator",
          },
        ],
      },
      "journal: drizzle schema and __drizzle_migrations owned by ai_spec_studio_test",
    ],
    [
      "auth tables owned by the migrator",
      {
        tables: appliedTables.map((t) =>
          ["users", "sessions", "accounts", "verifications"].includes(
            t.name as string,
          )
            ? { ...t, owner: "ai_spec_studio_migrator" }
            : t,
        ),
      },
      "tables: exactly accounts, projects, sessions, specifications, users, and verifications in public, owned by ai_spec_studio_test, no row-level security",
    ],
    [
      "a changed constraint",
      {
        constraints: pg18Constraints().map((r) =>
          r.name === "sessions_user_id_fkey"
            ? {
                ...r,
                definition:
                  "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE NO ACTION",
              }
            : r,
        ),
      },
      "constraints: exactly the 18 reviewed primary key, UNIQUE, CHECK, and foreign key constraints",
    ],
    [
      "a grant to the app role on sessions",
      {
        foreign_grants: ALL_TABLES.map((table_name) => ({
          table_name,
          app_any: table_name === "sessions",
          migrator_any: false,
          public_any: false,
        })),
      },
      "grants: the app role, the migrator, and PUBLIC have no table privileges",
    ],
    [
      "a missing table in the grants",
      {
        foreign_grants: ALL_TABLES.filter((t) => t !== "accounts").map(
          (table_name) => ({
            table_name,
            app_any: false,
            migrator_any: false,
            public_any: false,
          }),
        ),
      },
      "grants: the app role, the migrator, and PUBLIC have no table privileges",
    ],
    [
      "a session row left behind",
      { row_counts: rowCounts(2, { sessions: 1 }) },
      "state: all 6 tables are empty (nothing left by earlier runs)",
    ],
    [
      "a count missing for one table",
      { row_counts: [{ ...rowCounts(2)[0], users: null }] },
      "state: all 6 tables are empty (nothing left by earlier runs)",
    ],
  ])("an applied database with %s is unexpected", async (_, change, label) => {
    const result = await preflight({ ...APPLIED, ...(change as Answers) });
    expect(result.state).toBe("unexpected");
    expect(result.failed).toEqual([label, EVERY_APPLIED]);
  });

  test("rows left behind are reported per table", async () => {
    const result = await preflight({
      ...APPLIED,
      row_counts: rowCounts(2, { projects: 1, users: 2 }),
    });
    expect(
      result.results.find((r) => r.label.startsWith("state: all 6 tables"))
        ?.detail,
    ).toBe(
      "(accounts: 0, projects: 1, sessions: 0, specifications: 0, users: 2, verifications: 0)",
    );
  });

  test("a partially migrated database with an extra auth table is unexpected", async () => {
    const result = await preflight({
      ...PARTIAL,
      tables: [
        ...(PARTIAL.tables as Rows),
        { name: "users", kind: "r", owner: "ai_spec_studio_test", rls: false },
      ],
    });
    expect(result.state).toBe("unexpected");
    expect(result.failed).toEqual([
      "tables: exactly projects and specifications in public, owned by ai_spec_studio_test, no row-level security",
      PARTIAL_EXACT,
    ]);
  });

  test.each([
    [
      "the development database's label",
      { label: [{ setconfig: ["app.environment=development"] }] },
      "database: labeled app.environment=test",
    ],
    [
      "the development database",
      { session: [{ ...SESSION, database_name: "ai_spec_studio_dev" }] },
      "session: current_database() is ai_spec_studio_test",
    ],
    [
      "the migrator session",
      {
        session: [{ ...SESSION, current_role_name: "ai_spec_studio_migrator" }],
      },
      "session: current_user and session_user are ai_spec_studio_test",
    ],
    [
      "trust or peer login",
      { session: [{ ...SESSION, auth_identity: null }] },
      "session: authenticated with SCRAM-SHA-256",
    ],
    [
      "a superuser",
      {
        role: [
          {
            rolsuper: true,
            rolcreaterole: false,
            rolcreatedb: false,
            rolreplication: false,
            rolbypassrls: false,
          },
        ],
      },
      "role: no superuser, CREATEROLE, CREATEDB, REPLICATION, or BYPASSRLS",
    ],
    [
      "a role membership",
      { memberships: [{ memberships: 1 }] },
      "role: not a member of any role (no migrator, app, administrator, or predefined roles)",
    ],
    [
      "a different search_path",
      { session: [{ ...SESSION, search_path: "x, public" }] },
      'session: search_path is "$user", public and current_schema() is public',
    ],
    [
      "a schema named after the role",
      { schemas: [{ name: "ai_spec_studio_test" }, { name: "public" }] },
      "database: no schema named ai_spec_studio_test (it would come first in search_path)",
    ],
    [
      "no CREATE on the database",
      {
        privileges: [
          { create_db: false, usage_public: true, create_public: true },
        ],
      },
      "privileges: CREATE on database ai_spec_studio_test (for the drizzle schema)",
    ],
    [
      "another test-role session",
      { sessions: [{ other_migrator_sessions: 2 }] },
      "concurrency: no other session is connected as ai_spec_studio_test",
    ],
    [
      "the advisory lock held",
      { lock_holders: [{ holders: 1 }] },
      "concurrency: the test-database advisory lock is free",
    ],
  ])("a fresh database fails on %s", async (_, change, label) => {
    const result = await preflight({ ...FRESH, ...(change as Answers) });
    expect(result.failed).toContain(label);
  });

  test.each([
    [
      "a changed 0001 migration",
      {
        files: {
          ...FILES,
          sha256: { ...FILES.sha256, "0001_auth_tables.sql": "0".repeat(64) },
        },
      },
    ],
    [
      "a missing journal entry",
      {
        files: {
          ...FILES,
          journal: {
            ...FILES.journal,
            entries: FILES.journal.entries.slice(0, 1),
          },
        },
      },
    ],
    ["a PG* variable", { env: { ...ENV, PGHOST: "FakeHost" } }],
    [
      "the development database URL",
      { env: { ...ENV, TEST_DATABASE_URL: DEV_URL } },
    ],
    ["no TEST_DATABASE_URL", { env: { ...ENV, TEST_DATABASE_URL: undefined } }],
  ])("never creates a pool for %s", async (_, options) => {
    const result = await preflight(FRESH, options);
    expect(result.fake.created).toBe(0);
    expect(result.failed.at(-1)).toBe(
      "connection skipped (a check above failed)",
    );
    expectNoSecrets(result.output);
    expect(result.output).not.toContain("FakeHost");
  });

  test("a failed login is reported by SQLSTATE, and the pool still closes", async () => {
    const result = await preflight(FRESH, {
      connectError: Object.assign(
        new Error(`password authentication failed: ${PASSWORD}`),
        { code: "28P01" },
      ),
    });
    expect(result.failed).toEqual(["checks could not finish"]);
    expect(result.output).toContain("(28P01)");
    expect(result.fake.ended).toBe(true);
    expectNoSecrets(result.output);
  });

  test("a failing query rolls back and closes the pool", async () => {
    const result = await preflight({
      ...APPLIED,
      row_counts: Object.assign(new Error(`denied in ${TEST_URL}`), {
        code: "42501",
      }),
    });
    expect(
      result.results.find((r) => r.label === "checks could not finish")?.detail,
    ).toBe("(42501)");
    expect(result.fake.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(result.fake.released && result.fake.ended).toBe(true);
    expectNoSecrets(result.output);
  });

  test("the fixture for any applied count is internally consistent", async () => {
    for (const applied of [1, 2]) {
      const result = await preflight(testDatabaseAfter(applied));
      expect(result.failed).toEqual([]);
    }
  });
});

describe("rowCountsQuery and emptyTables", () => {
  test("counts each approved table, quoted, in one read-only SELECT", () => {
    expect(rowCountsQuery(["projects", "users"])).toBe(
      '/* row_counts */\nSELECT (SELECT count(*)::int FROM public."projects") AS "projects",\n       (SELECT count(*)::int FROM public."users") AS "users"',
    );
  });

  test.each([
    [[]],
    [["users; DROP TABLE users"]],
    [['users" --']],
    [["Users"]],
    [["public.users"]],
  ])("refuses anything but plain lowercase names: %j", (tables) => {
    expect(() => rowCountsQuery(tables)).toThrow(TypeError);
  });

  test("only zero counts are empty", () => {
    expect(emptyTables({ a: 0, b: 0 }, ["a", "b"]).empty).toBe(true);
    expect(emptyTables({ a: 0, b: 1 }, ["a", "b"]).empty).toBe(false);
    expect(emptyTables({ a: 0 }, ["a", "b"]).empty).toBe(false);
    expect(emptyTables({ a: "0", b: 0 }, ["a", "b"]).empty).toBe(false);
  });
});

describe("the test-database SQL", () => {
  test.each([
    ...Object.entries(TEST_QUERIES),
    ["holders", LOCK_QUERIES.holders],
    ["row_counts", rowCountsQuery(ALL_TABLES)],
  ])("%s is read-only", (_, text) => {
    const code = text.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    expect(code).toMatch(/^\/\* \w+ \*\/\nSELECT /);
    expect(code).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|SET|RESET|LOCK|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|COMMENT|SECURITY|nextval|setval|pg_terminate|pg_cancel|pg_reload|set_config|lo_|pg_try_advisory_lock|pg_advisory_lock|pg_advisory_unlock)\b/i,
    );
  });
});
