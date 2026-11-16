import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { describe, expect, test } from "vitest";
import {
  APPLIED,
  FRESH,
  PARTIAL,
  SESSION,
  type Answers,
  type Rows,
} from "./fixtures/test-database-answers";
import { formatResults } from "./live-verification";
import {
  APPROVED_MIGRATION,
  QUERIES,
  type MigrationFiles,
} from "./migration-checks";
import { readMigrationFiles } from "./migration-files";
import {
  assertDedicatedClient,
  drizzleApplyMigration,
  migrationErrorKind,
  runTestDatabaseMigration,
  type ApplyMigration,
} from "./test-database-migration";
import { LOCK_QUERIES, TEST_DATABASE_LOCK } from "./test-database-target";

const PASSWORD = "FakeTest:p@ss/word";
const MIGRATOR_PASSWORD = "FakeMigrator-pw";
const enc = encodeURIComponent;
const TEST_URL = `postgresql://ai_spec_studio_test:${enc(PASSWORD)}@127.0.0.1:5432/ai_spec_studio_test`;
const MIGRATION_URL = `postgresql://ai_spec_studio_migrator:${enc(MIGRATOR_PASSWORD)}@127.0.0.1:5432/ai_spec_studio_dev`;
const ENV = {
  TEST_DATABASE_URL: TEST_URL,
  DATABASE_MIGRATION_URL: MIGRATION_URL,
  DATABASE_SSL_MODE: "disable",
};
const FILES: MigrationFiles = {
  journalEntries: 1,
  tag: APPROVED_MIGRATION.tag,
  when: 1794739919891,
  sha256: APPROVED_MIGRATION.sha256,
};
const LOCK_KEYS = [TEST_DATABASE_LOCK.classId, TEST_DATABASE_LOCK.objectId];

// A fake checked-out client: answers by the query's /* name */ comment, with
// a different set of answers for each read-only phase (each BEGIN starts the
// next one: before, locked, after).
class FakeSessionClient {
  readonly calls: string[] = [];
  released = false;
  private phase = -1;
  constructor(
    private readonly phases: Answers[],
    private readonly lock: {
      acquired?: unknown;
      released?: unknown;
      tryError?: Error;
    },
  ) {}
  async query(textOrConfig: string | { text: string }) {
    const text =
      typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
    this.calls.push(text);
    if (text === QUERIES.begin) {
      this.phase += 1;
      return { rows: [] };
    }
    if (text === QUERIES.rollback) return { rows: [] };
    if (text === LOCK_QUERIES.tryLock) {
      if (this.lock.tryError) throw this.lock.tryError;
      return { rows: [{ acquired: this.lock.acquired ?? true }] };
    }
    if (text === LOCK_QUERIES.unlock)
      return { rows: [{ released: this.lock.released ?? true }] };
    const answers =
      this.phases[Math.min(this.phase, this.phases.length - 1)] ?? {};
    const name = /^\/\* (\w+) \*\//.exec(text)?.[1] ?? "";
    const answer = answers[name];
    if (answer instanceof Error) throw answer;
    return { rows: answer ?? [] };
  }
  release() {
    this.released = true;
  }
}

type RunOptions = {
  env?: Record<string, string | undefined>;
  files?: MigrationFiles;
  phases?: Answers[];
  lock?: { acquired?: unknown; released?: unknown; tryError?: Error };
  connectError?: Error;
  apply?: (client: PoolClient) => Promise<void>;
};

async function runner(options: RunOptions = {}) {
  const fake = {
    pools: [] as PoolConfig[],
    connects: 0,
    ended: false,
    client: undefined as FakeSessionClient | undefined,
    applied: [] as unknown[],
  };
  const client = new FakeSessionClient(
    options.phases ?? [FRESH, FRESH, APPLIED],
    options.lock ?? {},
  );
  fake.client = client;
  const createPool = (config: PoolConfig) => {
    fake.pools.push(config);
    const pool = {
      totalCount: 1,
      on: () => pool,
      connect: async () => {
        fake.connects += 1;
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
  const apply: ApplyMigration = async (session) => {
    fake.applied.push(session);
    client.calls.push("<migrate>");
    await options.apply?.(session);
  };
  const { results, outcome } = await runTestDatabaseMigration(
    options.env ?? ENV,
    createPool,
    options.files ?? FILES,
    apply,
  );
  const output = formatResults(results);
  return {
    results,
    outcome,
    output,
    fake,
    failed: results.filter((r) => !r.pass).map((r) => r.label),
    lockCalls: client.calls.filter(
      (t) => t === LOCK_QUERIES.tryLock || t === LOCK_QUERIES.unlock,
    ),
  };
}

function expectNoSecrets(output: string) {
  for (const secret of [PASSWORD, MIGRATOR_PASSWORD]) {
    expect(output).not.toContain(secret);
    expect(output).not.toContain(enc(secret));
  }
  expect(output).not.toContain("postgresql://");
}

describe("the fresh state", () => {
  test("migrates once, on the locked session, and verifies the result", async () => {
    const r = await runner();
    expect(r.failed).toEqual([]);
    expect(r.outcome).toBe("migrated");
    expect(r.output).toMatch(/ALL 83 CHECKS PASSED$/);

    // One pool, one connection, one client for everything.
    expect(r.fake.pools).toHaveLength(1);
    expect(r.fake.connects).toBe(1);
    expect(r.fake.applied).toEqual([r.fake.client]);

    // Order on that one session: checks, lock, checks, migrate, checks, unlock.
    const calls = r.fake.client!.calls;
    const at = (text: string, from = 0) => calls.indexOf(text, from);
    const tryLock = at(LOCK_QUERIES.tryLock);
    const migrateAt = at("<migrate>");
    const unlock = at(LOCK_QUERIES.unlock);
    expect(at(QUERIES.begin)).toBeLessThan(tryLock);
    expect(at(QUERIES.begin, tryLock)).toBeLessThan(migrateAt);
    expect(at(QUERIES.begin, migrateAt)).toBeLessThan(unlock);
    expect(unlock).toBe(calls.length - 1);
    expect(r.lockCalls).toEqual([LOCK_QUERIES.tryLock, LOCK_QUERIES.unlock]);

    expect(r.fake.client!.released).toBe(true);
    expect(r.fake.ended).toBe(true);
    for (const label of [
      "lock: acquired on this session",
      "migration: 0000_initial_schema applied",
      "after: state: the approved migration is applied exactly",
      "locked: concurrency: this session holds the test-database advisory lock, and no other session does",
      "lock: released",
      "pool closed",
    ]) {
      expect(r.output).toContain(`PASS  ${label}`);
    }
    expectNoSecrets(r.output);
  });

  test("connects as the test role from TEST_DATABASE_URL, never the migrator", async () => {
    const r = await runner();
    expect(r.fake.pools[0]).toMatchObject({
      user: "ai_spec_studio_test",
      database: "ai_spec_studio_test",
      host: "127.0.0.1",
      port: 5432,
      password: PASSWORD,
      ssl: false,
      max: 1,
    });
    expect(JSON.stringify(r.fake.pools[0])).not.toContain(MIGRATOR_PASSWORD);
    expect(JSON.stringify(r.fake.pools[0])).not.toContain(
      "ai_spec_studio_migrator",
    );
  });
});

describe("the applied state", () => {
  test("is a no-op: no migration, verified under the lock, lock released", async () => {
    const r = await runner({ phases: [APPLIED, APPLIED] });
    expect(r.failed).toEqual([]);
    expect(r.outcome).toBe("up-to-date");
    expect(r.fake.applied).toEqual([]);
    expect(r.output).toContain(
      "PASS  migration: not needed (the approved migration is already applied)",
    );
    expect(r.lockCalls).toEqual([LOCK_QUERIES.tryLock, LOCK_QUERIES.unlock]);
    expect(r.fake.ended).toBe(true);
  });
});

describe("unexpected states", () => {
  test("a partial state stops before the lock is taken", async () => {
    const r = await runner({ phases: [PARTIAL] });
    expect(r.outcome).toBe("not-migrated");
    expect(r.fake.applied).toEqual([]);
    expect(r.lockCalls).toEqual([]);
    expect(r.failed).toContain(
      "stopped before taking the lock (see the failures above)",
    );
    expect(r.fake.client!.released && r.fake.ended).toBe(true);
  });

  test.each([
    [
      "an unexpected object in public",
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
    ],
    [
      "an applied state with the wrong hash",
      {
        ...APPLIED,
        journal: [{ hash: "0".repeat(64), created_at: "1794739919891" }],
      },
    ],
    [
      "an applied state with rows",
      { ...APPLIED, row_counts: [{ projects: 3, specifications: 0 }] },
    ],
    [
      "the development label",
      { ...FRESH, label: [{ setconfig: ["app.environment=development"] }] },
    ],
    [
      "the wrong database",
      {
        ...FRESH,
        session: [{ ...SESSION, database_name: "ai_spec_studio_dev" }],
      },
    ],
    [
      "the wrong role",
      {
        ...FRESH,
        session: [{ ...SESSION, current_role_name: "ai_spec_studio_migrator" }],
      },
    ],
    ["the lock already held", { ...FRESH, lock_holders: [{ holders: 1 }] }],
  ])("%s stops before the lock", async (_, answers) => {
    const r = await runner({ phases: [answers as Answers] });
    expect(r.outcome).toBe("not-migrated");
    expect(r.lockCalls).toEqual([]);
    expect(r.fake.applied).toEqual([]);
    expect(r.failed.at(-1)).toBe(
      "stopped before taking the lock (see the failures above)",
    );
  });

  test("a state that changes under the lock: no migration, lock released", async () => {
    const r = await runner({ phases: [FRESH, PARTIAL] });
    expect(r.outcome).toBe("not-migrated");
    expect(r.fake.applied).toEqual([]);
    expect(r.failed).toContain(
      "migration: not run (the state changed or a check failed under the lock)",
    );
    expect(r.lockCalls).toEqual([LOCK_QUERIES.tryLock, LOCK_QUERIES.unlock]);
  });

  test("another holder appearing under the lock: no migration", async () => {
    const r = await runner({
      phases: [
        FRESH,
        { ...FRESH, lock_holders_while_locked: [{ mine: 1, others: 1 }] },
      ],
    });
    expect(r.outcome).toBe("not-migrated");
    expect(r.fake.applied).toEqual([]);
    expect(r.failed).toContain(
      "locked: concurrency: this session holds the test-database advisory lock, and no other session does",
    );
  });
});

describe("the advisory lock", () => {
  test("unavailable: nothing changes, nothing to release", async () => {
    const r = await runner({ lock: { acquired: false } });
    expect(r.outcome).toBe("not-migrated");
    expect(r.fake.applied).toEqual([]);
    expect(r.lockCalls).toEqual([LOCK_QUERIES.tryLock]);
    expect(r.failed).toContain(
      "lock: held by another session (a migration or test run is in progress); nothing was changed",
    );
    expect(r.fake.client!.released && r.fake.ended).toBe(true);
  });

  test("an acquisition error: reported by code, no migration, pool closed", async () => {
    const r = await runner({
      lock: {
        tryError: Object.assign(new Error(`x ${TEST_URL}`), { code: "57P01" }),
      },
    });
    expect(r.outcome).toBe("not-migrated");
    expect(r.fake.applied).toEqual([]);
    expect(
      r.results.find((x) => x.label === "migration runner could not finish")
        ?.detail,
    ).toBe("(57P01)");
    expect(r.fake.ended).toBe(true);
    expectNoSecrets(r.output);
  });

  test("a release PostgreSQL rejects is a failure", async () => {
    const r = await runner({ lock: { released: false } });
    expect(r.failed).toEqual(["lock: released"]);
  });

  test("is taken and released with the fixed key on the same session", async () => {
    const r = await runner();
    expect(r.lockCalls).toHaveLength(2);
    expect(LOCK_KEYS).toEqual([0x41495353, 1]);
  });
});

describe("failures during and after the migration", () => {
  test("a migration failure stops for review, rolls back, records the state, and releases the lock", async () => {
    const r = await runner({
      phases: [FRESH, FRESH, PARTIAL],
      apply: async () => {
        throw Object.assign(new Error(`syntax error near ${TEST_URL}`), {
          code: "42601",
        });
      },
    });
    expect(r.outcome).toBe("not-migrated");
    expect(
      r.results.find((x) => x.label.startsWith("migration: failed")),
    ).toEqual({
      pass: false,
      label: "migration: failed; stopped for review (don't rerun it)",
      detail: "(42601)",
    });
    const calls = r.fake.client!.calls;
    const migrateAt = calls.indexOf("<migrate>");
    expect(calls[migrateAt + 1]).toBe(QUERIES.rollback);
    expect(r.failed).toContain(
      "after failure: state: neither fresh nor exactly the approved migration (partial or unexpected)",
    );
    expect(calls.at(-1)).toBe(LOCK_QUERIES.unlock);
    expect(r.fake.client!.released && r.fake.ended).toBe(true);
    expectNoSecrets(r.output);
  });

  test("a drizzle-wrapped failure is reported by the PostgreSQL SQLSTATE", async () => {
    const r = await runner({
      phases: [FRESH, FRESH, FRESH],
      apply: async () => {
        throw Object.assign(
          new Error(`Failed query: CREATE ... params: ${PASSWORD}`),
          {
            cause: Object.assign(new Error("relation exists"), {
              code: "42P07",
            }),
          },
        );
      },
    });
    expect(
      r.results.find((x) => x.label.startsWith("migration: failed"))?.detail,
    ).toBe("(42P07)");
    expect(r.output).not.toContain("Failed query");
    expectNoSecrets(r.output);
  });

  test("a postflight failure stops for review and releases the lock", async () => {
    const r = await runner({
      phases: [
        FRESH,
        FRESH,
        {
          ...APPLIED,
          journal: [{ hash: "0".repeat(64), created_at: "1794739919891" }],
        },
      ],
    });
    expect(r.outcome).toBe("not-migrated");
    expect(r.failed).toContain(
      "after: the result isn't exactly the approved migration; stopped for review",
    );
    expect(r.lockCalls).toEqual([LOCK_QUERIES.tryLock, LOCK_QUERIES.unlock]);
    expect(r.fake.ended).toBe(true);
  });

  test("a query error under the lock still releases it", async () => {
    const r = await runner({
      phases: [
        FRESH,
        {
          ...FRESH,
          memberships: Object.assign(new Error("gone"), { code: "08006" }),
        },
      ],
    });
    expect(r.outcome).toBe("not-migrated");
    expect(
      r.results.find((x) => x.label === "migration runner could not finish")
        ?.detail,
    ).toBe("(08006)");
    expect(r.lockCalls).toEqual([LOCK_QUERIES.tryLock, LOCK_QUERIES.unlock]);
    expect(r.fake.client!.released && r.fake.ended).toBe(true);
  });

  test("a failed connection: no lock, pool closed", async () => {
    const r = await runner({
      connectError: Object.assign(new Error(PASSWORD), { code: "28P01" }),
    });
    expect(r.outcome).toBe("not-migrated");
    expect(r.lockCalls).toEqual([]);
    expect(r.fake.ended).toBe(true);
    expectNoSecrets(r.output);
  });
});

describe("no connection before the safety checks pass", () => {
  test.each([
    [
      "no TEST_DATABASE_URL",
      {
        env: {
          DATABASE_MIGRATION_URL: MIGRATION_URL,
          DATABASE_SSL_MODE: "disable",
        },
      },
    ],
    [
      "only the development migration URL as the test URL",
      { env: { ...ENV, TEST_DATABASE_URL: MIGRATION_URL } },
    ],
    [
      "the wrong role",
      {
        env: {
          ...ENV,
          TEST_DATABASE_URL: TEST_URL.replace(
            "ai_spec_studio_test:",
            "ai_spec_studio_app:",
          ),
        },
      },
    ],
    [
      "a remote host",
      {
        env: {
          ...ENV,
          TEST_DATABASE_URL: TEST_URL.replace("127.0.0.1", "db.example.com"),
        },
      },
    ],
    [
      "another database",
      {
        env: {
          ...ENV,
          TEST_DATABASE_URL: TEST_URL.replace(
            /ai_spec_studio_test$/,
            "other_test",
          ),
        },
      },
    ],
    ["a PG* variable", { env: { ...ENV, PGPASSWORD: "FakeEnvPw" } }],
    ["production", { env: { ...ENV, NODE_ENV: "production" } }],
    [
      "a changed migration file",
      { files: { ...FILES, sha256: "0".repeat(64) } },
    ],
    ["a second journal entry", { files: { ...FILES, journalEntries: 2 } }],
  ])("%s", async (_, options) => {
    const r = await runner(options);
    expect(r.fake.pools).toHaveLength(0);
    expect(r.fake.applied).toEqual([]);
    expect(r.outcome).toBe("not-migrated");
    expect(r.failed.at(-1)).toBe("connection skipped (a check above failed)");
    expectNoSecrets(r.output);
    expect(r.output).not.toContain("FakeEnvPw");
  });
});

// The real drizzle-orm 0.45.4 migrator, on a fake checked-out client: every
// statement must reach that one client, including begin and commit.
describe("drizzleApplyMigration", () => {
  class FakeCheckedOutClient {
    readonly texts: string[] = [];
    readonly values: unknown[][] = [];
    async query(config: string | { text: string }, values?: unknown[]) {
      const text = typeof config === "string" ? config : config.text;
      this.texts.push(text.replace(/\s+/g, " ").trim());
      this.values.push(values ?? []);
      return { rows: [], rowCount: 0, fields: [], command: "" };
    }
    release() {}
  }

  test("runs every migration statement on the one client it is given", async () => {
    const client = new FakeCheckedOutClient();
    await drizzleApplyMigration(client as unknown as PoolClient);
    const sql = readFileSync("drizzle/0000_initial_schema.sql", "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.replace(/\s+/g, " ").trim());
    expect(client.texts[0]).toBe('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    expect(client.texts[1]).toMatch(
      /^CREATE TABLE IF NOT EXISTS "drizzle"\."__drizzle_migrations"/,
    );
    expect(client.texts[2]).toMatch(
      /^select id, hash, created_at from "drizzle"\."__drizzle_migrations"/,
    );
    expect(client.texts[3]).toBe("begin");
    expect(client.texts.slice(4, 4 + sql.length)).toEqual(sql);
    expect(client.texts[4 + sql.length]).toMatch(
      /^insert into "drizzle"\."__drizzle_migrations"/,
    );
    expect(client.values[4 + sql.length]).toEqual([
      APPROVED_MIGRATION.sha256,
      readMigrationFiles().when,
    ]);
    expect(client.texts[5 + sql.length]).toBe("commit");
    expect(client.texts).toHaveLength(6 + sql.length);
  });

  test("rolls back on the same client when a statement fails", async () => {
    const client = new FakeCheckedOutClient();
    const original = client.query.bind(client);
    client.query = async (config, values) => {
      const result = await original(config, values);
      if (client.texts.at(-1)?.startsWith('CREATE TABLE "specifications"')) {
        throw Object.assign(new Error("boom"), { code: "42P07" });
      }
      return result;
    };
    const failure = await drizzleApplyMigration(
      client as unknown as PoolClient,
    ).catch((error: unknown) => error);
    // drizzle wraps it; the SQLSTATE stays reachable, and only it is reported.
    expect(failure).toMatchObject({ cause: { code: "42P07" } });
    expect(migrationErrorKind(failure)).toBe("42P07");
    expect(client.texts.at(-1)).toBe("rollback");
    expect(client.texts).not.toContain("commit");
  });

  test("refuses a pool, or anything that isn't a checked-out client", async () => {
    const pool = new Pool({ max: 1 });
    try {
      await expect(
        drizzleApplyMigration(pool as unknown as PoolClient),
      ).rejects.toThrow(TypeError);
    } finally {
      await pool.end();
    }
    class LooksLikeAPool {
      async query() {
        return { rows: [] };
      }
      release() {}
    }
    expect(() => assertDedicatedClient(new LooksLikeAPool())).toThrow(
      TypeError,
    );
    expect(() =>
      assertDedicatedClient({ query: async () => ({ rows: [] }) }),
    ).toThrow(TypeError);
    expect(() => assertDedicatedClient(null)).toThrow(TypeError);
    expect(() =>
      assertDedicatedClient(new FakeCheckedOutClient()),
    ).not.toThrow();
  });

  test("a real pg checked-out client is a pg.Client, which drizzle doesn't treat as a pool", () => {
    // pg-pool hands out instances of pool.Client, which is pg.Client.
    const pool = new Pool({ max: 1 });
    expect((pool as unknown as { Client: unknown }).Client).toBe(
      (Pool as unknown as { Client?: unknown }).Client ??
        (pool as unknown as { Client: unknown }).Client,
    );
    const Client = (
      pool as unknown as { Client: new (config: object) => object }
    ).Client;
    const client = new Client({});
    expect(Object.getPrototypeOf(client).constructor.name).toBe("Client");
    expect(client instanceof Pool).toBe(false);
    void pool.end();
  });
});

describe("the read-only SQL used under the lock", () => {
  test("is a SELECT that never takes or releases locks", () => {
    const text = LOCK_QUERIES.holdersWhileLocked;
    expect(text).toMatch(/^\/\* \w+ \*\/\nSELECT /);
    expect(text).not.toMatch(/pg_(try_)?advisory_(un)?lock/);
  });

  test("the fixtures have one approved journal row", () => {
    expect((APPLIED.journal as Rows)[0]).toEqual({
      hash: APPROVED_MIGRATION.sha256,
      created_at: String(FILES.when),
    });
  });
});
