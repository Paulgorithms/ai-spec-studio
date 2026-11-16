import type { Pool, PoolConfig } from "pg";
import { describe, expect, test } from "vitest";
import {
  QUERIES,
  TARGETS,
  configurationCodes,
  errorKind,
  formatResults,
  runLiveVerification,
  type CheckResult,
} from "./live-verification";

// A fake pg pool: no sockets. Each query is answered from canned rows keyed
// by the query's leading /* name */ comment, and every call is recorded.
type Rows = Record<string, unknown>[];
type Answers = Record<string, Rows | Error>;

const PASSWORDS = {
  app: "FakeApp:p@ss/word",
  migrator: "FakeMigrator$secret",
  test: "FakeTest#pw 1",
};
const enc = encodeURIComponent;
const URLS = {
  DATABASE_URL: `postgresql://ai_spec_studio_app:${enc(PASSWORDS.app)}@127.0.0.1:5432/ai_spec_studio_dev`,
  DATABASE_MIGRATION_URL: `postgresql://ai_spec_studio_migrator:${enc(PASSWORDS.migrator)}@127.0.0.1:5432/ai_spec_studio_dev`,
  TEST_DATABASE_URL: `postgresql://ai_spec_studio_test:${enc(PASSWORDS.test)}@127.0.0.1:5432/ai_spec_studio_test`,
};
const GOOD_ENV = { ...URLS, DATABASE_SSL_MODE: "disable" };

function goodAnswers(role: string, database: string, label: string): Answers {
  return {
    identity: [
      {
        current_role_name: role,
        session_role_name: role,
        database_name: database,
        auth_identity: `scram-sha-256:${role}`,
        server_addr: "127.0.0.1/32",
        client_addr: "127.0.0.1/32",
        read_only: "on",
        application_name: "ai-spec-studio",
        client_encoding: "UTF8",
        statement_timeout: "30s",
        idle_in_transaction_timeout: "1min",
        ssl: false,
      },
    ],
    role: [
      {
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    ],
    label: [{ setconfig: [`app.environment=${label}`] }],
    privileges: [
      {
        connect_own: true,
        connect_other: false,
        create_own: role !== "ai_spec_studio_app",
      },
    ],
    state: [
      { app_relations: 0, drizzle_schema: false, migrations_table: false },
    ],
  };
}

type Call = { text: string; values?: unknown[] };
type FakeRun = {
  configs: PoolConfig[];
  calls: Call[][];
  ended: boolean[];
  released: boolean[];
};

function fakePools(
  answersFor: (config: PoolConfig) => Answers,
  options: { connectError?: (config: PoolConfig) => Error | undefined } = {},
) {
  const run: FakeRun = { configs: [], calls: [], ended: [], released: [] };
  const createPool = (config: PoolConfig): Pool => {
    const index = run.configs.push(config) - 1;
    run.calls[index] = [];
    run.ended[index] = false;
    run.released[index] = false;
    const answers = answersFor(config);
    const client = {
      query: async (text: string, values?: unknown[]) => {
        run.calls[index]?.push(
          values === undefined ? { text } : { text, values },
        );
        if (text === QUERIES.begin || text === QUERIES.rollback)
          return { rows: [] };
        const name = /^\/\* (\w+) \*\//.exec(text)?.[1] ?? "";
        const answer = answers[name];
        if (answer instanceof Error) throw answer;
        return { rows: answer ?? [] };
      },
      release: () => {
        run.released[index] = true;
      },
    };
    const pool = {
      totalCount: 1,
      on: () => pool,
      connect: async () => {
        const error = options.connectError?.(config);
        if (error) throw error;
        return client;
      },
      end: async () => {
        run.ended[index] = true;
        pool.totalCount = 0;
      },
    };
    return pool as unknown as Pool;
  };
  return { run, createPool };
}

function answersByUser(overrides: Partial<Record<string, Answers>> = {}) {
  return (config: PoolConfig): Answers => {
    const target = TARGETS.find((t) => t.role === config.user);
    if (!target) throw new Error("unexpected user");
    return {
      ...goodAnswers(target.role, target.database, target.environmentLabel),
      ...overrides[target.key],
    };
  };
}

function failed(results: CheckResult[]) {
  return results.filter((r) => !r.pass).map((r) => r.label);
}

function expectNoSecrets(text: string) {
  for (const password of Object.values(PASSWORDS)) {
    expect(text).not.toContain(password);
    expect(text).not.toContain(enc(password));
  }
  expect(text).not.toContain("postgresql://");
  expect(text).not.toContain("Fake");
}

describe("runLiveVerification with correct settings", () => {
  test("passes every check and closes every pool", async () => {
    const { run, createPool } = fakePools(answersByUser());
    const results = await runLiveVerification(GOOD_ENV, createPool);
    expect(failed(results)).toEqual([]);
    expect(run.configs).toHaveLength(3);
    expect(run.ended).toEqual([true, true, true]);
    expect(run.released).toEqual([true, true, true]);
    const output = formatResults(results);
    expect(output).toMatch(/ALL 62 CHECKS PASSED$/);
    expectNoSecrets(output);
  });

  test("connects each role with its own password, one connection, no TLS", async () => {
    const { run, createPool } = fakePools(answersByUser());
    await runLiveVerification(GOOD_ENV, createPool);
    expect(run.configs.map((c) => [c.user, c.database, c.password])).toEqual([
      ["ai_spec_studio_app", "ai_spec_studio_dev", PASSWORDS.app],
      ["ai_spec_studio_migrator", "ai_spec_studio_dev", PASSWORDS.migrator],
      ["ai_spec_studio_test", "ai_spec_studio_test", PASSWORDS.test],
    ]);
    for (const config of run.configs) {
      expect(config).toMatchObject({
        host: "127.0.0.1",
        ssl: false,
        max: 1,
        allowExitOnIdle: true,
        application_name: "ai-spec-studio",
      });
      expect(config).not.toHaveProperty("connectionString");
    }
  });

  test("runs only SELECTs inside a READ ONLY transaction that is rolled back", async () => {
    const { run, createPool } = fakePools(answersByUser());
    await runLiveVerification(GOOD_ENV, createPool);
    for (const calls of run.calls) {
      expect(calls[0]?.text).toBe("BEGIN TRANSACTION READ ONLY");
      expect(calls.at(-1)?.text).toBe("ROLLBACK");
      for (const call of calls.slice(1, -1)) {
        expect(call.text).toMatch(/^\/\* \w+ \*\/\nSELECT /);
      }
    }
    // The privilege query receives the database names as parameters.
    expect(
      run.calls[0]?.find((c) => c.text === QUERIES.privileges)?.values,
    ).toEqual(["ai_spec_studio_dev", "ai_spec_studio_test"]);
    expect(
      run.calls[2]?.find((c) => c.text === QUERIES.privileges)?.values,
    ).toEqual(["ai_spec_studio_test", "ai_spec_studio_dev"]);
  });
});

describe("the SQL", () => {
  // Strip string literals, then look for any statement that could write.
  test.each(Object.entries(QUERIES))("%s is read-only", (_, text) => {
    const code = text.replace(/'[^']*'/g, "''");
    expect(code).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|SET|RESET|LOCK|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|COMMENT|SECURITY|nextval|setval|pg_terminate|pg_cancel|pg_reload|set_config|lo_)\b/i,
    );
  });
});

describe("runLiveVerification fails closed", () => {
  test("never connects when a URL points to a remote host", async () => {
    const { run, createPool } = fakePools(answersByUser());
    const results = await runLiveVerification(
      {
        ...GOOD_ENV,
        DATABASE_URL: `postgresql://ai_spec_studio_app:${enc(PASSWORDS.app)}@db.example.com:5432/ai_spec_studio_dev`,
      },
      createPool,
    );
    expect(failed(results)).toContain(
      "app: DATABASE_URL passes the project validator",
    );
    expect(run.configs.map((c) => c.user)).not.toContain("ai_spec_studio_app");
    expectNoSecrets(formatResults(results));
  });

  test("never connects when a URL names the wrong role", async () => {
    const { run, createPool } = fakePools(answersByUser());
    const results = await runLiveVerification(
      { ...GOOD_ENV, DATABASE_URL: URLS.DATABASE_MIGRATION_URL },
      createPool,
    );
    expect(failed(results)).toEqual([
      "app: DATABASE_URL is ai_spec_studio_app on loopback port 5432, database ai_spec_studio_dev",
      "app: connection skipped (unexpected target)",
    ]);
    expect(run.configs).toHaveLength(2);
  });

  test("never connects to a port other than the local server's", async () => {
    const { run, createPool } = fakePools(answersByUser());
    const results = await runLiveVerification(
      {
        ...GOOD_ENV,
        TEST_DATABASE_URL: URLS.TEST_DATABASE_URL.replace(":5432/", ":5433/"),
      },
      createPool,
    );
    expect(failed(results)).toEqual([
      "test: TEST_DATABASE_URL is ai_spec_studio_test on loopback port 5432, database ai_spec_studio_test",
      "test: connection skipped (unexpected target)",
    ]);
    expect(run.configs).toHaveLength(2);
  });

  test("reports a missing variable without connecting for it", async () => {
    const { run, createPool } = fakePools(answersByUser());
    const results = await runLiveVerification(
      { ...GOOD_ENV, TEST_DATABASE_URL: undefined },
      createPool,
    );
    expect(results.find((r) => r.label.startsWith("test:"))).toEqual({
      pass: false,
      label: "test: TEST_DATABASE_URL passes the project validator",
      detail: "(NOT_SET)",
    });
    expect(run.configs).toHaveLength(2);
  });

  test("names unexpected PG* and TLS variables without their values", async () => {
    const { createPool } = fakePools(answersByUser());
    const results = await runLiveVerification(
      {
        ...GOOD_ENV,
        PGPASSWORD: "FakeEnvPassword",
        PGHOST: "db.example.com",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
      createPool,
    );
    expect(results[0]).toEqual({
      pass: false,
      label:
        "environment: no PG*, NODE_TLS_REJECT_UNAUTHORIZED, or NODE_EXTRA_CA_CERTS variables",
      detail: "set: NODE_TLS_REJECT_UNAUTHORIZED, PGHOST, PGPASSWORD",
    });
    const output = formatResults(results);
    expect(output).not.toContain("FakeEnvPassword");
    expect(output).not.toContain("db.example.com");
  });

  test.each([
    [
      "a superuser role",
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
      "app: role has no superuser, CREATEROLE, CREATEDB, REPLICATION, or BYPASSRLS",
    ],
    [
      "access to the other database",
      {
        privileges: [
          { connect_own: true, connect_other: true, create_own: false },
        ],
      },
      "app: may not connect to ai_spec_studio_test (catalog check)",
    ],
    [
      "CREATE on the database for the app role",
      {
        privileges: [
          { connect_own: true, connect_other: false, create_own: true },
        ],
      },
      "app: may not create schemas in ai_spec_studio_dev",
    ],
    [
      "an applied migration",
      {
        state: [
          { app_relations: 0, drizzle_schema: true, migrations_table: true },
        ],
      },
      "app: no migrations applied (no drizzle schema or migrations table)",
    ],
    [
      "an application table",
      {
        state: [
          { app_relations: 2, drizzle_schema: false, migrations_table: false },
        ],
      },
      "app: no application tables, views, or sequences in ai_spec_studio_dev",
    ],
    [
      "a missing environment label",
      { label: [] },
      "app: database is labeled app.environment=development",
    ],
    [
      "a different label",
      { label: [{ setconfig: ["app.environment=production"] }] },
      "app: database is labeled app.environment=development",
    ],
  ])("fails on %s", async (_, override, label) => {
    const { createPool } = fakePools(
      answersByUser({ app: override as Answers }),
    );
    const results = await runLiveVerification(GOOD_ENV, createPool);
    expect(failed(results)).toEqual([label]);
  });

  test.each([
    [
      "trust or peer authentication",
      { auth_identity: null },
      "app: authenticated with SCRAM-SHA-256 (system_user)",
    ],
    [
      "a TLS session",
      { ssl: true },
      "app: session is not using TLS (pg_stat_ssl)",
    ],
    [
      "a non-loopback server address",
      { server_addr: "10.0.0.5/32" },
      "app: server and client addresses are loopback",
    ],
    [
      "the wrong database",
      { database_name: "postgres" },
      "app: current_database() is ai_spec_studio_dev",
    ],
    [
      "the wrong role",
      { current_role_name: "postgres" },
      "app: current_user is ai_spec_studio_app",
    ],
    ["a writable session", { read_only: "off" }, "app: session is read-only"],
    [
      "overridden session settings",
      { statement_timeout: "0" },
      "app: session settings come from the pool configuration",
    ],
  ])("fails on %s", async (_, change, label) => {
    const identity = {
      ...(
        goodAnswers("ai_spec_studio_app", "ai_spec_studio_dev", "development")
          .identity as Rows
      )[0],
      ...change,
    };
    const { createPool } = fakePools(
      answersByUser({ app: { identity: [identity] } }),
    );
    const results = await runLiveVerification(GOOD_ENV, createPool);
    expect(failed(results)).toEqual([label]);
  });
});

describe("errors and cleanup", () => {
  test("reports a failed login by SQLSTATE only and still closes the pool", async () => {
    const { run, createPool } = fakePools(answersByUser(), {
      connectError: (config) =>
        config.user === "ai_spec_studio_migrator"
          ? Object.assign(
              new Error(
                `password authentication failed for "${config.password}" via ${URLS.DATABASE_MIGRATION_URL}`,
              ),
              { code: "28P01" },
            )
          : undefined,
    });
    const results = await runLiveVerification(GOOD_ENV, createPool);
    expect(results.filter((r) => !r.pass)).toEqual([
      {
        pass: false,
        label: "migrator: verification could not finish",
        detail: "(28P01)",
      },
    ]);
    expect(run.ended).toEqual([true, true, true]);
    expectNoSecrets(formatResults(results));
  });

  test("rolls back and closes the pool when a query fails", async () => {
    const queryError = Object.assign(
      new Error(`relation in ${URLS.TEST_DATABASE_URL}`),
      {
        code: "42501",
      },
    );
    const { run, createPool } = fakePools(
      answersByUser({ test: { label: queryError } }),
    );
    const results = await runLiveVerification(GOOD_ENV, createPool);
    expect(failed(results)).toEqual(["test: verification could not finish"]);
    expect(run.calls[2]?.at(-1)?.text).toBe("ROLLBACK");
    expect(run.released[2]).toBe(true);
    expect(run.ended[2]).toBe(true);
    expectNoSecrets(formatResults(results));
  });

  test("reports a pool that throws on creation without its message", async () => {
    const results = await runLiveVerification(GOOD_ENV, () => {
      throw new Error(`bad config ${URLS.DATABASE_URL}`);
    });
    expect(failed(results)).toHaveLength(3);
    expect(
      results.find((r) => r.label === "app: verification could not finish")
        ?.detail,
    ).toBe("(Error)");
    expectNoSecrets(formatResults(results));
  });
});

describe("errorKind", () => {
  test.each([
    [Object.assign(new Error("x"), { code: "ECONNREFUSED" }), "ECONNREFUSED"],
    [Object.assign(new Error("x"), { code: "28P01" }), "28P01"],
    [
      Object.assign(new Error("x"), { code: "not a code: FakeSecret" }),
      "Error",
    ],
    [Object.assign(new Error("x"), { code: "FAKESECRETVALUE" }), "Error"],
    [
      Object.assign(new Error("x"), { code: "ERR_SOCKET_CLOSED" }),
      "ERR_SOCKET_CLOSED",
    ],
    [
      Object.assign(new Error("x"), { name: "FakeSecretName" }),
      "unknown error",
    ],
    [new TypeError("FakeSecret"), "TypeError"],
    ["FakeSecret", "unknown error"],
    [null, "unknown error"],
  ])("%#: reports a code or class name only", (error, kind) => {
    expect(errorKind(error)).toBe(kind);
  });
});

describe("fails closed on the environment before any connection", () => {
  test.each([
    ["PGPASSWORD", "FakeEnvSecret-1"],
    ["PGHOST", "FakeEnvSecret-2.example.com"],
    ["PGSSLMODE", "FakeEnvSecret-3"],
    ["PGOPTIONS", "-c FakeEnvSecret=4"],
    ["PGBINARY", "FakeEnvSecret-5"],
    ["PGREPLICATION", "FakeEnvSecret-6"],
    ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
    ["NODE_EXTRA_CA_CERTS", "/tmp/FakeEnvSecret-7.pem"],
  ])("never creates a pool when %s is set", async (name, value) => {
    let poolsCreated = 0;
    const results = await runLiveVerification(
      { ...GOOD_ENV, [name]: value },
      () => {
        poolsCreated += 1;
        throw new Error("The pool factory must not be called.");
      },
    );
    expect(poolsCreated).toBe(0);
    expect(results.at(-1)).toEqual({
      pass: false,
      label:
        "all targets: connections skipped (unexpected environment variables)",
    });
    expect(results.some((r) => /^(app|migrator|test):/.test(r.label))).toBe(
      false,
    );
    const output = formatResults(results);
    expect(output).toContain(name);
    expect(output).not.toContain(value);
    expectNoSecrets(output);
  });

  test("an empty PG* variable still counts as set", async () => {
    let poolsCreated = 0;
    await runLiveVerification({ ...GOOD_ENV, PGUSER: "" }, () => {
      poolsCreated += 1;
      throw new Error("The pool factory must not be called.");
    });
    expect(poolsCreated).toBe(0);
  });
});

describe("redaction with dummy secrets", () => {
  const SECRET = "FakeSecretValue-9f3";
  const secretUrl = (user: string, host: string, rest = "") =>
    `postgresql://${user}:${SECRET}@${host}:5432/ai_spec_studio_dev${rest}`;

  test.each([
    [
      "a query parameter",
      {
        DATABASE_URL: secretUrl(
          "ai_spec_studio_app",
          "127.0.0.1",
          `?password=${SECRET}`,
        ),
      },
      "QUERY_PARAMETERS",
    ],
    [
      "an unknown query parameter",
      {
        DATABASE_URL: secretUrl(
          "ai_spec_studio_app",
          "127.0.0.1",
          `?${SECRET}`,
        ),
      },
      "QUERY_PARAMETERS",
    ],
    [
      "a fragment",
      {
        DATABASE_URL: secretUrl(
          "ai_spec_studio_app",
          "127.0.0.1",
          `#${SECRET}`,
        ),
      },
      "FRAGMENT",
    ],
    [
      "an unencoded password",
      {
        DATABASE_URL: `postgresql://ai_spec_studio_app:${SECRET}@x@127.0.0.1/ai_spec_studio_dev`,
      },
      null,
    ],
    [
      "no port",
      {
        DATABASE_URL: `postgresql://ai_spec_studio_app:${SECRET}@127.0.0.1/ai_spec_studio_dev`,
      },
      "PORT",
    ],
    [
      "no password",
      {
        DATABASE_URL:
          "postgresql://ai_spec_studio_app@127.0.0.1:5432/ai_spec_studio_dev",
      },
      "PASSWORD",
    ],
    [
      "a bad password encoding",
      {
        DATABASE_URL: `postgresql://ai_spec_studio_app:${SECRET}%ZZ@127.0.0.1:5432/ai_spec_studio_dev`,
      },
      "PASSWORD",
    ],
    [
      "a remote host with TLS off",
      { DATABASE_URL: secretUrl("ai_spec_studio_app", "db.example.com") },
      "TLS_REMOTE_DISABLE",
    ],
    [
      "a secret in the user name",
      {
        DATABASE_URL: `postgresql://${SECRET}:${SECRET}@127.0.0.1:5432/ai_spec_studio_dev`,
      },
      null,
    ],
    [
      "a CA bundle with TLS off",
      {
        DATABASE_SSL_CA: `-----BEGIN CERTIFICATE-----\n${SECRET}\n-----END CERTIFICATE-----`,
      },
      "TLS_CA",
    ],
  ])("keeps the secret out of the output for %s", async (_, change, code) => {
    const { createPool } = fakePools(answersByUser());
    const results = await runLiveVerification(
      { ...GOOD_ENV, ...change },
      createPool,
    );
    const output = formatResults(results);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(encodeURIComponent(SECRET));
    expect(output).not.toContain("postgresql://");
    expect(output).toMatch(/CHECKS FAILED$/);
    if (code) expect(output).toContain(`(${code})`);
  });

  test("passing output contains no password, URL, or configuration", async () => {
    const { createPool } = fakePools(answersByUser());
    const output = formatResults(
      await runLiveVerification(GOOD_ENV, createPool),
    );
    expect(output).toMatch(/ALL 62 CHECKS PASSED$/);
    expectNoSecrets(output);
    expect(output).not.toMatch(/127\.0\.0\.1|ssl: |password:/);
  });

  test("driver errors are reported by code, with their message dropped", async () => {
    const { createPool } = fakePools(answersByUser(), {
      connectError: () =>
        Object.assign(new Error(`FATAL for ${URLS.DATABASE_URL}`), {
          code: "28P01",
        }),
    });
    const output = formatResults(
      await runLiveVerification(GOOD_ENV, createPool),
    );
    expect(output.match(/\(28P01\)/g)).toHaveLength(3);
    expect(output).not.toContain("FATAL");
    expectNoSecrets(output);
  });
});

describe("configurationCodes", () => {
  test.each([
    ["DATABASE_URL is not set.", "NOT_SET"],
    ["DATABASE_URL is not a valid URL.", "INVALID_URL"],
    ["DATABASE_URL must start with postgresql:// or postgres://.", "SCHEME"],
    [
      "DATABASE_URL must include a host name. Unix socket connections aren't supported.",
      "HOST",
    ],
    ["DATABASE_URL must include an explicit port, such as :5432.", "PORT"],
    ["DATABASE_URL must include a user name (the database role).", "USER"],
    [
      "DATABASE_URL must include a password (postgresql://<role>:<password>@…).",
      "PASSWORD",
    ],
    ["DATABASE_URL has a database name longer than 63 bytes.", "DATABASE"],
    ["DATABASE_SSL_MODE must be verify-full or disable.", "TLS_MODE"],
    [
      "DATABASE_SSL_MODE=disable is only allowed for loopback hosts, and DATABASE_URL points to a remote host. Use verify-full.",
      "TLS_REMOTE_DISABLE",
    ],
    ["DATABASE_SSL_CA contains a certificate that can't be parsed.", "TLS_CA"],
    [
      "PGOPTIONS must not be set. Database session settings are configured in code.",
      "PGOPTIONS",
    ],
    [
      "Test database access is refused when NODE_ENV is production.",
      "NODE_ENV_PRODUCTION",
    ],
    [
      "TEST_DATABASE_URL must name a database ending in _test.",
      "TEST_DATABASE_NAME",
    ],
    [
      "TEST_DATABASE_URL must point to a loopback host (localhost, 127.0.0.1, or ::1).",
      "TEST_HOST_NOT_LOOPBACK",
    ],
    [
      "TEST_DATABASE_URL must not point to the same database as DATABASE_URL.",
      "TEST_SAME_DATABASE",
    ],
    [
      "DATABASE_URL is set but invalid, so TEST_DATABASE_URL can't be confirmed to be a different database. Fix or unset DATABASE_URL.",
      "OTHER_URL_INVALID",
    ],
    ["The database password is missing.", "PASSWORD"],
    ["Something new that contains FakeSecretValue", "OTHER"],
  ])("%s -> %s", (message, code) => {
    expect(configurationCodes([message])).toBe(code);
  });

  test("lists each code once", () => {
    expect(
      configurationCodes([
        "DATABASE_URL is not set.",
        "DATABASE_URL is not set.",
        "x",
      ]),
    ).toBe("NOT_SET, OTHER");
  });
});

describe("configurationCodes covers the real validator messages", () => {
  const base = "ai_spec_studio_app:Fake-pw@127.0.0.1:5432/ai_spec_studio_dev";
  test.each([
    { DATABASE_URL: "" },
    { DATABASE_URL: "not a url" },
    { DATABASE_URL: `mysql://${base}` },
    { DATABASE_URL: "postgresql:///ai_spec_studio_dev" },
    { DATABASE_URL: `postgresql://${base}?sslmode=require` },
    { DATABASE_URL: `postgresql://${base}#x` },
    { DATABASE_URL: "postgresql://app:Fake-pw@local%68ost:5432/db" },
    { DATABASE_URL: "postgresql://app:Fake-pw@127.0.0.1/db" },
    { DATABASE_URL: "postgresql://:Fake-pw@127.0.0.1:5432/db" },
    { DATABASE_URL: "postgresql://app%ZZ:Fake-pw@127.0.0.1:5432/db" },
    { DATABASE_URL: "postgresql://app:@127.0.0.1:5432/db" },
    { DATABASE_URL: "postgresql://app:Fake%ZZ@127.0.0.1:5432/db" },
    { DATABASE_URL: "postgresql://app:Fake-pw@127.0.0.1:5432/" },
    { DATABASE_URL: `postgresql://${base}`, DATABASE_SSL_MODE: "require" },
    {
      DATABASE_URL: "postgresql://app:Fake-pw@db.example.com:5432/db",
      DATABASE_SSL_MODE: "disable",
    },
    {
      DATABASE_URL: `postgresql://${base}`,
      DATABASE_SSL_MODE: "disable",
      DATABASE_SSL_CA: "x",
    },
    {
      DATABASE_URL: "postgresql://app:Fake-pw@db.example.com:5432/db",
      DATABASE_SSL_CA: "x",
    },
    {
      DATABASE_URL: `postgresql://${base}`,
      DATABASE_SSL_MODE: "disable",
      DATABASE_POOL_MAX: "0",
    },
  ])("runtime env %# maps to known codes", async (env) => {
    const { createPool } = fakePools(answersByUser());
    const results = await runLiveVerification(
      { ...GOOD_ENV, DATABASE_SSL_MODE: undefined, ...env },
      createPool,
    );
    const detail = results.find((r) =>
      r.label.startsWith("app: DATABASE_URL passes"),
    )?.detail;
    expect(detail).toMatch(/^\([A-Z_, ]+\)$/);
    // DATABASE_POOL_MAX has no code of its own: it's the one expected OTHER.
    if (!("DATABASE_POOL_MAX" in env))
      expect(detail?.slice(1, -1).split(", ")).not.toContain("OTHER");
  });

  test.each([
    {
      TEST_DATABASE_URL:
        "postgresql://ai_spec_studio_test:Fake-pw@127.0.0.1:5432/ai_spec_studio_dev",
    },
    {
      TEST_DATABASE_URL:
        "postgresql://ai_spec_studio_test:Fake-pw@db.example.com:5432/x_test",
    },
    { NODE_ENV: "production" },
    {
      DATABASE_URL: "postgresql://ai_spec_studio_app:Fake-pw@127.0.0.1/no_port",
    },
  ])("test env %# maps to known codes", async (env) => {
    const { createPool } = fakePools(answersByUser());
    const results = await runLiveVerification(
      { ...GOOD_ENV, ...env },
      createPool,
    );
    const detail = results.find((r) =>
      r.label.startsWith("test: TEST_DATABASE_URL passes"),
    )?.detail;
    expect(detail).toMatch(/^\([A-Z_, ]+\)$/);
    expect(detail?.slice(1, -1).split(", ")).not.toContain("OTHER");
  });
});
