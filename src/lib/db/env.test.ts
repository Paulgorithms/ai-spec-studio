import { describe, expect, test } from "vitest";
import {
  DEFAULT_POOL_MAX,
  describeDatabaseTarget,
  isLoopbackHost,
  parseMigrationDatabaseEnv,
  parseRuntimeDatabaseEnv,
  parseTestDatabaseEnv,
  type DatabaseEnv,
  type EnvParseResult,
} from "@/lib/db/env";

// Fictional credentials. The password contains characters that must be
// percent-encoded, so the redaction checks cover both forms.
const PASSWORD = "Fake:p@ss/w0rd";
const ENCODED_PASSWORD = encodeURIComponent(PASSWORD);

const LOCAL_APP_URL = `postgresql://ai_spec_studio_app:${ENCODED_PASSWORD}@127.0.0.1:5432/ai_spec_studio_dev`;
const LOCAL_MIGRATION_URL = `postgresql://ai_spec_studio_migrator:${ENCODED_PASSWORD}@127.0.0.1:5432/ai_spec_studio_dev`;
const LOCAL_TEST_URL = `postgresql://ai_spec_studio_test:${ENCODED_PASSWORD}@127.0.0.1:5432/ai_spec_studio_test`;
const REMOTE_URL = `postgresql://app_user:${ENCODED_PASSWORD}@db.example.com:5432/studio`;

const PEM = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBfakeCERTIFICATEdataONLYforTESTS",
  "-----END CERTIFICATE-----",
].join("\n");

function expectErrors<T>(result: EnvParseResult<T>): string[] {
  if (result.ok) throw new Error("Expected the env to be rejected.");
  return result.errors;
}

function expectValue<T>(result: EnvParseResult<T>): T {
  if (!result.ok) throw new Error(`Unexpected errors: ${result.errors}`);
  return result.value;
}

function expectNoSecrets(output: string) {
  expect(output).not.toContain(PASSWORD);
  expect(output).not.toContain(ENCODED_PASSWORD);
  expect(output).not.toContain("Fake");
}

describe("parseRuntimeDatabaseEnv", () => {
  test("accepts a local database without TLS", () => {
    const { connection, poolMax } = expectValue(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: LOCAL_APP_URL,
        DATABASE_SSL_MODE: "disable",
      }),
    );
    expect(connection).toEqual({
      host: "127.0.0.1",
      port: 5432,
      database: "ai_spec_studio_dev",
      user: "ai_spec_studio_app",
      password: PASSWORD,
      ssl: false,
    });
    expect(poolMax).toBe(DEFAULT_POOL_MAX);
  });

  test("defaults to full certificate verification", () => {
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({ DATABASE_URL: REMOTE_URL }),
    );
    expect(connection.ssl).toEqual({ rejectUnauthorized: true });
    expect(connection.host).toBe("db.example.com");
  });

  test("treats an empty DATABASE_SSL_MODE as verify-full", () => {
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: REMOTE_URL,
        DATABASE_SSL_MODE: "  ",
      }),
    );
    expect(connection.ssl).toEqual({ rejectUnauthorized: true });
  });

  test("accepts verify-full on a loopback host", () => {
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: LOCAL_APP_URL,
        DATABASE_SSL_MODE: "verify-full",
      }),
    );
    expect(connection.ssl).toEqual({ rejectUnauthorized: true });
  });

  test("normalizes the host and accepts the postgres:// scheme", () => {
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({
        DATABASE_URL:
          "postgres://app:Fake-pw@LocalHost:5433/ai_spec_studio_dev",
        DATABASE_SSL_MODE: "disable",
      }),
    );
    expect(connection.host).toBe("localhost");
    expect(connection.port).toBe(5433);
  });

  test("accepts an IPv6 loopback host without brackets in the result", () => {
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: "postgresql://app:Fake-pw@[::1]:5432/ai_spec_studio_dev",
        DATABASE_SSL_MODE: "disable",
      }),
    );
    expect(connection.host).toBe("::1");
  });

  test("decodes percent-encoded user and database names", () => {
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({
        DATABASE_URL:
          "postgresql://app%2Buser:Fake-pw@db.example.com:5432/my%20db",
      }),
    );
    expect(connection.user).toBe("app+user");
    expect(connection.database).toBe("my db");
  });

  test.each([
    ["missing", "postgresql://app@127.0.0.1:5432/ai_spec_studio_dev"],
    ["empty", "postgresql://app:@127.0.0.1:5432/ai_spec_studio_dev"],
  ])("rejects a URL whose password is %s", (_, url) => {
    const errors = expectErrors(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: url,
        DATABASE_SSL_MODE: "disable",
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining("DATABASE_URL must include a password"),
    ]);
    expect(errors[0]).not.toContain("127.0.0.1");
    expect(errors[0]).not.toContain("ai_spec_studio_dev");
  });

  test("doesn't fall back to PGPASSWORD when the URL has no password", () => {
    const errors = expectErrors(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: "postgresql://app@127.0.0.1:5432/ai_spec_studio_dev",
        DATABASE_SSL_MODE: "disable",
        PGPASSWORD: "FakeFromEnvironment",
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining("DATABASE_URL must include a password"),
    ]);
    expect(errors[0]).not.toContain("FakeFromEnvironment");
  });

  test("decodes a percent-encoded password", () => {
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({
        DATABASE_URL:
          "postgresql://app:Fake%24%23%25%20%40%3A%2F%3F%21%27@127.0.0.1:5432/ai_spec_studio_dev",
        DATABASE_SSL_MODE: "disable",
      }),
    );
    expect(connection.password).toBe("Fake$#% @:/?!'");
  });

  test("keeps the password as an ordinary property that survives spreads", () => {
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({ DATABASE_URL: REMOTE_URL }),
    );
    expect(Object.keys(connection)).toContain("password");
    expect({ ...connection }.password).toBe(PASSWORD);
  });

  test("keeps the password through Drizzle Kit's credential flattening", () => {
    const { connection } = expectValue(
      parseMigrationDatabaseEnv({ DATABASE_MIGRATION_URL: REMOTE_URL }),
    );
    // drizzle-kit 0.31 flattens `dbCredentials` with an object spread before
    // validating it, then spreads the result into `new pg.Pool({ ... })`.
    const config = { dialect: "postgresql", dbCredentials: connection };
    const { dbCredentials, ...rest } = config;
    const flattened = { ...rest, ...dbCredentials };
    expect({ ...flattened, max: 1 }).toMatchObject({
      host: "db.example.com",
      port: 5432,
      user: "app_user",
      password: PASSWORD,
      database: "studio",
      ssl: { rejectUnauthorized: true },
    });
  });

  test.each([
    ["missing", {}, "DATABASE_URL is not set."],
    ["blank", { DATABASE_URL: "   " }, "DATABASE_URL is not set."],
    ["not a URL", { DATABASE_URL: "not a url" }, "not a valid URL"],
    [
      "an out-of-range port",
      { DATABASE_URL: "postgresql://app:Fake-pw@db.example.com:99999/studio" },
      "not a valid URL",
    ],
    [
      "another scheme",
      { DATABASE_URL: "mysql://app@db.example.com:3306/studio" },
      "must start with postgresql:// or postgres://",
    ],
    [
      "an http URL",
      { DATABASE_URL: "https://app@db.example.com:5432/studio" },
      "must start with postgresql:// or postgres://",
    ],
    [
      "no host (Unix socket)",
      { DATABASE_URL: "postgresql:///studio" },
      "must include a host name",
    ],
    [
      "no explicit port",
      { DATABASE_URL: "postgresql://app:Fake-pw@db.example.com/studio" },
      "must include an explicit port",
    ],
    [
      "port zero",
      { DATABASE_URL: "postgresql://app:Fake-pw@db.example.com:0/studio" },
      "port between 1 and 65535",
    ],
    [
      "no user",
      { DATABASE_URL: "postgresql://db.example.com:5432/studio" },
      "must include a user name",
    ],
    [
      "no database",
      { DATABASE_URL: "postgresql://app:Fake-pw@db.example.com:5432/" },
      "must name exactly one database",
    ],
    [
      "extra path segments",
      {
        DATABASE_URL:
          "postgresql://app:Fake-pw@db.example.com:5432/studio/extra",
      },
      "must name exactly one database",
    ],
    [
      "a fragment",
      { DATABASE_URL: "postgresql://app:Fake-pw@db.example.com:5432/studio#x" },
      "must not include a #fragment",
    ],
    [
      "bad percent-encoding in the database",
      {
        DATABASE_URL:
          "postgresql://app:Fake-pw@db.example.com:5432/studio%E0%A4%A",
      },
      "invalid percent-encoding in its database name",
    ],
    [
      "bad percent-encoding in the user",
      {
        DATABASE_URL: "postgresql://app%ZZ:Fake-pw@db.example.com:5432/studio",
      },
      "invalid percent-encoding in its user name",
    ],
    [
      "a database name over 63 bytes",
      {
        DATABASE_URL: `postgresql://app:Fake-pw@db.example.com:5432/${"d".repeat(64)}`,
      },
      "database name longer than 63 bytes",
    ],
    [
      "a user name over 63 bytes",
      {
        DATABASE_URL: `postgresql://${"u".repeat(64)}@db.example.com:5432/studio`,
      },
      "user name longer than 63 bytes",
    ],
  ])("rejects a URL with %s", (_, env, message) => {
    const errors = expectErrors(parseRuntimeDatabaseEnv(env));
    expect(errors.join("\n")).toContain(message);
  });

  test.each([
    ["sslmode", "?sslmode=require"],
    ["host", "?host=other.example.com"],
    ["options", "?options=-c%20app.environment%3Dtest"],
    ["sslrootcert", "?sslrootcert=/tmp/ca.pem"],
    ["uselibpqcompat", "?uselibpqcompat=true&sslmode=verify-full"],
  ])("rejects the %s query parameter and names it", (name, query) => {
    const errors = expectErrors(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: `${REMOTE_URL}${query}`,
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("must not include query parameters");
    expect(errors[0]).toContain(name);
    expectNoSecrets(errors[0]);
  });

  test("counts unknown query parameters instead of naming them", () => {
    const errors = expectErrors(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: `${REMOTE_URL}?sslmode=require&MyS3cretValue&other=1`,
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("(found: sslmode, 2 other parameters)");
    expect(errors[0]).not.toContain("MyS3cretValue");
    expect(errors[0]).not.toContain("other=");
  });

  test("describes a lone unknown query parameter in the singular", () => {
    const errors = expectErrors(
      parseRuntimeDatabaseEnv({ DATABASE_URL: `${REMOTE_URL}?x` }),
    );
    expect(errors[0]).toContain("(found: 1 other parameter)");
  });

  test.each([
    ["percent-encoding", "local%68ost"],
    ["an encoded space", "db%20host.example.com"],
    ["an encoded control character", "db%01.example.com"],
    ["a raw control character", "db\u0001.example.com"],
  ])("rejects a host name with %s", (_, host) => {
    const errors = expectErrors(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: `postgresql://app:Fake-pw@${host}:5432/studio`,
      }),
    );
    expect(errors.join("\n")).toContain("has a malformed host name");
  });

  test.each([
    ["user name", "postgresql://app%0Auser:Fake-pw@db.example.com:5432/studio"],
    ["user name", "postgresql://app%7F:Fake-pw@db.example.com:5432/studio"],
    ["user name", "postgresql://app%C2%85:Fake-pw@db.example.com:5432/studio"],
    [
      "database name",
      "postgresql://app:Fake-pw@db.example.com:5432/studio%0D%0Afake",
    ],
    ["database name", "postgresql://app:Fake-pw@db.example.com:5432/stu%00dio"],
  ])("rejects control characters in the %s", (part, url) => {
    const errors = expectErrors(parseRuntimeDatabaseEnv({ DATABASE_URL: url }));
    expect(errors).toEqual([
      `DATABASE_URL has control characters in its ${part}.`,
    ]);
  });

  test("still accepts non-ASCII letters in names", () => {
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({
        DATABASE_URL:
          "postgresql://jos%C3%A9:Fake-pw@db.example.com:5432/caf%C3%A9",
      }),
    );
    expect(connection.user).toBe("josé");
    expect(connection.database).toBe("café");
  });

  test.each([
    "require",
    "prefer",
    "verify-ca",
    "no-verify",
    "true",
    "VERIFY-FULL",
  ])("rejects DATABASE_SSL_MODE=%s", (mode) => {
    const errors = expectErrors(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: REMOTE_URL,
        DATABASE_SSL_MODE: mode,
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining("must be verify-full or disable"),
    ]);
  });

  test.each(["db.example.com", "10.0.0.5", "0.0.0.0", "192.168.1.20"])(
    "refuses to disable TLS for the non-loopback host %s",
    (host) => {
      const errors = expectErrors(
        parseRuntimeDatabaseEnv({
          DATABASE_URL: `postgresql://app:Fake-pw@${host}:5432/studio`,
          DATABASE_SSL_MODE: "disable",
        }),
      );
      expect(errors).toEqual([
        expect.stringContaining("only allowed for loopback hosts"),
      ]);
    },
  );

  test("passes a CA bundle with verify-full", () => {
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: REMOTE_URL,
        DATABASE_SSL_CA: PEM,
      }),
    );
    expect(connection.ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
  });

  test("turns escaped newlines in the CA bundle into real ones", () => {
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: REMOTE_URL,
        DATABASE_SSL_CA: PEM.replace(/\n/g, "\\n"),
      }),
    );
    expect(connection.ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
  });

  test("accepts a bundle of several certificates", () => {
    const bundle = `${PEM}\n${PEM}`;
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: REMOTE_URL,
        DATABASE_SSL_CA: bundle,
      }),
    );
    expect(connection.ssl).toEqual({ rejectUnauthorized: true, ca: bundle });
  });

  test.each([
    ["text that isn't PEM", "not a certificate"],
    ["an unterminated certificate", "-----BEGIN CERTIFICATE-----\nMIIB"],
    [
      "a private key",
      `${PEM}\n-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----`,
    ],
  ])("rejects a CA bundle with %s without echoing it", (_, ca) => {
    const errors = expectErrors(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: REMOTE_URL,
        DATABASE_SSL_CA: ca,
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^DATABASE_SSL_CA must/);
    expect(errors[0]).not.toContain("MIIB");
    expect(errors[0]).not.toContain("not a certificate");
  });

  test("rejects a CA bundle when TLS is disabled", () => {
    const errors = expectErrors(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: LOCAL_APP_URL,
        DATABASE_SSL_MODE: "disable",
        DATABASE_SSL_CA: PEM,
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining(
        "DATABASE_SSL_CA is set, but DATABASE_SSL_MODE is disable",
      ),
    ]);
  });

  test.each([
    ["1", 1],
    ["25", 25],
    [" 100 ", 100],
    ["", DEFAULT_POOL_MAX],
  ])("accepts DATABASE_POOL_MAX=%j", (raw, expected) => {
    const { poolMax } = expectValue(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: REMOTE_URL,
        DATABASE_POOL_MAX: raw,
      }),
    );
    expect(poolMax).toBe(expected);
  });

  test.each(["0", "101", "-1", "10.5", "1e2", "ten", "0x10"])(
    "rejects DATABASE_POOL_MAX=%j",
    (raw) => {
      const errors = expectErrors(
        parseRuntimeDatabaseEnv({
          DATABASE_URL: REMOTE_URL,
          DATABASE_POOL_MAX: raw,
        }),
      );
      expect(errors).toEqual([
        "DATABASE_POOL_MAX must be a whole number from 1 to 100.",
      ]);
    },
  );

  test("rejects PGOPTIONS, which would add session settings", () => {
    const errors = expectErrors(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: REMOTE_URL,
        PGOPTIONS: "-c app.environment=test",
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining("PGOPTIONS must not be set"),
    ]);
  });

  test("reports every problem at once", () => {
    const errors = expectErrors(
      parseRuntimeDatabaseEnv({
        DATABASE_URL: "postgresql://db.example.com/studio?sslmode=require",
        DATABASE_POOL_MAX: "0",
        PGOPTIONS: "-c x=y",
      }),
    );
    // No user, no password, no port, the query, the pool size, and PGOPTIONS.
    expect(errors).toHaveLength(6);
  });

  test("reads only DATABASE_URL", () => {
    const errors = expectErrors(
      parseRuntimeDatabaseEnv({
        DATABASE_MIGRATION_URL: LOCAL_MIGRATION_URL,
        TEST_DATABASE_URL: LOCAL_TEST_URL,
      }),
    );
    expect(errors).toEqual(["DATABASE_URL is not set."]);
  });
});

describe("parseMigrationDatabaseEnv", () => {
  test("reads DATABASE_MIGRATION_URL with the shared TLS settings", () => {
    const { connection } = expectValue(
      parseMigrationDatabaseEnv({
        DATABASE_URL: LOCAL_APP_URL,
        DATABASE_MIGRATION_URL: LOCAL_MIGRATION_URL,
        DATABASE_SSL_MODE: "disable",
      }),
    );
    expect(connection.user).toBe("ai_spec_studio_migrator");
    expect(connection.ssl).toBe(false);
    expect(connection.password).toBe(PASSWORD);
  });

  test("names DATABASE_MIGRATION_URL in its errors", () => {
    const errors = expectErrors(
      parseMigrationDatabaseEnv({ DATABASE_URL: LOCAL_APP_URL }),
    );
    expect(errors).toEqual(["DATABASE_MIGRATION_URL is not set."]);
  });

  test("applies the loopback rule to its own host", () => {
    const errors = expectErrors(
      parseMigrationDatabaseEnv({
        DATABASE_URL: LOCAL_APP_URL,
        DATABASE_MIGRATION_URL: REMOTE_URL,
        DATABASE_SSL_MODE: "disable",
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining("DATABASE_MIGRATION_URL points to a remote host"),
    ]);
  });

  test.each([
    [
      "missing",
      "postgresql://ai_spec_studio_migrator@127.0.0.1:5432/ai_spec_studio_dev",
    ],
    [
      "empty",
      "postgresql://ai_spec_studio_migrator:@127.0.0.1:5432/ai_spec_studio_dev",
    ],
  ])("rejects a migration URL whose password is %s", (_, url) => {
    const errors = expectErrors(
      parseMigrationDatabaseEnv({
        DATABASE_URL: LOCAL_APP_URL,
        DATABASE_MIGRATION_URL: url,
        DATABASE_SSL_MODE: "disable",
        PGPASSWORD: "FakeFromEnvironment",
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining("DATABASE_MIGRATION_URL must include a password"),
    ]);
    expect(errors[0]).not.toContain("FakeFromEnvironment");
    expect(errors[0]).not.toContain("ai_spec_studio_migrator");
  });
});

describe("parseTestDatabaseEnv", () => {
  const localEnv: DatabaseEnv = {
    NODE_ENV: "test",
    DATABASE_URL: LOCAL_APP_URL,
    DATABASE_MIGRATION_URL: LOCAL_MIGRATION_URL,
    TEST_DATABASE_URL: LOCAL_TEST_URL,
  };

  test("accepts a separate loopback database ending in _test", () => {
    const { connection } = expectValue(parseTestDatabaseEnv(localEnv));
    expect(connection).toEqual({
      host: "127.0.0.1",
      port: 5432,
      database: "ai_spec_studio_test",
      user: "ai_spec_studio_test",
      password: PASSWORD,
      ssl: false,
    });
  });

  test("works without the development URLs", () => {
    expectValue(parseTestDatabaseEnv({ TEST_DATABASE_URL: LOCAL_TEST_URL }));
  });

  test("never uses TLS, whatever DATABASE_SSL_MODE says", () => {
    const { connection } = expectValue(
      parseTestDatabaseEnv({ ...localEnv, DATABASE_SSL_MODE: "verify-full" }),
    );
    expect(connection.ssl).toBe(false);
  });

  test("refuses to run when NODE_ENV is production", () => {
    const errors = expectErrors(
      parseTestDatabaseEnv({ ...localEnv, NODE_ENV: "production" }),
    );
    expect(errors).toEqual([expect.stringContaining("NODE_ENV is production")]);
  });

  test.each([
    [
      "missing",
      "postgresql://ai_spec_studio_test@127.0.0.1:5432/ai_spec_studio_test",
    ],
    [
      "empty",
      "postgresql://ai_spec_studio_test:@127.0.0.1:5432/ai_spec_studio_test",
    ],
  ])("rejects a test URL whose password is %s", (_, url) => {
    const errors = expectErrors(
      parseTestDatabaseEnv({
        ...localEnv,
        TEST_DATABASE_URL: url,
        PGPASSWORD: "FakeFromEnvironment",
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining("TEST_DATABASE_URL must include a password"),
    ]);
    expect(errors[0]).not.toContain("FakeFromEnvironment");
    expect(errors[0]).not.toContain("ai_spec_studio_test@");
  });

  test("accepts a percent-encoded test password", () => {
    const { connection } = expectValue(
      parseTestDatabaseEnv({
        TEST_DATABASE_URL: `postgresql://ai_spec_studio_test:${ENCODED_PASSWORD}@127.0.0.1:5432/ai_spec_studio_test`,
      }),
    );
    expect(connection.password).toBe(PASSWORD);
  });

  test("fails closed when another database URL has no password", () => {
    const errors = expectErrors(
      parseTestDatabaseEnv({
        DATABASE_URL: "postgresql://app@127.0.0.1:5432/ai_spec_studio_dev",
        TEST_DATABASE_URL: LOCAL_TEST_URL,
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining("DATABASE_URL is set but invalid"),
    ]);
  });

  test("requires TEST_DATABASE_URL", () => {
    const errors = expectErrors(
      parseTestDatabaseEnv({ ...localEnv, TEST_DATABASE_URL: undefined }),
    );
    expect(errors).toEqual(["TEST_DATABASE_URL is not set."]);
  });

  test.each([
    "ai_spec_studio_dev",
    "ai_spec_studio_test_copy",
    "test",
    "_TEST",
  ])("rejects the database name %s", (database) => {
    const errors = expectErrors(
      parseTestDatabaseEnv({
        TEST_DATABASE_URL: `postgresql://tester:Fake-pw@127.0.0.1:5432/${database}`,
      }),
    );
    expect(errors).toEqual([
      "TEST_DATABASE_URL must name a database ending in _test.",
    ]);
  });

  test.each(["db.example.com", "10.0.0.5", "0.0.0.0", "127.0.0.1.example.com"])(
    "rejects the non-loopback host %s",
    (host) => {
      const errors = expectErrors(
        parseTestDatabaseEnv({
          TEST_DATABASE_URL: `postgresql://tester:Fake-pw@${host}:5432/studio_test`,
        }),
      );
      expect(errors).toEqual([
        expect.stringContaining("must point to a loopback host"),
      ]);
    },
  );

  test.each(["DATABASE_URL", "DATABASE_MIGRATION_URL"])(
    "rejects a test URL that reaches the same database as %s",
    (name) => {
      const errors = expectErrors(
        parseTestDatabaseEnv({
          [name]: "postgresql://someone:Fake-pw@localhost:5432/shared_test",
          TEST_DATABASE_URL:
            "postgresql://tester:Fake-pw@127.0.0.1:5432/shared_test",
        }),
      );
      expect(errors).toEqual([
        `TEST_DATABASE_URL must not point to the same database as ${name}.`,
      ]);
    },
  );

  test("allows the same database name on a different port", () => {
    expectValue(
      parseTestDatabaseEnv({
        DATABASE_URL: "postgresql://someone:Fake-pw@127.0.0.1:5433/shared_test",
        TEST_DATABASE_URL:
          "postgresql://tester:Fake-pw@127.0.0.1:5432/shared_test",
      }),
    );
  });

  test("fails closed when another database URL can't be read", () => {
    const errors = expectErrors(
      parseTestDatabaseEnv({
        DATABASE_URL: `postgresql://app:${ENCODED_PASSWORD}@127.0.0.1/no_port`,
        TEST_DATABASE_URL: LOCAL_TEST_URL,
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining(
        "DATABASE_URL is set but invalid, so TEST_DATABASE_URL can't be confirmed",
      ),
    ]);
    expectNoSecrets(errors.join("\n"));
  });

  test("rejects PGOPTIONS, which could fake the environment label", () => {
    const errors = expectErrors(
      parseTestDatabaseEnv({
        ...localEnv,
        PGOPTIONS: "-c app.environment=test",
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining("PGOPTIONS must not be set"),
    ]);
  });

  test("rejects query parameters that could redirect the connection", () => {
    const errors = expectErrors(
      parseTestDatabaseEnv({
        TEST_DATABASE_URL: `${LOCAL_TEST_URL}?host=db.example.com`,
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining(
        "must not include query parameters (found: host)",
      ),
    ]);
  });
});

describe("credential redaction", () => {
  const failingEnvs: Array<[string, DatabaseEnv]> = [
    [
      "an invalid URL",
      { DATABASE_URL: `postgresql://app:${ENCODED_PASSWORD}@` },
    ],
    [
      "a missing port",
      {
        DATABASE_URL: `postgresql://app:${ENCODED_PASSWORD}@db.example.com/studio`,
      },
    ],
    ["query parameters", { DATABASE_URL: `${REMOTE_URL}?sslmode=require` }],
    [
      "TLS disabled on a remote host",
      { DATABASE_URL: REMOTE_URL, DATABASE_SSL_MODE: "disable" },
    ],
    [
      "a bad password encoding",
      { DATABASE_URL: "postgresql://app:Fake%ZZ@db.example.com:5432/studio" },
    ],
    [
      "a password that wasn't percent-encoded",
      {
        DATABASE_URL: `postgresql://app:${PASSWORD}@db.example.com:5432/studio`,
      },
    ],
    [
      "a secret pasted as a query parameter",
      { DATABASE_URL: `${REMOTE_URL}?${ENCODED_PASSWORD}` },
    ],
    [
      "a secret pasted as a query parameter value",
      { DATABASE_URL: `${REMOTE_URL}?password=${ENCODED_PASSWORD}` },
    ],
  ];

  test.each(failingEnvs)(
    "keeps the password out of errors for %s",
    (_, env) => {
      const errors = expectErrors(parseRuntimeDatabaseEnv(env));
      expect(errors.length).toBeGreaterThan(0);
      expectNoSecrets(errors.join("\n"));
    },
  );

  test("keeps the password out of test-database errors", () => {
    const errors = expectErrors(
      parseTestDatabaseEnv({
        NODE_ENV: "production",
        TEST_DATABASE_URL: `postgresql://tester:${ENCODED_PASSWORD}@db.example.com:5432/studio`,
      }),
    );
    expect(errors).toHaveLength(3);
    expectNoSecrets(errors.join("\n"));
  });

  test("describeDatabaseTarget shows everything but the password", () => {
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({ DATABASE_URL: REMOTE_URL }),
    );
    const description = describeDatabaseTarget(connection);
    expect(description).toBe("app_user@db.example.com:5432/studio");
    expectNoSecrets(description);
  });

  test("describeDatabaseTarget is safe on a copied connection too", () => {
    const { connection } = expectValue(
      parseRuntimeDatabaseEnv({ DATABASE_URL: REMOTE_URL }),
    );
    const copy = { ...connection, max: 1 };
    expect(copy.password).toBe(PASSWORD);
    expectNoSecrets(describeDatabaseTarget(copy));
  });

  test("describeDatabaseTarget brackets IPv6 hosts", () => {
    expect(
      describeDatabaseTarget({
        host: "::1",
        port: 5432,
        database: "ai_spec_studio_test",
        user: "ai_spec_studio_test",
      }),
    ).toBe("ai_spec_studio_test@[::1]:5432/ai_spec_studio_test");
  });
});

describe("isLoopbackHost", () => {
  test.each([
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "127.1.2.3",
    "127.255.255.255",
    "::1",
    "[::1]",
  ])("treats %s as loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  test.each([
    "",
    "0.0.0.0",
    "128.0.0.1",
    "127.0.0.256",
    "127.0.0",
    "127.0.0.1.example.com",
    "localhost.example.com",
    "::2",
    "db.example.com",
  ])("doesn't treat %j as loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});
