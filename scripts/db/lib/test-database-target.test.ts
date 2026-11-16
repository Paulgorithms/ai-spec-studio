import type { Pool, PoolConfig } from "pg";
import { describe, expect, test } from "vitest";
import {
  PROJECT_SLUG_PATTERN,
  SPECIFICATION_KEY_PATTERN,
} from "../../../src/lib/db/schema";
import { formatResults, type CheckResult } from "./live-verification";
import {
  APPROVED_MIGRATION,
  EXPECTED_COLUMNS,
  EXPECTED_CONSTRAINTS,
  EXPECTED_INDEXES,
  QUERIES,
  REGEX_CASES,
  type MigrationFiles,
} from "./migration-checks";
import {
  LOCK_QUERIES,
  TEST_DATABASE_LOCK,
  TEST_QUERIES,
  checkTestDatabaseConfiguration,
  runTestDatabasePreflight,
  withTestDatabaseLock,
  type LockClient,
} from "./test-database-target";

type Rows = Record<string, unknown>[];
type Answers = Record<string, Rows | Error>;

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
const FILES: MigrationFiles = {
  journalEntries: 1,
  tag: APPROVED_MIGRATION.tag,
  when: 1794739919891,
  sha256: APPROVED_MIGRATION.sha256,
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

const DEFS: Record<string, string> = {
  projects_pkey: "PRIMARY KEY (id)",
  projects_slug_format_check: `CHECK ((slug ~ '${PROJECT_SLUG_PATTERN}'::text))`,
  projects_slug_unique: "UNIQUE (slug)",
  specifications_key_format_check: `CHECK ((key ~ '${SPECIFICATION_KEY_PATTERN}'::text))`,
  specifications_key_unique: "UNIQUE (key)",
  specifications_pkey: "PRIMARY KEY (id)",
  specifications_project_id_fkey:
    "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT",
  specifications_status_check:
    "CHECK ((status = ANY (ARRAY['draft'::text, 'in-review'::text, 'approved'::text])))",
};

function pg18Constraints(): Rows {
  const all = [
    ...EXPECTED_CONSTRAINTS.map(([table_name, name, type]) => ({
      table_name,
      name,
      type,
      definition: DEFS[name],
      column_name: null,
    })),
    ...EXPECTED_COLUMNS.map(([table_name, column]) => ({
      table_name,
      name: `${table_name}_${column}_not_null`,
      type: "n",
      definition: `NOT NULL ${column}`,
      column_name: column,
    })),
  ];
  const key = (r: { table_name: string; name: string }) =>
    `${r.table_name}\u0000${r.name}`;
  return all.sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

const SESSION = {
  version_num: 180006,
  server_addr: "127.0.0.1/32",
  server_port: 5432,
  client_addr: "127.0.0.1/32",
  current_role_name: "ai_spec_studio_test",
  session_role_name: "ai_spec_studio_test",
  database_name: "ai_spec_studio_test",
  auth_identity: "scram-sha-256:ai_spec_studio_test",
  search_path: '"$user", public',
  current_schema_name: "public",
  read_only: "on",
  ssl: false,
};

const COMMON: Answers = {
  session: [SESSION],
  role: [
    {
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
    },
  ],
  label: [{ setconfig: ["app.environment=test"] }],
  memberships: [{ memberships: 0 }],
  privileges: [{ create_db: true, usage_public: true, create_public: true }],
  sessions: [{ other_migrator_sessions: 0 }],
  lock_holders: [{ holders: 0 }],
  regex: REGEX_CASES.map((c, i) => ({ i: i + 1, matched: c.matches })),
};

const FRESH: Answers = {
  ...COMMON,
  objects: [
    {
      projects: false,
      specifications: false,
      journal: false,
      public_relations: 0,
    },
  ],
  schemas: [{ name: "public" }],
};

const APPLIED: Answers = {
  ...COMMON,
  objects: [
    {
      projects: true,
      specifications: true,
      journal: true,
      public_relations: 8,
    },
  ],
  schemas: [{ name: "drizzle" }, { name: "public" }],
  journal: [{ hash: APPROVED_MIGRATION.sha256, created_at: "1794739919891" }],
  journal_owner: [
    { schema_owner: "ai_spec_studio_test", table_owner: "ai_spec_studio_test" },
  ],
  tables: ["projects", "specifications"].map((name) => ({
    name,
    kind: "r",
    owner: "ai_spec_studio_test",
    rls: false,
  })),
  columns: EXPECTED_COLUMNS.map(
    ([table_name, column_name, type, nullable, default_value]) => ({
      table_name,
      column_name,
      type,
      nullable,
      default_value,
    }),
  ),
  constraints: pg18Constraints(),
  indexes: EXPECTED_INDEXES.map(([table_name, name, fragment]) => ({
    table_name,
    name,
    definition: `CREATE INDEX ${name} ON public.${table_name} ${fragment}`,
  })),
  extras: [{ triggers: 0, functions: 0 }],
  foreign_grants: ["projects", "specifications"].map((table_name) => ({
    table_name,
    app_any: false,
    migrator_any: false,
    public_any: false,
  })),
  row_counts: [{ projects: 0, specifications: 0 }],
};

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

describe("runTestDatabasePreflight", () => {
  test("a fresh test database passes, read-only, and the pool closes", async () => {
    const result = await preflight(FRESH);
    expect(result.failed).toEqual([]);
    expect(result.state).toBe("fresh");
    expect(result.output).toMatch(/ALL 30 CHECKS PASSED$/);
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

  test("a database with exactly the approved migration passes", async () => {
    const result = await preflight(APPLIED);
    expect(result.failed).toEqual([]);
    expect(result.state).toBe("applied");
    expect(result.output).toMatch(/ALL 40 CHECKS PASSED$/);
    expect(result.output).toContain(
      "PASS  state: the approved migration is applied exactly",
    );
    expect(result.output).toContain(
      "PASS  tables: exactly projects and specifications in public, owned by ai_spec_studio_test, no row-level security",
    );
    expect(
      result.fake.calls.find((c) => c.text === TEST_QUERIES.foreignGrants)
        ?.values,
    ).toEqual(["ai_spec_studio_app", "ai_spec_studio_migrator"]);
  });

  const UNEXPECTED =
    "state: neither fresh nor exactly the approved migration (partial or unexpected)";
  test.each([
    [
      "a drizzle schema without a journal",
      { ...FRESH, schemas: [{ name: "drizzle" }, { name: "public" }] },
      "(DRIZZLE_SCHEMA, NO_JOURNAL, NO_PROJECTS, NO_SPECIFICATIONS, PUBLIC_EMPTY)",
    ],
    [
      "tables without a journal",
      {
        ...FRESH,
        objects: [
          {
            projects: true,
            specifications: true,
            journal: false,
            public_relations: 8,
          },
        ],
      },
      "(NO_DRIZZLE_SCHEMA, NO_JOURNAL, PROJECTS, SPECIFICATIONS, PUBLIC_NOT_EMPTY)",
    ],
    [
      "a journal without tables",
      {
        ...FRESH,
        schemas: [{ name: "drizzle" }, { name: "public" }],
        objects: [
          {
            projects: false,
            specifications: false,
            journal: true,
            public_relations: 0,
          },
        ],
      },
      "(DRIZZLE_SCHEMA, JOURNAL, NO_PROJECTS, NO_SPECIFICATIONS, PUBLIC_EMPTY)",
    ],
    [
      "something else in public",
      {
        ...FRESH,
        objects: [
          {
            projects: false,
            specifications: false,
            journal: false,
            public_relations: 1,
          },
        ],
      },
      "(NO_DRIZZLE_SCHEMA, NO_JOURNAL, NO_PROJECTS, NO_SPECIFICATIONS, PUBLIC_NOT_EMPTY)",
    ],
  ])("rejects a partial state: %s", async (_, answers, detail) => {
    const result = await preflight(answers as Answers);
    expect(result.state).toBe("unexpected");
    expect(result.results.find((r) => r.label === UNEXPECTED)?.detail).toBe(
      detail,
    );
  });

  const EXACT = "state: the approved migration is applied exactly";
  test.each([
    [
      "an empty journal",
      { journal: [] },
      "journal: exactly one applied migration, with the hash and timestamp of 0000_initial_schema",
    ],
    [
      "two journal rows",
      { journal: [...(APPLIED.journal as Rows), ...(APPLIED.journal as Rows)] },
      "journal: exactly one applied migration, with the hash and timestamp of 0000_initial_schema",
    ],
    [
      "a different migration hash",
      { journal: [{ hash: "0".repeat(64), created_at: "1794739919891" }] },
      "journal: exactly one applied migration, with the hash and timestamp of 0000_initial_schema",
    ],
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
      "tables owned by the migrator",
      {
        tables: ["projects", "specifications"].map((name) => ({
          name,
          kind: "r",
          owner: "ai_spec_studio_migrator",
          rls: false,
        })),
      },
      "tables: exactly projects and specifications in public, owned by ai_spec_studio_test, no row-level security",
    ],
    [
      "a changed constraint",
      {
        constraints: pg18Constraints().map((r) =>
          r.name === "specifications_project_id_fkey"
            ? {
                ...r,
                definition:
                  "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE",
              }
            : r,
        ),
      },
      "constraints: primary keys, UNIQUE, CHECK, and the RESTRICT foreign key as reviewed",
    ],
    [
      "a grant to the app role",
      {
        foreign_grants: ["projects", "specifications"].map((table_name) => ({
          table_name,
          app_any: true,
          migrator_any: false,
          public_any: false,
        })),
      },
      "grants: the app role, the migrator, and PUBLIC have no table privileges",
    ],
    [
      "rows left behind",
      { row_counts: [{ projects: 1, specifications: 0 }] },
      "state: both tables are empty (nothing left by earlier runs)",
    ],
  ])("an applied database with %s is unexpected", async (_, change, label) => {
    const result = await preflight({ ...APPLIED, ...(change as Answers) });
    expect(result.state).toBe("unexpected");
    expect(result.failed).toEqual([label, EXACT]);
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
      "a changed migration file",
      { files: { ...FILES, sha256: "0".repeat(64) } },
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
});

describe("the test-database SQL", () => {
  test.each([
    ...Object.entries(TEST_QUERIES),
    ["holders", LOCK_QUERIES.holders],
  ])("%s is read-only", (_, text) => {
    const code = text.replace(/'[^']*'/g, "''");
    expect(code).toMatch(/^\/\* \w+ \*\/\nSELECT /);
    expect(code).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|SET|RESET|LOCK|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|COMMENT|SECURITY|nextval|setval|pg_terminate|pg_cancel|pg_reload|set_config|lo_|pg_try_advisory_lock|pg_advisory_lock|pg_advisory_unlock)\b/i,
    );
  });
});
