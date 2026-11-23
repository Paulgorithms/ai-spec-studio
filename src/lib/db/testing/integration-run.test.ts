import type { Pool, PoolConfig } from "pg";
import { describe, expect, test } from "vitest";
import {
  APPLIED,
  BROKEN,
  FILES,
  FRESH,
  PARTIAL,
  journalRows,
  rowCounts,
  type Answers,
} from "../../../../scripts/db/lib/fixtures/test-database-answers";
import {
  QUERIES,
  type MigrationFiles,
} from "../../../../scripts/db/lib/migration-checks";
import { LOCK_QUERIES } from "../../../../scripts/db/lib/test-database-target";
import {
  DATABASE_VARIABLES,
  IntegrationRunError,
  assertWorkerEnvironment,
  isolateIntegrationEnvironment,
  mergeIntegrationEnvironment,
  requireIntegrationOptIn,
  startIntegrationRun,
} from "./integration-run";

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

// One fake lock connection. Each BEGIN starts the next phase's answers:
// before, locked, teardown.
class FakeLockClient {
  readonly texts: string[] = [];
  releases = 0;
  private phase = -1;
  constructor(
    private readonly phases: Answers[],
    private readonly lock: { acquired?: unknown; released?: unknown },
  ) {}
  async query(config: string | { text: string }) {
    const text = typeof config === "string" ? config : config.text;
    this.texts.push(text);
    if (text === QUERIES.begin) {
      this.phase += 1;
      return { rows: [] };
    }
    if (text === QUERIES.rollback) return { rows: [] };
    if (text === LOCK_QUERIES.tryLock)
      return { rows: [{ acquired: this.lock.acquired ?? true }] };
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
    this.releases += 1;
  }
}

async function start(
  options: {
    env?: Record<string, string | undefined>;
    phases?: Answers[];
    lock?: { acquired?: unknown; released?: unknown };
    files?: MigrationFiles;
  } = {},
) {
  const fake = {
    pools: [] as PoolConfig[],
    ended: false,
    emitError: ((): void => {}) as (error: unknown) => void,
  };
  const client = new FakeLockClient(
    options.phases ?? [APPLIED, APPLIED, APPLIED],
    options.lock ?? {},
  );
  const createPool = (config: PoolConfig) => {
    fake.pools.push(config);
    const pool = {
      totalCount: 1,
      on: (event: string, listener: (error: unknown) => void) => {
        if (event === "error") fake.emitError = listener;
        return pool;
      },
      connect: async () => client,
      end: async () => {
        fake.ended = true;
        pool.totalCount = 0;
      },
    };
    return pool as unknown as Pool;
  };
  const outcome = await startIntegrationRun(
    options.env ?? ENV,
    createPool,
    options.files ?? FILES,
  ).then(
    (run) => ({ run, error: undefined }),
    (error: unknown) => ({ run: undefined, error }),
  );
  const lockCalls = () =>
    client.texts.filter(
      (t) => t === LOCK_QUERIES.tryLock || t === LOCK_QUERIES.unlock,
    );
  return { ...outcome, fake, client, lockCalls };
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function expectNoSecrets(text: string) {
  for (const secret of [PASSWORD, "FakeApp-pw", "FakeMig-pw"]) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain(enc(secret));
  }
  expect(text).not.toContain("postgresql://");
}

describe("a normal run", () => {
  test("holds the lock from setup until teardown on one connection", async () => {
    const r = await start();
    expect(r.error).toBeUndefined();
    expect(r.run?.connection).toMatchObject({
      user: "ai_spec_studio_test",
      database: "ai_spec_studio_test",
      ssl: false,
    });
    expect(r.fake.pools).toHaveLength(1);
    expect(r.fake.pools[0]).toMatchObject({
      user: "ai_spec_studio_test",
      max: 1,
    });

    // During the run: taken once, not released, connection still checked out.
    expect(r.lockCalls()).toEqual([LOCK_QUERIES.tryLock]);
    expect(r.client.releases).toBe(0);
    expect(r.fake.ended).toBe(false);

    await r.run?.finish();
    expect(r.lockCalls()).toEqual([LOCK_QUERIES.tryLock, LOCK_QUERIES.unlock]);
    expect(r.client.releases).toBe(1);
    expect(r.fake.ended).toBe(true);
    // Teardown only reads: nothing is ever deleted or reset.
    for (const text of r.client.texts) {
      expect(text.replace(/'[^']*'/g, "''")).not.toMatch(
        /\b(DELETE|TRUNCATE|DROP|INSERT|UPDATE)\b/i,
      );
    }
  });

  test("finish is idempotent", async () => {
    const r = await start();
    await r.run?.finish();
    await r.run?.finish();
    expect(r.lockCalls()).toEqual([LOCK_QUERIES.tryLock, LOCK_QUERIES.unlock]);
  });
});

describe("setup refuses to start", () => {
  test("when another run or migration holds the lock", async () => {
    const r = await start({ lock: { acquired: false } });
    expect(r.error).toBeInstanceOf(IntegrationRunError);
    expect(message(r.error)).toContain("lock: held by another session");
    expect(r.lockCalls()).toEqual([LOCK_QUERIES.tryLock]);
    expect(r.client.releases).toBe(1);
    expect(r.fake.ended).toBe(true);
  });

  test.each([
    ["a fresh (unmigrated) database", FRESH],
    ["a partially migrated database (0001_auth_tables pending)", PARTIAL],
    ["a broken migration state", BROKEN],
    [
      "rows left in a table",
      { ...APPLIED, row_counts: rowCounts(2, { projects: 1 }) },
    ],
    [
      "a session left in the auth tables",
      { ...APPLIED, row_counts: rowCounts(2, { sessions: 1 }) },
    ],
    [
      "the development label",
      { ...APPLIED, label: [{ setconfig: ["app.environment=development"] }] },
    ],
    ["the lock already held", { ...APPLIED, lock_holders: [{ holders: 1 }] }],
  ])("for %s, before taking the lock", async (_, answers) => {
    const r = await start({ phases: [answers as Answers] });
    expect(r.error).toBeInstanceOf(IntegrationRunError);
    expect(r.lockCalls()).toEqual([]);
    expect(r.client.releases).toBe(1);
    expect(r.fake.ended).toBe(true);
    expectNoSecrets(message(r.error));
  });

  test("when the state changes under the lock, and releases it", async () => {
    const r = await start({
      phases: [
        APPLIED,
        { ...APPLIED, row_counts: rowCounts(2, { verifications: 2 }) },
      ],
    });
    expect(r.error).toBeInstanceOf(IntegrationRunError);
    expect(message(r.error)).toContain(
      "FAIL  locked: state: all 6 tables are empty",
    );
    expect(r.lockCalls()).toEqual([LOCK_QUERIES.tryLock, LOCK_QUERIES.unlock]);
    expect(r.fake.ended).toBe(true);
  });

  test.each([
    [
      "the development database as TEST_DATABASE_URL",
      { ...ENV, TEST_DATABASE_URL: DEV_URL },
    ],
    [
      "the migration URL as TEST_DATABASE_URL",
      { ...ENV, TEST_DATABASE_URL: MIGRATION_URL },
    ],
    ["no TEST_DATABASE_URL", { DATABASE_URL: DEV_URL }],
    ["a PG* variable", { ...ENV, PGPASSWORD: "FakeEnvPw" }],
    ["production", { ...ENV, NODE_ENV: "production" }],
  ])("without connecting, for %s", async (_, env) => {
    const r = await start({ env });
    expect(r.error).toBeInstanceOf(IntegrationRunError);
    expect(r.fake.pools).toHaveLength(0);
    expect(message(r.error)).toContain(
      "connection skipped (a check above failed)",
    );
    expectNoSecrets(message(r.error));
    expect(message(r.error)).not.toContain("FakeEnvPw");
  });
});

test("setup refuses modified migration files without connecting", async () => {
  const r = await start({
    files: {
      ...FILES,
      sha256: { ...FILES.sha256, "0001_auth_tables.sql": "0".repeat(64) },
    },
  });
  expect(r.error).toBeInstanceOf(IntegrationRunError);
  expect(r.fake.pools).toHaveLength(0);
  expect(message(r.error)).toContain(
    "FAIL  files: 0001_auth_tables.sql matches the reviewed SHA-256",
  );
});

describe("teardown", () => {
  test("detects rows a test left behind, reports them, deletes nothing, and still cleans up", async () => {
    const r = await start({
      phases: [
        APPLIED,
        APPLIED,
        {
          ...APPLIED,
          row_counts: rowCounts(2, {
            projects: 2,
            specifications: 1,
            users: 3,
          }),
        },
      ],
    });
    const error = await r.run!.finish().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationRunError);
    expect(message(error)).toContain(
      "FAIL  after: all 6 tables are still empty (no test left rows behind)\n      (accounts: 0, projects: 2, sessions: 0, specifications: 1, users: 3, verifications: 0)",
    );
    expect(r.lockCalls()).toEqual([LOCK_QUERIES.tryLock, LOCK_QUERIES.unlock]);
    expect(r.client.releases).toBe(1);
    expect(r.fake.ended).toBe(true);
    for (const text of r.client.texts)
      expect(text.replace(/'[^']*'/g, "''")).not.toMatch(
        /\b(DELETE|TRUNCATE|DROP)\b/i,
      );
  });

  test.each([
    [
      "a lost lock",
      { ...APPLIED, lock_holders_while_locked: [{ mine: 0, others: 0 }] },
      "after: this connection still holds the advisory lock, and no other does",
    ],
    [
      "a second holder",
      { ...APPLIED, lock_holders_while_locked: [{ mine: 1, others: 1 }] },
      "after: this connection still holds the advisory lock, and no other does",
    ],
    [
      "a changed journal",
      { ...APPLIED, journal: [] },
      "after: the migration journal is unchanged",
    ],
    [
      "a journal missing 0001",
      { ...APPLIED, journal: journalRows(1) },
      "after: the migration journal is unchanged",
    ],
  ])("fails on %s", async (_, teardown, label) => {
    const r = await start({ phases: [APPLIED, APPLIED, teardown as Answers] });
    const error = await r.run!.finish().catch((e: unknown) => e);
    expect(message(error)).toContain(`FAIL  ${label}`);
    expect(r.fake.ended).toBe(true);
  });

  test("fails when the lock connection reported an error during the run", async () => {
    const r = await start();
    r.fake.emitError(
      Object.assign(new Error(`terminated ${TEST_URL}`), { code: "57P01" }),
    );
    const error = await r.run!.finish().catch((e: unknown) => e);
    expect(message(error)).toContain(
      "FAIL  the lock connection stayed healthy during the run\n      (57P01)",
    );
    expectNoSecrets(message(error));
  });

  test("fails when PostgreSQL refuses to release the lock", async () => {
    const r = await start({ lock: { released: false } });
    const error = await r.run!.finish().catch((e: unknown) => e);
    expect(message(error)).toContain("FAIL  lock: released");
  });

  test("a failing teardown query is reported by code, and cleanup still runs", async () => {
    const r = await start({
      phases: [
        APPLIED,
        APPLIED,
        {
          ...APPLIED,
          row_counts: Object.assign(new Error("x"), { code: "42501" }),
        },
      ],
    });
    const error = await r.run!.finish().catch((e: unknown) => e);
    expect(message(error)).toContain(
      "FAIL  after: checks could not finish\n      (42501)",
    );
    expect(r.lockCalls().at(-1)).toBe(LOCK_QUERIES.unlock);
    expect(r.fake.ended).toBe(true);
  });
});

describe("environment isolation", () => {
  test("the integration run must be requested explicitly", () => {
    expect(() => requireIntegrationOptIn({})).toThrow(
      /npm run test:integration/,
    );
    expect(() =>
      requireIntegrationOptIn({ AI_SPEC_STUDIO_INTEGRATION: "1" }),
    ).not.toThrow();
  });

  test("shell values take precedence over .env.local, and process.env isn't written", () => {
    const processEnv = { TEST_DATABASE_URL: "from-shell" };
    const merged = mergeIntegrationEnvironment(
      { TEST_DATABASE_URL: "from-file", DATABASE_URL: "dev" },
      processEnv,
    );
    expect(merged).toEqual({
      TEST_DATABASE_URL: "from-shell",
      DATABASE_URL: "dev",
    });
    expect(processEnv).toEqual({ TEST_DATABASE_URL: "from-shell" });
  });

  test("every database variable is removed before workers start", () => {
    const processEnv: Record<string, string | undefined> = Object.fromEntries(
      DATABASE_VARIABLES.map((name) => [name, "x"]),
    );
    processEnv.PATH = "/usr/bin";
    isolateIntegrationEnvironment(processEnv);
    expect(processEnv).toEqual({ PATH: "/usr/bin" });
    expect(DATABASE_VARIABLES).toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "DATABASE_MIGRATION_URL",
        "TEST_DATABASE_URL",
      ]),
    );
  });

  test.each([
    "DATABASE_URL",
    "DATABASE_MIGRATION_URL",
    "TEST_DATABASE_URL",
    "PGPASSWORD",
    "PGHOST",
  ])(
    "a worker refuses to run with %s in its environment, naming it only",
    (name) => {
      expect(() => assertWorkerEnvironment({ [name]: "FakeSecret" })).toThrow(
        `(set: ${name})`,
      );
      expect(() =>
        assertWorkerEnvironment({ [name]: "FakeSecret" }),
      ).not.toThrow(/FakeSecret/);
    },
  );

  test("a worker with a clean environment runs", () => {
    expect(() =>
      assertWorkerEnvironment({ PATH: "/usr/bin", NODE_ENV: "test" }),
    ).not.toThrow();
  });
});
