import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// node-postgres and Drizzle are mocked: these tests never open a socket.
// FakePool records each pool's options and fails the test if anything tries
// to connect or query.
const mocks = vi.hoisted(() => {
  class FakePool {
    static instances: FakePool[] = [];
    static failNext: Error | null = null;
    readonly listeners = new Map<string, (error: unknown) => void>();
    readonly connect = vi.fn(() => {
      throw new Error("FakePool.connect must not be called in unit tests.");
    });
    readonly query = vi.fn(() => {
      throw new Error("FakePool.query must not be called in unit tests.");
    });
    readonly end = vi.fn(async () => {});
    constructor(readonly options: Record<string, unknown>) {
      if (FakePool.failNext) {
        const error = FakePool.failNext;
        FakePool.failNext = null;
        throw error;
      }
      FakePool.instances.push(this);
    }
    on(event: string, listener: (error: unknown) => void) {
      this.listeners.set(event, listener);
      return this;
    }
  }
  const drizzle = vi.fn((config: { client: FakePool }) => ({
    $client: config.client,
  }));
  return { FakePool, drizzle };
});

vi.mock("server-only", () => ({}));
vi.mock("pg", () => ({
  Pool: mocks.FakePool,
  default: { Pool: mocks.FakePool },
}));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: mocks.drizzle }));

const { FakePool, drizzle } = mocks;

// Fictional credentials, distinct per role so a mix-up shows.
const APP_PASSWORD = "FakeApp:p@ss/word";
const MIGRATOR_PASSWORD = "FakeMigrator-secret";
const enc = encodeURIComponent;
const LOCAL_APP_URL = `postgresql://ai_spec_studio_app:${enc(APP_PASSWORD)}@127.0.0.1:5432/ai_spec_studio_dev`;
const LOCAL_MIGRATION_URL = `postgresql://ai_spec_studio_migrator:${enc(MIGRATOR_PASSWORD)}@127.0.0.1:5432/ai_spec_studio_dev`;
const REMOTE_APP_URL = `postgresql://app_user:${enc(APP_PASSWORD)}@db.example.com:5432/studio`;

// A self-signed public certificate made only for these tests (its private
// key was discarded).
const TEST_CA = `-----BEGIN CERTIFICATE-----
MIICPDCCAeICCQC1UuO8joIOOjAKBggqhkjOPQQDAjArMSkwJwYDVQQDDCBhaS1z
cGVjLXN0dWRpbyB0ZXN0IENBIChmaXh0dXJlKTAgFw0yNjExMTUwOTU4NTVaGA8y
MTI2MTAyMjA5NTg1NVowKzEpMCcGA1UEAwwgYWktc3BlYy1zdHVkaW8gdGVzdCBD
QSAoZml4dHVyZSkwggFLMIIBAwYHKoZIzj0CATCB9wIBATAsBgcqhkjOPQEBAiEA
/////wAAAAEAAAAAAAAAAAAAAAD///////////////8wWwQg/////wAAAAEAAAAA
AAAAAAAAAAD///////////////wEIFrGNdiqOpPns+u9VXaYhrxlHQawzFOw9jvO
PD4n0mBLAxUAxJ02CIbnBJNqZnjhE50mt4GffpAEQQRrF9Hy4SxCR/i85uVjpEDy
dwN9gS3rM6D0oTlF2JjClk/jQuL+Gn+bjufrSnwPnhYrzjNXazFezsu2QGg3v1H1
AiEA/////wAAAAD//////////7zm+q2nF56E87nKwvxjJVECAQEDQgAEWb8PIeuo
efBGdBMqoo9AR6D7rqm1niapta7PSrUjUSafgjvuBVme6/pgHPL38dKCnjAkLLB1
8AdFXKyyZtZD0jAKBggqhkjOPQQDAgNIADBFAiEAgIVmJYEYV23UI7P9Quxbj7aH
K+sevzKW+hGC+Qo6HwcCIAW9gjI3KEJVOxSAi85RiwHjakP1MkfknPNgAMRDUdBW
-----END CERTIFICATE-----`;

const DB_VARIABLES = [
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "TEST_DATABASE_URL",
  "DATABASE_SSL_MODE",
  "DATABASE_SSL_CA",
  "DATABASE_POOL_MAX",
  "PGOPTIONS",
  "PGPASSWORD",
  "PGBINARY",
  "PGREPLICATION",
];

function setEnv(values: Record<string, string>) {
  // Start from a known state, whatever the shell or .env files set.
  for (const name of DB_VARIABLES) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

const LOCAL_ENV = { DATABASE_URL: LOCAL_APP_URL, DATABASE_SSL_MODE: "disable" };

async function loadClient() {
  return import("@/lib/db/client");
}

function onlyPool() {
  expect(FakePool.instances).toHaveLength(1);
  return FakePool.instances[0];
}

// Thrown errors must not reveal any credential, in their message or stack.
function expectRedacted(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  const text = `${(error as Error).message}\n${(error as Error).stack ?? ""}`;
  for (const secret of [APP_PASSWORD, MIGRATOR_PASSWORD]) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain(enc(secret));
  }
  expect(text).not.toContain("postgresql://");
  expect(text).not.toContain("Fake");
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected an error.");
}

beforeEach(async () => {
  vi.resetModules();
  FakePool.instances = [];
  FakePool.failNext = null;
  drizzle.mockClear();
  setEnv(LOCAL_ENV);
});

afterEach(async () => {
  const { closeDb } = await loadClient();
  await closeDb();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("lazy initialization", () => {
  test("importing the module creates no pool and opens no connection", async () => {
    await loadClient();
    expect(FakePool.instances).toHaveLength(0);
    expect(drizzle).not.toHaveBeenCalled();
  });

  test("importing doesn't validate the environment", async () => {
    setEnv({});
    await expect(loadClient()).resolves.toBeDefined();
  });

  test("getDb() creates the pool on first use without connecting", async () => {
    const { getDb } = await loadClient();
    const db = getDb();
    const pool = onlyPool();
    expect(db.$client).toBe(pool);
    expect(drizzle).toHaveBeenCalledWith({ client: pool });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("pool reuse", () => {
  test("later calls return the same client and pool", async () => {
    const { getDb } = await loadClient();
    const first = getDb();
    expect(getDb()).toBe(first);
    expect(FakePool.instances).toHaveLength(1);
    expect(drizzle).toHaveBeenCalledTimes(1);
  });

  test("a reloaded module (dev hot reload) reuses the pool", async () => {
    const first = (await loadClient()).getDb();
    vi.resetModules();
    const second = (await loadClient()).getDb();
    expect(second).toBe(first);
    expect(FakePool.instances).toHaveLength(1);
  });

  test("closeDb() ends the pool, and the next getDb() creates a new one", async () => {
    const { getDb, closeDb } = await loadClient();
    getDb();
    const pool = onlyPool();
    await closeDb();
    expect(pool.end).toHaveBeenCalledTimes(1);
    getDb();
    expect(FakePool.instances).toHaveLength(2);
  });

  test("closeDb() without a pool does nothing", async () => {
    const { closeDb } = await loadClient();
    await expect(closeDb()).resolves.toBeUndefined();
  });
});

describe("runtime credentials", () => {
  test("connects as the application role from DATABASE_URL", async () => {
    setEnv({ ...LOCAL_ENV, DATABASE_MIGRATION_URL: LOCAL_MIGRATION_URL });
    (await loadClient()).getDb();
    const { options } = onlyPool();
    expect(options).toMatchObject({
      host: "127.0.0.1",
      port: 5432,
      user: "ai_spec_studio_app",
      password: APP_PASSWORD,
      database: "ai_spec_studio_dev",
    });
    expect(JSON.stringify(options)).not.toContain(MIGRATOR_PASSWORD);
    expect(options).not.toHaveProperty("connectionString");
  });

  test("never falls back to DATABASE_MIGRATION_URL", async () => {
    setEnv({
      DATABASE_MIGRATION_URL: LOCAL_MIGRATION_URL,
      DATABASE_SSL_MODE: "disable",
    });
    const { getDb, DatabaseConfigurationError } = await loadClient();
    const error = captureError(() => getDb());
    expect(error).toBeInstanceOf(DatabaseConfigurationError);
    expect((error as Error).message).toContain("DATABASE_URL is not set.");
    expectRedacted(error);
    expect(FakePool.instances).toHaveLength(0);
  });

  test("pins every setting pg would otherwise read from PG* variables", async () => {
    setEnv({
      ...LOCAL_ENV,
      PGPASSWORD: "FakeFromEnvironment",
      PGAPPNAME: "other-app",
      PGCLIENT_ENCODING: "LATIN1",
    });
    (await loadClient()).getDb();
    const { options } = onlyPool();
    expect(options.password).toBe(APP_PASSWORD);
    expect(options.application_name).toBe("ai-spec-studio");
    expect(options.client_encoding).toBe("UTF8");
    expect(options.options).toMatch(/^-c statement_timeout=\d+ /);
  });

  test.each(["PGBINARY", "PGREPLICATION", "PGOPTIONS"])(
    "refuses to start when %s is set",
    async (name) => {
      setEnv({ ...LOCAL_ENV, [name]: "1" });
      const { getDb } = await loadClient();
      const error = captureError(() => getDb());
      expect((error as Error).message).toContain(`${name} must not be set`);
      expect(FakePool.instances).toHaveLength(0);
    },
  );

  test("applies the pool settings", async () => {
    setEnv({ ...LOCAL_ENV, DATABASE_POOL_MAX: "4" });
    (await loadClient()).getDb();
    expect(onlyPool().options).toMatchObject({
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      maxLifetimeSeconds: 1_800,
    });
  });
});

describe("TLS", () => {
  test("disables TLS for a loopback host with DATABASE_SSL_MODE=disable", async () => {
    (await loadClient()).getDb();
    expect(onlyPool().options.ssl).toBe(false);
  });

  test("verifies the certificate for a remote host by default", async () => {
    setEnv({ DATABASE_URL: REMOTE_APP_URL });
    (await loadClient()).getDb();
    expect(onlyPool().options.ssl).toEqual({ rejectUnauthorized: true });
  });

  test("refuses to disable TLS for a remote host", async () => {
    setEnv({ DATABASE_URL: REMOTE_APP_URL, DATABASE_SSL_MODE: "disable" });
    const { getDb } = await loadClient();
    const error = captureError(() => getDb());
    expect((error as Error).message).toContain(
      "only allowed for loopback hosts",
    );
    expectRedacted(error);
    expect(FakePool.instances).toHaveLength(0);
  });

  test("passes a parsable CA bundle with verification on", async () => {
    setEnv({ DATABASE_URL: REMOTE_APP_URL, DATABASE_SSL_CA: TEST_CA });
    (await loadClient()).getDb();
    expect(onlyPool().options.ssl).toEqual({
      rejectUnauthorized: true,
      ca: TEST_CA,
    });
  });

  test("rejects a CA bundle whose certificate can't be parsed", async () => {
    setEnv({
      DATABASE_URL: REMOTE_APP_URL,
      DATABASE_SSL_CA:
        "-----BEGIN CERTIFICATE-----\nnotARealCertificate\n-----END CERTIFICATE-----",
    });
    const { getDb } = await loadClient();
    const error = captureError(() => getDb());
    expect((error as Error).message).toContain("can't be parsed");
    expectRedacted(error);
    expect(FakePool.instances).toHaveLength(0);
  });
});

describe("errors", () => {
  test("reports invalid settings without values, and caches nothing", async () => {
    setEnv({
      DATABASE_URL: `${REMOTE_APP_URL}?sslmode=require`,
      DATABASE_SSL_MODE: "disable",
    });
    const { getDb, DatabaseConfigurationError } = await loadClient();
    const error = captureError(() => getDb());
    expect(error).toBeInstanceOf(DatabaseConfigurationError);
    expect((error as Error).name).toBe("DatabaseConfigurationError");
    expect((error as Error).message).toMatch(
      /^The database configuration is invalid:\n- /,
    );
    expectRedacted(error);

    setEnv(LOCAL_ENV);
    getDb();
    expect(FakePool.instances).toHaveLength(1);
  });

  test("redacts a pool creation failure and retries on the next call", async () => {
    FakePool.failNext = Object.assign(
      new Error(`bad config for ${LOCAL_APP_URL} (${APP_PASSWORD})`),
      { code: "ERR_FAKE_POOL" },
    );
    const { getDb, DatabaseConfigurationError } = await loadClient();
    const error = captureError(() => getDb());
    expect(error).toBeInstanceOf(DatabaseConfigurationError);
    expect((error as Error).message).toBe(
      "Could not create the database pool for ai_spec_studio_app@127.0.0.1:5432/ai_spec_studio_dev (ERR_FAKE_POOL).",
    );
    expectRedacted(error);

    getDb();
    expect(FakePool.instances).toHaveLength(1);
  });

  test("logs idle-client errors by kind only and keeps the pool", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getDb } = await loadClient();
    const db = getDb();
    const listener = onlyPool().listeners.get("error");
    expect(listener).toBeTypeOf("function");

    listener?.(
      Object.assign(new Error(`terminated: ${APP_PASSWORD}`), {
        code: "57P01",
      }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("(57P01)");
    expect(message).toContain(
      "ai_spec_studio_app@127.0.0.1:5432/ai_spec_studio_dev",
    );
    expect(message).not.toContain(APP_PASSWORD);
    expect(getDb()).toBe(db);
  });
});
