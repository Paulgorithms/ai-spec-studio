import {
  chmodSync,
  constants,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import {
  DatabaseError,
  Pool as PgPool,
  type Pool,
  type PoolClient,
  type PoolConfig,
} from "pg";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { buildTestDatabaseUrl } from "./ci-credentials";
import {
  PROBES,
  attemptProbe,
  boundedTimeouts,
  classifyConnectionError,
  loadCiTestDatabaseConnection,
  nodeProbeFileSystem,
  runPostgresProbes,
  type Probe,
  type ProbeFileSystem,
  type ProbeOutcome,
} from "./ci-postgres-probes";
import { formatResults, type PoolFactory } from "./live-verification";
import { QUERIES } from "./migration-checks";

// Synthetic values only. SECRET appears in fake driver messages to prove
// they're never reported.
const UID = process.getuid?.() ?? 0;
const HEX_PASSWORD = "0123456789abcdef".repeat(4);
const URL = buildTestDatabaseUrl(HEX_PASSWORD);
const SECRET = "FakeSecret:p@ss/word";
const ENV_FILE = "set_env_0d6a3c51-2f7e-4b8a-9c1d-5e6f7a8b9c0d";
const SHORT = { probeMs: 50, endMs: 50 };
// For the real driver: long enough for a local round trip, still bounded.
const SHORT_REAL = { probeMs: 2_000, endMs: 1_000 };

let base: string;
let runnerTemp: string;
let credentialDir: string;
let urlFile: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ci-postgres-probes-")));
  runnerTemp = `${base}/_temp`;
  const commands = `${runnerTemp}/_runner_file_commands`;
  mkdirSync(commands, { recursive: true });
  chmodSync(runnerTemp, 0o755);
  chmodSync(commands, 0o755);
  writeFileSync(`${commands}/${ENV_FILE}`, "");
  chmodSync(`${commands}/${ENV_FILE}`, 0o644);
  credentialDir = `${runnerTemp}/ai-spec-studio-db`;
  urlFile = `${credentialDir}/test-database-url`;
  mkdirSync(credentialDir);
  chmodSync(credentialDir, 0o700);
  writeFileSync(urlFile, URL);
  chmodSync(urlFile, 0o600);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function runnerEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    GITHUB_ACTIONS: "true",
    CI: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    RUNNER_TEMP: runnerTemp,
    GITHUB_ENV: `${runnerTemp}/_runner_file_commands/${ENV_FILE}`,
    PATH: "/usr/bin:/bin",
    ...overrides,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

// ---------------------------------------------------------------------------
// A fake server and pool

// A server ErrorResponse exactly as pg-protocol builds it: pg's own
// DatabaseError class, named after the protocol message ("error"), with the
// fields copied from the response.
const dbError = (code: string) => {
  const error = new DatabaseError(
    `FATAL ${code} for ${SECRET} ${HEX_PASSWORD}`,
    0,
    "error",
  );
  error.severity = "FATAL";
  error.code = code;
  return error;
};
const sysError = (code: string) =>
  Object.assign(new Error(`connect ${code} 127.0.0.1:5432 ${SECRET}`), {
    code,
  });

type Behavior =
  { kind: "connect" } | { kind: "error"; error: unknown } | { kind: "hang" };

type Attempt = {
  user?: string;
  database?: string;
  password?: unknown;
  tls: boolean;
};

const connect = (): Behavior => ({ kind: "connect" });
const reject = (error: unknown): Behavior => ({ kind: "error", error });

// How a correctly provisioned CI server answers (Phase 3A pg_hba.conf, ssl
// off, SCRAM for the test role).
function correctServer(a: Attempt): Behavior {
  if (a.tls) {
    return reject(new Error("The server does not support SSL connections"));
  }
  if (
    a.user === "ai_spec_studio_test" &&
    a.database === "ai_spec_studio_test"
  ) {
    return a.password === HEX_PASSWORD ? connect() : reject(dbError("28P01"));
  }
  return reject(dbError("28000"));
}

const SESSION_ROW = {
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

type FakeOptions = {
  server?: (a: Attempt) => Behavior;
  // Applied to the second identity check (after the probes) only.
  serverAfter?: (a: Attempt) => Behavior;
  session?: Record<string, unknown>;
  queryError?: unknown;
  endHangs?: boolean;
  endRejects?: boolean;
};

class FakePool {
  ended = false;
  released = 0;
  connections = 0;
  late?: (client: PoolClient) => void;
  constructor(
    readonly config: PoolConfig,
    private readonly behavior: Behavior,
    private readonly options: FakeOptions,
    private readonly queries: string[],
  ) {}
  on() {
    return this;
  }
  connect(): Promise<PoolClient> {
    if (this.behavior.kind === "error")
      return Promise.reject(this.behavior.error);
    if (this.behavior.kind === "hang") {
      return new Promise((resolve) => {
        this.late = resolve;
      });
    }
    this.connections += 1;
    return Promise.resolve(this.client());
  }
  client(): PoolClient {
    const answers: Record<string, unknown[]> = {
      [QUERIES.begin]: [],
      [QUERIES.rollback]: [],
      [QUERIES.session]: [{ ...SESSION_ROW, ...this.options.session }],
      [QUERIES.role]: [
        {
          rolsuper: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          rolbypassrls: false,
        },
      ],
      [QUERIES.label]: [{ setconfig: ["app.environment=test"] }],
    };
    return {
      query: async (text: string) => {
        this.queries.push(text);
        if (this.options.queryError && text === QUERIES.session) {
          throw this.options.queryError;
        }
        if (!(text in answers)) throw new Error(`unexpected query ${text}`);
        return { rows: answers[text] };
      },
      release: () => {
        this.released += 1;
      },
    } as unknown as PoolClient;
  }
  end(): Promise<void> {
    if (this.options.endHangs) return new Promise(() => {});
    if (this.options.endRejects) return Promise.reject(new Error(SECRET));
    this.ended = true;
    return Promise.resolve();
  }
}

function fakeServer(options: FakeOptions = {}) {
  const pools: FakePool[] = [];
  const queries: string[] = [];
  let identityAttempts = 0;
  const factory: PoolFactory = (config) => {
    const attempt: Attempt = {
      user: config.user,
      database: config.database,
      password: config.password,
      tls: Boolean(config.ssl),
    };
    const isIdentity =
      attempt.user === "ai_spec_studio_test" &&
      attempt.database === "ai_spec_studio_test" &&
      attempt.password === HEX_PASSWORD &&
      !attempt.tls;
    if (isIdentity) identityAttempts += 1;
    const model =
      isIdentity && identityAttempts > 1 && options.serverAfter
        ? options.serverAfter
        : (options.server ?? correctServer);
    const pool = new FakePool(config, model(attempt), options, queries);
    pools.push(pool);
    return pool as unknown as Pool;
  };
  return { factory, pools, queries };
}

async function run(
  options: FakeOptions = {},
  extra: {
    env?: Record<string, string | undefined>;
    fs?: ProbeFileSystem;
  } = {},
) {
  const server = fakeServer(options);
  const result = await runPostgresProbes({
    env: extra.env ?? runnerEnv(),
    createPool: server.factory,
    platform: "linux",
    uid: UID,
    fs: extra.fs,
    timeouts: SHORT,
  });
  return { ...result, ...server, output: formatResults(result.results) };
}

const probeLabel = (probe: Probe) =>
  `probe ${probe.id}: ${probe.label} (${probe.expected})`;

// ---------------------------------------------------------------------------

describe("classifyConnectionError", () => {
  test.each([
    [dbError("28P01"), "sqlstate:28P01"],
    [dbError("28000"), "sqlstate:28000"],
    [dbError("3D000"), "sqlstate:3D000"],
    [dbError("57P03"), "sqlstate:57P03"],
    [
      new Error("The server does not support SSL connections"),
      "tls_unsupported",
    ],
    [
      new Error("There was an error establishing an SSL connection"),
      "tls_error",
    ],
    [sysError("ECONNREFUSED"), "connection_refused"],
    [sysError("ENOTFOUND"), "dns"],
    [sysError("EAI_AGAIN"), "dns"],
    [sysError("ETIMEDOUT"), "timeout"],
    [new Error("timeout expired"), "timeout"],
    [new Error("Connection terminated due to connection timeout"), "timeout"],
    [sysError("ECONNRESET"), "connection_lost"],
    [sysError("EPIPE"), "connection_lost"],
    [new Error("Connection terminated unexpectedly"), "connection_lost"],
    [new Error(`something else ${SECRET}`), "unknown"],
    // An SQLSTATE-shaped code is trusted only from pg's DatabaseError
    // class: an object merely named DatabaseError is not the server's answer.
    [Object.assign(new Error("x"), { code: "28P01" }), "unknown"],
    [
      Object.assign(new Error("x"), { name: "DatabaseError", code: "28P01" }),
      "unknown",
    ],
    [
      Object.assign(new Error("x"), { name: "DatabaseError", code: "28000" }),
      "unknown",
    ],
    [{ name: "DatabaseError", code: "28P01", message: "x" }, "unknown"],
    [
      Object.assign(Object.create(DatabaseError.prototype) as object, {
        code: "28P01",
      }),
      "sqlstate:28P01",
    ],
    // A real DatabaseError with a malformed code isn't trusted either, and
    // never falls through to the message-based categories.
    [Object.assign(dbError("28P01"), { code: "28p01" }), "unknown"],
    [Object.assign(dbError("28P01"), { code: "28P011" }), "unknown"],
    [Object.assign(dbError("28P01"), { code: undefined }), "unknown"],
    [
      Object.assign(new DatabaseError("timeout expired", 0, "error"), {
        code: "ETIMEDOUT",
      }),
      "unknown",
    ],
    ["28P01", "unknown"],
    [undefined, "unknown"],
    [null, "unknown"],
  ] as const)("%s -> %s", (error, expected) => {
    expect(classifyConnectionError(error)).toBe(expected);
  });

  test("never returns the message", () => {
    expect(classifyConnectionError(dbError("28P01"))).not.toContain(SECRET);
  });
});

describe("PROBES", () => {
  test("are exactly the approved negative checks, in order", () => {
    expect(
      PROBES.map((p) => [
        p.id,
        p.user,
        p.database,
        p.credential,
        p.tls,
        p.expected,
      ]),
    ).toEqual([
      [
        "WRONG_PASSWORD",
        "ai_spec_studio_test",
        "ai_spec_studio_test",
        "decoy",
        false,
        "sqlstate:28P01",
      ],
      [
        "TEST_ROLE_POSTGRES_DB",
        "ai_spec_studio_test",
        "postgres",
        "test",
        false,
        "sqlstate:28000",
      ],
      [
        "TEST_ROLE_TEMPLATE1",
        "ai_spec_studio_test",
        "template1",
        "test",
        false,
        "sqlstate:28000",
      ],
      [
        "TEST_ROLE_DEV_DB",
        "ai_spec_studio_test",
        "ai_spec_studio_dev",
        "test",
        false,
        "sqlstate:28000",
      ],
      [
        "TLS_REQUESTED",
        "ai_spec_studio_test",
        "ai_spec_studio_test",
        "test",
        true,
        "tls_unsupported",
      ],
      [
        "APP_ROLE",
        "ai_spec_studio_app",
        "ai_spec_studio_test",
        "decoy",
        false,
        "sqlstate:28000",
      ],
      [
        "MIGRATOR_ROLE",
        "ai_spec_studio_migrator",
        "ai_spec_studio_test",
        "decoy",
        false,
        "sqlstate:28000",
      ],
      ["ADMIN_TCP", "postgres", "postgres", "decoy", false, "sqlstate:28000"],
      [
        "ADMIN_TCP_TEST_DB",
        "postgres",
        "ai_spec_studio_test",
        "decoy",
        false,
        "sqlstate:28000",
      ],
    ]);
  });

  test("every probe expects a refusal, never a connection", () => {
    for (const probe of PROBES) expect(probe.expected).not.toBe("connected");
  });

  test("the real test-role password is offered only as the test role", () => {
    for (const probe of PROBES.filter((p) => p.credential === "test")) {
      expect(probe.user).toBe("ai_spec_studio_test");
    }
  });
});

describe("runPostgresProbes: a correctly provisioned server", () => {
  test("passes every check", async () => {
    const { ok, results } = await run();
    expect(results.filter((r) => !r.pass)).toEqual([]);
    expect(ok).toBe(true);
  });

  test("runs the runner, credential, and identity checks before any probe, and identity again after", async () => {
    const { results } = await run();
    const labels = results.map((r) => r.label);
    const firstProbe = labels.findIndex((l) => l.startsWith("probe "));
    const identityBefore = labels.indexOf(
      "identity (before the probes): the test role reaches the intended CI server",
    );
    const identityAfter = labels.indexOf(
      "identity (after the probes): the test role reaches the intended CI server",
    );
    expect(labels[0]).toMatch(/^runner: /);
    expect(labels[1]).toMatch(/^credentials: /);
    expect(identityBefore).toBeGreaterThan(1);
    expect(identityBefore).toBeLessThan(firstProbe);
    expect(identityAfter).toBe(labels.length - 1);
    expect(labels.filter((l) => l.startsWith("probe "))).toEqual(
      PROBES.map(probeLabel),
    );
    expect(labels).toContain(
      "identity (before): server: loopback endpoint, port 5432",
    );
    expect(labels).toContain(
      "identity (before): session: authenticated with SCRAM-SHA-256",
    );
  });

  test("makes one bounded, single-connection attempt per probe on 127.0.0.1:5432", async () => {
    const { pools } = await run();
    expect(pools).toHaveLength(PROBES.length + 2);
    for (const pool of pools) {
      expect(pool.config.host).toBe("127.0.0.1");
      expect(pool.config.port).toBe(5432);
      expect(pool.config.max).toBe(1);
      expect(pool.config.connectionTimeoutMillis).toBe(5_000);
      expect(pool.config.allowExitOnIdle).toBe(true);
    }
    const probePools = pools.slice(1, -1);
    probePools.forEach((pool, i) => {
      const probe = PROBES[i];
      expect(pool.config.user).toBe(probe?.user);
      expect(pool.config.database).toBe(probe?.database);
      expect(Boolean(pool.config.ssl)).toBe(probe?.tls);
    });
  });

  test("offers the real password only in the test-role probes, and a random decoy otherwise", async () => {
    const { pools } = await run();
    const decoys = new Set<unknown>();
    pools.slice(1, -1).forEach((pool, i) => {
      const probe = PROBES[i];
      if (probe?.credential === "test") {
        expect(pool.config.password).toBe(HEX_PASSWORD);
      } else {
        expect(pool.config.password).toMatch(/^[0-9a-f]{64}$/);
        expect(pool.config.password).not.toBe(HEX_PASSWORD);
        decoys.add(pool.config.password);
      }
    });
    expect(decoys.size).toBe(1);
  });

  test("ends every pool, releases every connection, and rolls back the identity transactions", async () => {
    const { pools, queries } = await run();
    for (const pool of pools) {
      expect(pool.ended).toBe(true);
      expect(pool.released).toBe(pool.connections);
    }
    expect(queries.filter((q) => q === QUERIES.begin)).toHaveLength(2);
    expect(queries.filter((q) => q === QUERIES.rollback)).toHaveLength(2);
  });
});

describe("runPostgresProbes: every unexpected probe outcome fails", () => {
  const wrongOutcomes: Array<[string, (p: Probe) => Behavior, ProbeOutcome]> = [
    ["the connection succeeds", () => connect(), "connected"],
    [
      "another SQLSTATE",
      (p) =>
        reject(dbError(p.expected === "sqlstate:28000" ? "28P01" : "28000")),
      "sqlstate:other",
    ],
    [
      "the database doesn't exist (3D000)",
      () => reject(dbError("3D000")),
      "sqlstate:3D000",
    ],
    [
      "the server is starting (57P03)",
      () => reject(dbError("57P03")),
      "sqlstate:57P03",
    ],
    [
      "the connection is refused",
      () => reject(sysError("ECONNREFUSED")),
      "connection_refused",
    ],
    ["the connection times out", () => ({ kind: "hang" }), "timeout"],
    [
      "the connection is lost",
      () => reject(new Error("Connection terminated unexpectedly")),
      "connection_lost",
    ],
    ["the host doesn't resolve", () => reject(sysError("ENOTFOUND")), "dns"],
    [
      "TLS fails another way",
      () =>
        reject(new Error("There was an error establishing an SSL connection")),
      "tls_error",
    ],
    ["an unknown error", () => reject(new Error(SECRET)), "unknown"],
  ];

  for (const probe of PROBES) {
    test.each(wrongOutcomes)(
      `${probe.id}: %s`,
      async (_name, behavior, outcome) => {
        const server = (a: Attempt) =>
          a.user === probe.user &&
          a.database === probe.database &&
          a.tls === probe.tls &&
          (probe.credential === "test") === (a.password === HEX_PASSWORD)
            ? behavior(probe)
            : correctServer(a);
        const { ok, results, output } = await run({ server });
        expect(ok).toBe(false);
        const failed = results.filter((r) => !r.pass);
        expect(failed.map((r) => r.label)).toEqual([probeLabel(probe)]);
        if (outcome === "sqlstate:other") {
          expect(failed[0]?.detail).toMatch(/^\(got sqlstate:[0-9A-Z]{5}\)$/);
        } else {
          expect(failed[0]?.detail).toBe(`(got ${outcome})`);
        }
        expect(output).not.toContain(SECRET);
        expect(output).not.toContain(HEX_PASSWORD);
      },
    );
  }
});

describe("runPostgresProbes: weakened servers are caught (mutation tests)", () => {
  // Each is a plausible misconfiguration of the CI server; the probes that
  // should notice it, and only those, must fail.
  const mutations: Array<[string, (a: Attempt) => Behavior, string[]]> = [
    [
      "trust authentication for the test role",
      (a) =>
        a.user === "ai_spec_studio_test" &&
        a.database === "ai_spec_studio_test" &&
        !a.tls
          ? connect()
          : correctServer(a),
      ["WRONG_PASSWORD"],
    ],
    [
      "the test role rejected by pg_hba.conf before SCRAM (wrong rule)",
      (a) =>
        a.user === "ai_spec_studio_test" &&
        a.password !== HEX_PASSWORD &&
        !a.tls
          ? reject(dbError("28000"))
          : correctServer(a),
      ["WRONG_PASSWORD"],
    ],
    [
      "the test role allowed to every database",
      (a) =>
        a.user === "ai_spec_studio_test" &&
        !a.tls &&
        a.password === HEX_PASSWORD
          ? connect()
          : correctServer(a),
      ["TEST_ROLE_POSTGRES_DB", "TEST_ROLE_TEMPLATE1", "TEST_ROLE_DEV_DB"],
    ],
    [
      "ssl = on with a hostssl rule",
      (a) =>
        a.tls && a.user === "ai_spec_studio_test" && a.password === HEX_PASSWORD
          ? connect()
          : correctServer(a),
      ["TLS_REQUESTED"],
    ],
    [
      "ssl = on, with TLS connections rejected by pg_hba.conf",
      (a) => (a.tls ? reject(dbError("28000")) : correctServer(a)),
      ["TLS_REQUESTED"],
    ],
    [
      "the app role can log in",
      (a) => (a.user === "ai_spec_studio_app" ? connect() : correctServer(a)),
      ["APP_ROLE"],
    ],
    [
      "the migrator can log in",
      (a) =>
        a.user === "ai_spec_studio_migrator" ? connect() : correctServer(a),
      ["MIGRATOR_ROLE"],
    ],
    [
      "the administrator can log in over TCP (trust)",
      (a) => (a.user === "postgres" ? connect() : correctServer(a)),
      ["ADMIN_TCP", "ADMIN_TCP_TEST_DB"],
    ],
    [
      "the administrator has a password and TCP access (SCRAM)",
      (a) =>
        a.user === "postgres" ? reject(dbError("28P01")) : correctServer(a),
      ["ADMIN_TCP", "ADMIN_TCP_TEST_DB"],
    ],
    [
      "a catch-all rule for every role and database",
      (a) =>
        a.tls
          ? correctServer(a)
          : a.password === HEX_PASSWORD || a.user !== "ai_spec_studio_test"
            ? connect()
            : reject(dbError("28P01")),
      [
        "TEST_ROLE_POSTGRES_DB",
        "TEST_ROLE_TEMPLATE1",
        "TEST_ROLE_DEV_DB",
        "APP_ROLE",
        "MIGRATOR_ROLE",
        "ADMIN_TCP",
        "ADMIN_TCP_TEST_DB",
      ],
    ],
  ];

  test.each(mutations)("%s", async (_name, server, expectedFailures) => {
    const { ok, results } = await run({ server });
    expect(ok).toBe(false);
    expect(
      results.filter((r) => !r.pass).map((r) => r.label.split(":")[0]),
    ).toEqual(expectedFailures.map((id) => `probe ${id}`));
  });

  test("every probe is caught by at least one mutation", () => {
    const caught = new Set(mutations.flatMap(([, , ids]) => ids));
    for (const probe of PROBES)
      expect(caught.has(probe.id), probe.id).toBe(true);
  });
});

describe("runPostgresProbes: the server's identity comes first", () => {
  test.each([
    [
      "the server is unreachable",
      { server: () => reject(sysError("ECONNREFUSED")) },
      "(connection_refused)",
    ],
    [
      "the server doesn't answer",
      { server: () => ({ kind: "hang" }) as Behavior },
      "(timeout)",
    ],
    [
      "the test role's password is rejected",
      { server: () => reject(dbError("28P01")) },
      "(sqlstate:28P01)",
    ],
  ] as const)("%s: no probe runs", async (_name, options, detail) => {
    const { ok, results, pools } = await run(options);
    expect(ok).toBe(false);
    expect(pools).toHaveLength(1);
    expect(
      results.find((r) => r.label.startsWith("identity (before the probes)"))
        ?.detail,
    ).toBe(detail);
    expect(results.at(-1)).toEqual({
      pass: false,
      label: "probes skipped (the server's identity was not established)",
    });
    expect(results.some((r) => r.label.startsWith("probe "))).toBe(false);
  });

  test.each([
    [
      "not PostgreSQL 18",
      { version_num: 170004 },
      "identity (before): server: PostgreSQL 18",
    ],
    [
      "a Docker bridge address",
      { server_addr: "172.17.0.2/32" },
      "identity (before): server: loopback endpoint, port 5432",
    ],
    [
      "a non-loopback client",
      { client_addr: "10.1.0.4/32" },
      "identity (before): server: loopback endpoint, port 5432",
    ],
    [
      "another port",
      { server_port: 5433 },
      "identity (before): server: loopback endpoint, port 5432",
    ],
    [
      "a TLS session",
      { ssl: true },
      "identity (before): server: session is not using TLS",
    ],
    [
      "trust authentication",
      { auth_identity: null },
      "identity (before): session: authenticated with SCRAM-SHA-256",
    ],
    [
      "another database",
      { database_name: "postgres" },
      "identity (before): session: current_database() is ai_spec_studio_test",
    ],
    [
      "another role",
      { current_role_name: "postgres", session_role_name: "postgres" },
      "identity (before): session: current_user and session_user are ai_spec_studio_test",
    ],
  ] as const)(
    "the wrong server (%s): no probe runs",
    async (_name, session, failing) => {
      const { ok, results, pools } = await run({ session });
      expect(ok).toBe(false);
      expect(pools).toHaveLength(1);
      expect(results.filter((r) => !r.pass).map((r) => r.label)).toEqual([
        failing,
        "identity (before the probes): the test role reaches the intended CI server",
        "probes skipped (the server's identity was not established)",
      ]);
    },
  );

  test("a failing identity query fails closed and still releases and ends", async () => {
    const { ok, results, pools } = await run({ queryError: dbError("42501") });
    expect(ok).toBe(false);
    expect(
      results.find((r) => r.label.startsWith("identity (before the probes)"))
        ?.detail,
    ).toBe("(sqlstate:42501)");
    expect(pools[0]?.released).toBe(1);
    expect(pools[0]?.ended).toBe(true);
  });

  test("a server that goes away during the probes fails the final identity check", async () => {
    const { ok, results } = await run({
      serverAfter: () => reject(sysError("ECONNREFUSED")),
    });
    expect(ok).toBe(false);
    expect(results.filter((r) => !r.pass)).toEqual([
      {
        pass: false,
        label:
          "identity (after the probes): the test role reaches the intended CI server",
        detail: "(connection_refused)",
      },
    ]);
  });
});

describe("runPostgresProbes: timeouts and cleanup", () => {
  test("a probe that hangs times out within the bound and its pool is still ended", async () => {
    const hanging = PROBES[1];
    const started = Date.now();
    const { results, pools } = await run({
      server: (a) =>
        a.user === hanging?.user && a.database === hanging?.database
          ? { kind: "hang" }
          : correctServer(a),
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(
      results.find((r) => r.label === probeLabel(hanging as Probe))?.detail,
    ).toBe("(got timeout)");
    expect(pools.every((p) => p.ended)).toBe(true);
  });

  test("a connection that arrives after the timeout is released", async () => {
    const { pools } = await run({
      server: (a) =>
        a.database === "template1" ? { kind: "hang" } : correctServer(a),
    });
    const late = pools.find((p) => p.config.database === "template1");
    late?.late?.(late.client());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(late?.released).toBe(1);
  });

  test("a pool that won't end is reported, without hanging the run", async () => {
    const { ok, results } = await run({ endHangs: true });
    expect(ok).toBe(false);
    expect(
      results.some(
        (r) => r.label === "identity (before): its connection pool was closed",
      ),
    ).toBe(true);
  });

  test("a pool whose end fails is reported", async () => {
    const { ok, output } = await run({ endRejects: true });
    expect(ok).toBe(false);
    expect(output).not.toContain(SECRET);
  });

  test("timeouts can only be shortened, never lengthened or disabled", () => {
    expect(boundedTimeouts({})).toEqual({ probeMs: 10_000, endMs: 5_000 });
    expect(boundedTimeouts({ probeMs: 60_000, endMs: 60_000 })).toEqual({
      probeMs: 10_000,
      endMs: 5_000,
    });
    expect(boundedTimeouts({ probeMs: 0, endMs: -1 })).toEqual({
      probeMs: 10_000,
      endMs: 5_000,
    });
    expect(boundedTimeouts({ probeMs: 1.5, endMs: Number.NaN })).toEqual({
      probeMs: 10_000,
      endMs: 5_000,
    });
    expect(boundedTimeouts({ probeMs: 50, endMs: 25 })).toEqual({
      probeMs: 50,
      endMs: 25,
    });
  });
});

describe("runPostgresProbes: the runner and the credential file", () => {
  test.each([
    ["not GitHub Actions", { GITHUB_ACTIONS: undefined }, "NOT_GITHUB_ACTIONS"],
    [
      "a self-hosted runner",
      { RUNNER_ENVIRONMENT: "self-hosted" },
      "NOT_GITHUB_HOSTED",
    ],
    [
      "TEST_DATABASE_URL in the environment",
      { TEST_DATABASE_URL: URL },
      "DATABASE_VARIABLE_SET",
    ],
    ["a PG* variable", { PGPASSWORD: SECRET }, "UNEXPECTED_VARIABLE_SET"],
  ])("refuses %s before connecting", async (_name, overrides, code) => {
    const { ok, results, pools, output } = await run(
      {},
      { env: runnerEnv(overrides) },
    );
    expect(ok).toBe(false);
    expect(pools).toHaveLength(0);
    expect(results[0]?.detail).toContain(code);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(HEX_PASSWORD);
  });

  const setups: Array<[string, () => void, string]> = [
    [
      "no credential directory",
      () => rmSync(credentialDir, { recursive: true }),
      "CREDENTIAL_DIRECTORY",
    ],
    [
      "a group-readable directory",
      () => chmodSync(credentialDir, 0o750),
      "CREDENTIAL_DIRECTORY",
    ],
    [
      "a directory that is a symbolic link",
      () => {
        rmSync(credentialDir, { recursive: true });
        mkdirSync(`${base}/real`, { mode: 0o700 });
        writeFileSync(`${base}/real/test-database-url`, URL, { mode: 0o600 });
        symlinkSync(`${base}/real`, credentialDir);
      },
      "CREDENTIAL_DIRECTORY",
    ],
    [
      "the verifier still present",
      () =>
        writeFileSync(`${credentialDir}/test-role-verifier`, "x", {
          mode: 0o600,
        }),
      "VERIFIER_STILL_PRESENT",
    ],
    [
      "an extra file",
      () => writeFileSync(`${credentialDir}/extra`, "x"),
      "CREDENTIAL_CONTENTS",
    ],
    ["no URL file", () => rmSync(urlFile), "CREDENTIAL_CONTENTS"],
    [
      "a world-readable URL file",
      () => chmodSync(urlFile, 0o644),
      "URL_FILE_UNSAFE",
    ],
    [
      "a URL file that is a symbolic link",
      () => {
        writeFileSync(`${base}/elsewhere`, URL, { mode: 0o600 });
        rmSync(urlFile);
        symlinkSync(`${base}/elsewhere`, urlFile);
      },
      "URL_FILE_UNSAFE",
    ],
    [
      "a hard-linked URL file",
      () => linkSync(urlFile, `${base}/copy`),
      "URL_FILE_UNSAFE",
    ],
    ["an empty URL file", () => writeFileSync(urlFile, ""), "URL_FILE_UNSAFE"],
    [
      "an oversized URL file",
      () => writeFileSync(urlFile, "x".repeat(2048)),
      "URL_FILE_UNSAFE",
    ],
    [
      "a URL file that is a directory",
      () => {
        rmSync(urlFile);
        mkdirSync(urlFile, { mode: 0o700 });
      },
      "URL_FILE_UNSAFE",
    ],
    [
      "a trailing newline",
      () => writeFileSync(urlFile, `${URL}\n`),
      "URL_INVALID",
    ],
    ["not a URL", () => writeFileSync(urlFile, SECRET), "URL_INVALID"],
  ];

  test.each(setups)(
    "refuses %s before connecting",
    async (_name, setup, code) => {
      setup();
      const { ok, results, pools, output } = await run();
      expect(ok).toBe(false);
      expect(pools).toHaveLength(0);
      expect(results[1]).toEqual({
        pass: false,
        label:
          "credentials: only test-database-url remains, and it is the approved CI URL",
        detail: `(${code})`,
      });
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain(HEX_PASSWORD);
      expect(output).not.toContain(base);
    },
  );

  const base0 = `postgresql://ai_spec_studio_test:${HEX_PASSWORD}@127.0.0.1:5432/ai_spec_studio_test`;
  test.each([
    ["another database", base0.replace(/test$/, "dev")],
    [
      "the postgres database",
      base0.replace(/ai_spec_studio_test$/, "postgres"),
    ],
    [
      "another role",
      base0.replace("ai_spec_studio_test:", "ai_spec_studio_app:"),
    ],
    ["localhost instead of 127.0.0.1", base0.replace("127.0.0.1", "localhost")],
    ["::1", base0.replace("127.0.0.1", "[::1]")],
    ["another host", base0.replace("127.0.0.1", "db.example.com")],
    ["another port", base0.replace(":5432/", ":5433/")],
    ["query parameters", `${base0}?sslmode=require`],
    ["a non-hex password", base0.replace(HEX_PASSWORD, "FakePassword1")],
  ])("refuses a URL file naming %s", async (_name, url) => {
    writeFileSync(urlFile, url);
    const { ok, results, pools } = await run();
    expect(ok).toBe(false);
    expect(pools).toHaveLength(0);
    expect(results[1]?.detail).toBe("(URL_INVALID)");
  });

  test("an unreadable URL file fails closed with a code only", async () => {
    const fs: ProbeFileSystem = {
      ...nodeProbeFileSystem,
      open: () => {
        throw Object.assign(new Error(`EACCES ${SECRET}`), { code: "EACCES" });
      },
    };
    const { ok, results, output } = await run({}, { fs });
    expect(ok).toBe(false);
    expect(results[1]?.detail).toBe("(URL_FILE_UNREADABLE)");
    expect(output).not.toContain(SECRET);
  });

  test("a URL file replaced between the check and the open is refused", async () => {
    const fs: ProbeFileSystem = {
      ...nodeProbeFileSystem,
      fstat: (fd) => {
        const stats = nodeProbeFileSystem.fstat(fd);
        return {
          isFile: () => stats.isFile(),
          uid: stats.uid,
          mode: stats.mode,
          nlink: stats.nlink,
          size: stats.size,
          dev: stats.dev,
          ino: -1,
        };
      },
    };
    const { results } = await run({}, { fs });
    expect(results[1]?.detail).toBe("(URL_FILE_UNSAFE)");
  });

  test("reads the URL file without following links (O_NOFOLLOW)", () => {
    const flags: number[] = [];
    const fs: ProbeFileSystem = {
      ...nodeProbeFileSystem,
      open: (path, f) => {
        flags.push(f);
        return nodeProbeFileSystem.open(path, f);
      },
    };
    const result = loadCiTestDatabaseConnection(runnerTemp, UID, fs);
    expect(result.ok).toBe(true);
    expect(flags).toEqual([constants.O_RDONLY | constants.O_NOFOLLOW]);
  });
});

describe("runPostgresProbes: output", () => {
  test("never contains the URL, password, decoy, or a driver message, whatever fails", async () => {
    const scenarios: FakeOptions[] = [
      {},
      { server: () => reject(dbError("28P01")) },
      { server: (a) => (a.user === "postgres" ? connect() : correctServer(a)) },
      {
        server: (a) =>
          a.database === "postgres"
            ? reject(new Error(`${SECRET} ${URL}`))
            : correctServer(a),
      },
      { session: { server_addr: "172.17.0.2/32" } },
      { endRejects: true },
    ];
    for (const options of scenarios) {
      const { output, pools } = await run(options);
      const decoys = pools
        .map((p) => p.config.password)
        .filter((p) => p !== HEX_PASSWORD);
      expect(output).not.toContain(HEX_PASSWORD);
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain("postgresql://");
      for (const decoy of decoys) expect(output).not.toContain(String(decoy));
      for (const line of output
        .split("\n")
        .filter((l) => /^(PASS|FAIL) /.test(l))) {
        expect(line).toMatch(/^(PASS|FAIL) {2}[A-Za-z(]/);
      }
      for (const detail of output
        .split("\n")
        .filter((l) => /^ {6}\(/.test(l))) {
        expect(detail).toMatch(
          /^ {6}\((got )?[a-z_]+(:[0-9A-Z]{5})?\)$|^ {6}\([A-Z_, ]+\)$/,
        );
      }
    }
  });
});

describe("the entry script", () => {
  test("uses the project's pg Pool and prints only formatted results", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("scripts/db/ci-verify-postgres.ts", "utf8");
    const imports = [...source.matchAll(/^import[^;]*from "([^"]+)";/gm)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual([
      "./lib/ci-postgres-probes",
      "./lib/live-verification",
      "pg",
    ]);
    expect(source).not.toMatch(
      /loadLocalEnv|\.env\.local"|child_process|process\.env\.[A-Z_]+/,
    );
    expect(source.match(/console\.log\(/g)).toHaveLength(3);
    expect(source).toContain("console.log(formatResults(results));");
  });
});

// ---------------------------------------------------------------------------
// The real driver against a minimal PostgreSQL wire-protocol server
//
// A fake server on 127.0.0.1 with an OS-assigned port (never 5432) answers
// with protocol-correct messages, so the installed pg driver parses real
// ErrorResponses and attemptProbe classifies them exactly as it will on the
// CI runner. It speaks only what these tests need: the SSLRequest, the
// StartupMessage, SCRAM-SHA-256 up to the client's proof, and a successful
// login. No real database is involved.

const SSL_REQUEST_CODE = 80877103;
const PROTOCOL_3 = 196608;

type FakeMode =
  | { kind: "reject"; code: string }
  | { kind: "scram-reject"; code: string }
  | { kind: "accept" }
  | { kind: "close" }
  | { kind: "silent" }
  | { kind: "ssl-error-byte" };

type FakeLog = {
  sslRequests: number;
  startups: Array<Record<string, string>>;
  saslInitial: number;
  saslResponses: number;
};

function message(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

const int32 = (value: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value, 0);
  return b;
};
const cstring = (value: string) =>
  Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);

// ErrorResponse: field type, value, NUL; then a final NUL.
function errorResponse(code: string, text: string): Buffer {
  const fields = [
    ["S", "FATAL"],
    ["V", "FATAL"],
    ["C", code],
    ["M", text],
  ].map(([type, value]) =>
    Buffer.concat([Buffer.from(type ?? ""), cstring(value ?? "")]),
  );
  return message("E", Buffer.concat([...fields, Buffer.from([0])]));
}

class FakePostgres {
  readonly log: FakeLog = {
    sslRequests: 0,
    startups: [],
    saslInitial: 0,
    saslResponses: 0,
  };
  private readonly sockets = new Set<Socket>();
  private constructor(
    private readonly server: Server,
    readonly port: number,
    private readonly mode: () => FakeMode,
    private readonly sslReply: "N" | "E",
  ) {
    server.on("connection", (socket) => this.serve(socket));
  }

  static async start(
    mode: FakeMode,
    sslReply: "N" | "E" = "N",
  ): Promise<FakePostgres> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () =>
        resolve(),
      );
    });
    const address = server.address();
    if (
      !address ||
      typeof address === "string" ||
      address.address !== "127.0.0.1"
    ) {
      server.close();
      throw new Error("the fake server must listen on 127.0.0.1");
    }
    if (address.port === 5432 || address.port === 0) {
      server.close();
      throw new Error("the fake server must not use port 5432");
    }
    return new FakePostgres(server, address.port, () => mode, sslReply);
  }

  private serve(socket: Socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 8) return;
          const length = buffer.readInt32BE(0);
          if (buffer.length < length) return;
          const code = buffer.readInt32BE(4);
          const body = buffer.subarray(8, length);
          buffer = buffer.subarray(length);
          if (code === SSL_REQUEST_CODE) {
            this.log.sslRequests += 1;
            if (this.sslReply === "E") {
              socket.write(Buffer.from("E", "latin1"));
              socket.end();
              return;
            }
            socket.write(Buffer.from("N", "latin1"));
            continue;
          }
          if (code !== PROTOCOL_3) {
            socket.destroy();
            return;
          }
          started = true;
          const parts = body.toString("utf8").split("\0");
          const params: Record<string, string> = {};
          for (let i = 0; i + 1 < parts.length; i += 2) {
            if (parts[i]) params[parts[i] ?? ""] = parts[i + 1] ?? "";
          }
          this.log.startups.push(params);
          this.afterStartup(socket);
          continue;
        }
        if (buffer.length < 5) return;
        const type = String.fromCharCode(buffer[0] ?? 0);
        const length = buffer.readInt32BE(1);
        if (buffer.length < length + 1) return;
        const body = buffer.subarray(5, length + 1);
        buffer = buffer.subarray(length + 1);
        this.onMessage(socket, type, body);
      }
    });
  }

  private afterStartup(socket: Socket) {
    const mode = this.mode();
    switch (mode.kind) {
      case "reject":
        socket.end(
          errorResponse(mode.code, `pg_hba.conf rejects connection ${SECRET}`),
        );
        return;
      case "scram-reject":
        // AuthenticationSASL with SCRAM-SHA-256 only.
        socket.write(
          message(
            "R",
            Buffer.concat([
              int32(10),
              cstring("SCRAM-SHA-256"),
              Buffer.from([0]),
            ]),
          ),
        );
        return;
      case "accept":
        socket.write(
          Buffer.concat([
            message("R", int32(0)),
            message("K", Buffer.concat([int32(4242), int32(1234)])),
            message("Z", Buffer.from("I", "latin1")),
          ]),
        );
        return;
      case "close":
        socket.destroy();
        return;
      case "silent":
      case "ssl-error-byte":
        return;
    }
  }

  private onMessage(socket: Socket, type: string, body: Buffer) {
    if (type === "X") {
      socket.end();
      return;
    }
    if (type !== "p") return;
    const mode = this.mode();
    if (mode.kind !== "scram-reject") return;
    if (this.log.saslInitial === this.log.saslResponses) {
      // SASLInitialResponse: mechanism, int32 length, "n,,n=*,r=<nonce>".
      this.log.saslInitial += 1;
      const mechanismEnd = body.indexOf(0);
      const data = body.subarray(mechanismEnd + 5).toString("utf8");
      const clientNonce = /r=([^,]+)/.exec(data)?.[1] ?? "";
      const serverFirst = `r=${clientNonce}${randomBytes(12).toString("base64")},s=${randomBytes(16).toString("base64")},i=4096`;
      socket.write(
        message(
          "R",
          Buffer.concat([int32(11), Buffer.from(serverFirst, "utf8")]),
        ),
      );
      return;
    }
    // SASLResponse with the client's proof: refuse it, as PostgreSQL does
    // for a wrong password.
    this.log.saslResponses += 1;
    socket.end(
      errorResponse(
        mode.code,
        `password authentication failed for user ${SECRET}`,
      ),
    );
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const fakeServers: FakePostgres[] = [];
afterAll(async () => {
  await Promise.all(fakeServers.map((server) => server.close()));
});

async function fake(mode: FakeMode, sslReply: "N" | "E" = "N") {
  const server = await FakePostgres.start(mode, sslReply);
  fakeServers.push(server);
  return server;
}

// The probe configuration, pointed at the fake server: never port 5432, so
// no test here can reach a real database.
function fakeConfig(
  port: number,
  overrides: Partial<PoolConfig> = {},
): PoolConfig {
  if (port === 5432) throw new Error("refusing port 5432");
  return {
    host: "127.0.0.1",
    port,
    user: "ai_spec_studio_test",
    database: "ai_spec_studio_test",
    password: HEX_PASSWORD,
    ssl: false,
    connectionTimeoutMillis: 1_000,
    ...overrides,
  };
}

const realPool: PoolFactory = (config) => new PgPool(config);

describe("the installed pg driver against a fake PostgreSQL server", () => {
  test("a genuine 28000 ErrorResponse classifies as sqlstate:28000", async () => {
    const server = await fake({ kind: "reject", code: "28000" });
    const result = await attemptProbe(
      realPool,
      fakeConfig(server.port, { database: "postgres" }),
      SHORT_REAL,
    );
    expect(result).toEqual({ outcome: "sqlstate:28000", ended: true });
    expect(server.log.startups).toEqual([
      expect.objectContaining({
        user: "ai_spec_studio_test",
        database: "postgres",
      }),
    ]);
  });

  test("a genuine 28P01 after a SCRAM-SHA-256 exchange classifies as sqlstate:28P01", async () => {
    const server = await fake({ kind: "scram-reject", code: "28P01" });
    const result = await attemptProbe(
      realPool,
      fakeConfig(server.port, { password: "f".repeat(64) }),
      SHORT_REAL,
    );
    expect(result).toEqual({ outcome: "sqlstate:28P01", ended: true });
    // The driver went through SCRAM: initial response, then its proof.
    expect(server.log.saslInitial).toBe(1);
    expect(server.log.saslResponses).toBe(1);
  });

  test("the server's error really is pg's DatabaseError, named after the protocol message", async () => {
    const server = await fake({ kind: "reject", code: "28000" });
    const pool = new PgPool({ ...fakeConfig(server.port), max: 1 });
    pool.on("error", () => {});
    let caught: unknown;
    try {
      const client = await pool.connect();
      client.release();
    } catch (error) {
      caught = error;
    } finally {
      await pool.end();
    }
    expect(caught).toBeInstanceOf(DatabaseError);
    expect((caught as DatabaseError).name).toBe("error");
    expect((caught as DatabaseError).code).toBe("28000");
    expect(classifyConnectionError(caught)).toBe("sqlstate:28000");
  });

  test.each(["3D000", "57P03", "53300", "42501"])(
    "another genuine SQLSTATE (%s) is reported as itself, not as a probe's expected value",
    async (code) => {
      const server = await fake({ kind: "reject", code });
      const result = await attemptProbe(
        realPool,
        fakeConfig(server.port),
        SHORT_REAL,
      );
      expect(result.outcome).toBe(`sqlstate:${code}`);
      for (const probe of PROBES)
        expect(result.outcome === probe.expected).toBe(false);
    },
  );

  test("a malformed SQLSTATE from the server is unknown", async () => {
    const server = await fake({ kind: "reject", code: "28p01" });
    const result = await attemptProbe(
      realPool,
      fakeConfig(server.port),
      SHORT_REAL,
    );
    expect(result.outcome).toBe("unknown");
  });

  test("an SSLRequest answered N classifies as tls_unsupported", async () => {
    const server = await fake({ kind: "reject", code: "28000" });
    const result = await attemptProbe(
      realPool,
      fakeConfig(server.port, { ssl: { rejectUnauthorized: true } }),
      SHORT_REAL,
    );
    expect(result).toEqual({ outcome: "tls_unsupported", ended: true });
    expect(server.log.sslRequests).toBe(1);
    expect(server.log.startups).toEqual([]);
  });

  test("an SSLRequest answered E classifies as tls_error", async () => {
    const server = await fake({ kind: "reject", code: "28000" }, "E");
    const result = await attemptProbe(
      realPool,
      fakeConfig(server.port, { ssl: { rejectUnauthorized: true } }),
      SHORT_REAL,
    );
    expect(result.outcome).toBe("tls_error");
  });

  test("an accepted login is reported as connected, and the connection is closed", async () => {
    const server = await fake({ kind: "accept" });
    const result = await attemptProbe(
      realPool,
      fakeConfig(server.port),
      SHORT_REAL,
    );
    expect(result).toEqual({ outcome: "connected", ended: true });
    for (const probe of PROBES)
      expect(result.outcome === probe.expected).toBe(false);
  });

  test("a server that drops the connection is connection_lost", async () => {
    const server = await fake({ kind: "close" });
    const result = await attemptProbe(
      realPool,
      fakeConfig(server.port),
      SHORT_REAL,
    );
    expect(result.outcome).toBe("connection_lost");
  });

  test("a server that never answers times out within the bound", async () => {
    const server = await fake({ kind: "silent" });
    const started = Date.now();
    const result = await attemptProbe(
      realPool,
      fakeConfig(server.port, { connectionTimeoutMillis: 200 }),
      SHORT_REAL,
    );
    expect(result.outcome).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("a closed port is connection_refused", async () => {
    const server = await FakePostgres.start({ kind: "silent" });
    const port = server.port;
    await server.close();
    const result = await attemptProbe(realPool, fakeConfig(port), SHORT_REAL);
    expect(result.outcome).toBe("connection_refused");
  });

  test("no outcome carries the server's message", async () => {
    const server = await fake({ kind: "reject", code: "28000" });
    const result = await attemptProbe(
      realPool,
      fakeConfig(server.port),
      SHORT_REAL,
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("pg_hba");
  });

  test("every probe's expected outcome is produced by the real driver for the matching server answer", async () => {
    const answers: Record<string, FakeMode> = {
      "sqlstate:28P01": { kind: "scram-reject", code: "28P01" },
      "sqlstate:28000": { kind: "reject", code: "28000" },
      tls_unsupported: { kind: "reject", code: "28000" },
    };
    for (const probe of PROBES) {
      const mode = answers[probe.expected];
      expect(mode, probe.id).toBeDefined();
      const server = await fake(mode as FakeMode);
      const result = await attemptProbe(
        realPool,
        fakeConfig(server.port, {
          user: probe.user,
          database: probe.database,
          password: probe.credential === "test" ? HEX_PASSWORD : "f".repeat(64),
          ssl: probe.tls ? { rejectUnauthorized: true } : false,
        }),
        SHORT_REAL,
      );
      expect(result, probe.id).toEqual({
        outcome: probe.expected,
        ended: true,
      });
    }
  });

  test("the fake server listens only on 127.0.0.1 and never on 5432", async () => {
    const server = await fake({ kind: "silent" });
    expect(server.port).not.toBe(5432);
    expect(server.port).toBeGreaterThan(0);
    expect(() => fakeConfig(5432)).toThrow("refusing port 5432");
  });
});
