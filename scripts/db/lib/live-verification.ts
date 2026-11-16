// Read-only verification of the three local database connections (Step 3C).
//
// For each role it validates the environment with the project's validators,
// builds the pool with the app's own pool settings, opens ONE connection, and
// runs catalog queries inside a READ ONLY transaction that is always rolled
// back. It never creates, alters, or drops anything, never connects to a
// database other than the role's own, and needs no superuser.
//
// Output is fixed PASS/FAIL labels plus SQLSTATE or error codes. It never
// prints a URL, password, configuration object, or driver error message.
// Imports stay relative and free of `server-only`, so tsx can run it.
import type { Pool, PoolClient, PoolConfig } from "pg";
import {
  isLoopbackHost,
  parseMigrationDatabaseEnv,
  parseRuntimeDatabaseEnv,
  parseTestDatabaseEnv,
  type DatabaseConnection,
  type DatabaseEnv,
  type EnvParseResult,
} from "../../../src/lib/db/env";
import {
  APPLICATION_NAME,
  buildPoolConfig,
  checkPgEnvironment,
} from "../../../src/lib/db/pool-config";

export type CheckResult = { pass: boolean; label: string; detail?: string };
export type PoolFactory = (config: PoolConfig) => Pool;

type Target = {
  key: "app" | "migrator" | "test";
  variable: string;
  role: string;
  database: string;
  environmentLabel: string;
  // The other project database, which this role must not be able to reach.
  forbiddenDatabase: string;
  // Whether the role may create schemas in its database.
  mayCreateInDatabase: boolean;
  parse: (
    env: DatabaseEnv,
  ) => EnvParseResult<{ connection: DatabaseConnection }>;
};

// The local Postgres.app server (scripts/db/README.md).
const LOCAL_PORT = 5432;
const DEV_DB = "ai_spec_studio_dev";
const TEST_DB = "ai_spec_studio_test";

export const TARGETS: readonly Target[] = [
  {
    key: "app",
    variable: "DATABASE_URL",
    role: "ai_spec_studio_app",
    database: DEV_DB,
    environmentLabel: "development",
    forbiddenDatabase: TEST_DB,
    mayCreateInDatabase: false,
    parse: parseRuntimeDatabaseEnv,
  },
  {
    key: "migrator",
    variable: "DATABASE_MIGRATION_URL",
    role: "ai_spec_studio_migrator",
    database: DEV_DB,
    environmentLabel: "development",
    forbiddenDatabase: TEST_DB,
    mayCreateInDatabase: true,
    parse: parseMigrationDatabaseEnv,
  },
  {
    key: "test",
    variable: "TEST_DATABASE_URL",
    role: "ai_spec_studio_test",
    database: TEST_DB,
    environmentLabel: "test",
    forbiddenDatabase: DEV_DB,
    mayCreateInDatabase: true,
    parse: parseTestDatabaseEnv,
  },
];

// Environment variables that could change how a connection is made. pool-
// config pins most PG* settings, but any of these being set is unexpected
// for this check, so it fails closed. Only names are reported.
const UNEXPECTED_VARIABLES =
  /^(PG[A-Z_]*|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS)$/;

// Every query is a SELECT on catalogs or built-in functions, with values
// passed as parameters. The leading comment names the query (used by tests).
export const QUERIES = {
  begin: "BEGIN TRANSACTION READ ONLY",
  rollback: "ROLLBACK",
  identity: `/* identity */
SELECT current_user::text AS current_role_name,
       session_user::text AS session_role_name,
       current_database()::text AS database_name,
       system_user::text AS auth_identity,
       inet_server_addr()::text AS server_addr,
       inet_client_addr()::text AS client_addr,
       current_setting('transaction_read_only') AS read_only,
       current_setting('application_name') AS application_name,
       current_setting('client_encoding') AS client_encoding,
       current_setting('statement_timeout') AS statement_timeout,
       current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_timeout,
       (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl`,
  role: `/* role */
SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
FROM pg_roles WHERE rolname = current_user`,
  label: `/* label */
SELECT s.setconfig
FROM pg_db_role_setting AS s
JOIN pg_database AS d ON d.oid = s.setdatabase
WHERE d.datname = current_database() AND s.setrole = 0`,
  privileges: `/* privileges */
SELECT has_database_privilege(current_user, $1, 'CONNECT') AS connect_own,
       has_database_privilege(current_user, $2, 'CONNECT') AS connect_other,
       has_database_privilege(current_user, $1, 'CREATE') AS create_own`,
  state: `/* state */
SELECT (SELECT count(*)::int
        FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg\\_%') AS app_relations,
       EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') AS drizzle_schema,
       to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS migrations_table`,
} as const;

export async function runLiveVerification(
  env: DatabaseEnv,
  createPool: PoolFactory,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (pass: boolean, label: string, detail?: string) =>
    results.push(
      detail === undefined ? { pass, label } : { pass, label, detail },
    );

  const unexpected = Object.keys(env).filter(
    (name) => UNEXPECTED_VARIABLES.test(name) && env[name] !== undefined,
  );
  check(
    unexpected.length === 0,
    "environment: no PG*, NODE_TLS_REJECT_UNAUTHORIZED, or NODE_EXTRA_CA_CERTS variables",
    unexpected.length > 0 ? `set: ${unexpected.sort().join(", ")}` : undefined,
  );
  const pgErrors = checkPgEnvironment(env);
  check(pgErrors.length === 0, "environment: no PGBINARY or PGREPLICATION");

  if (unexpected.length > 0 || pgErrors.length > 0) {
    // Fail closed: with an unexpected environment, create no pool and open
    // no connection at all.
    check(
      false,
      "all targets: connections skipped (unexpected environment variables)",
    );
    return results;
  }

  for (const target of TARGETS) {
    await verifyTarget(target, env, createPool, check);
  }
  return results;
}

async function verifyTarget(
  target: Target,
  env: DatabaseEnv,
  createPool: PoolFactory,
  check: (pass: boolean, label: string, detail?: string) => void,
): Promise<void> {
  const name = target.key;
  const parsed = target.parse(env);
  if (!parsed.ok) {
    check(
      false,
      `${name}: ${target.variable} passes the project validator`,
      `(${configurationCodes(parsed.errors)})`,
    );
    return;
  }
  const { connection } = parsed.value;
  const expectedTarget =
    connection.user === target.role &&
    connection.database === target.database &&
    connection.port === LOCAL_PORT &&
    isLoopbackHost(connection.host);
  check(
    expectedTarget,
    `${name}: ${target.variable} is ${target.role} on loopback port ${LOCAL_PORT}, database ${target.database}`,
  );
  check(connection.ssl === false, `${name}: TLS disabled (loopback)`);
  check(
    connection.password.length > 0,
    `${name}: password supplied in the URL`,
  );
  if (!expectedTarget || connection.ssl !== false) {
    // Fail closed: never connect to anything unexpected.
    check(false, `${name}: connection skipped (unexpected target)`);
    return;
  }

  const config = buildPoolConfig(connection, 1);
  if (!config.ok) {
    check(
      false,
      `${name}: pool configuration`,
      `(${configurationCodes(config.errors)})`,
    );
    return;
  }

  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  try {
    pool = createPool({ ...config.value, max: 1, allowExitOnIdle: true });
    pool.on("error", () => {
      // Reported through the failing query; never log the driver message.
    });
    client = await pool.connect();
    check(true, `${name}: authenticated and connected`);
    await client.query(QUERIES.begin);
    try {
      await checkSession(client, target, check);
    } finally {
      await client.query(QUERIES.rollback);
    }
  } catch (error) {
    check(
      false,
      `${name}: verification could not finish`,
      `(${errorKind(error)})`,
    );
  } finally {
    try {
      client?.release();
    } catch {
      // Already released or broken; the pool end below cleans up.
    }
    if (pool) {
      try {
        await pool.end();
        check(pool.totalCount === 0, `${name}: pool closed`);
      } catch (error) {
        check(false, `${name}: pool closed`, `(${errorKind(error)})`);
      }
    }
  }
}

async function checkSession(
  client: PoolClient,
  target: Target,
  check: (pass: boolean, label: string, detail?: string) => void,
): Promise<void> {
  const name = target.key;

  const id = (await client.query(QUERIES.identity)).rows[0] ?? {};
  check(
    id.current_role_name === target.role,
    `${name}: current_user is ${target.role}`,
  );
  check(
    id.session_role_name === target.role,
    `${name}: session_user is ${target.role}`,
  );
  check(
    id.database_name === target.database,
    `${name}: current_database() is ${target.database}`,
  );
  check(
    id.auth_identity === `scram-sha-256:${target.role}`,
    `${name}: authenticated with SCRAM-SHA-256 (system_user)`,
  );
  check(
    typeof id.server_addr === "string" &&
      isLoopbackHost(id.server_addr.replace(/\/\d+$/, "")) &&
      typeof id.client_addr === "string" &&
      isLoopbackHost(id.client_addr.replace(/\/\d+$/, "")),
    `${name}: server and client addresses are loopback`,
  );
  check(id.ssl === false, `${name}: session is not using TLS (pg_stat_ssl)`);
  check(id.read_only === "on", `${name}: session is read-only`);
  check(
    id.application_name === APPLICATION_NAME &&
      id.client_encoding === "UTF8" &&
      id.statement_timeout === "30s" &&
      id.idle_in_transaction_timeout === "1min",
    `${name}: session settings come from the pool configuration`,
  );

  const role = (await client.query(QUERIES.role)).rows[0];
  check(
    role !== undefined &&
      [
        role.rolsuper,
        role.rolcreaterole,
        role.rolcreatedb,
        role.rolreplication,
        role.rolbypassrls,
      ].every((value) => value === false),
    `${name}: role has no superuser, CREATEROLE, CREATEDB, REPLICATION, or BYPASSRLS`,
  );

  const label = (await client.query(QUERIES.label)).rows;
  const settings: unknown[] = label.flatMap((row) => row.setconfig ?? []);
  const labels = settings.filter(
    (setting): setting is string =>
      typeof setting === "string" && setting.startsWith("app.environment="),
  );
  check(
    labels.length === 1 &&
      labels[0] === `app.environment=${target.environmentLabel}`,
    `${name}: database is labeled app.environment=${target.environmentLabel}`,
  );

  const priv = (
    await client.query(QUERIES.privileges, [
      target.database,
      target.forbiddenDatabase,
    ])
  ).rows[0];
  check(
    priv?.connect_own === true,
    `${name}: may connect to ${target.database}`,
  );
  check(
    priv?.connect_other === false,
    `${name}: may not connect to ${target.forbiddenDatabase} (catalog check)`,
  );
  check(
    priv?.create_own === target.mayCreateInDatabase,
    `${name}: ${target.mayCreateInDatabase ? "may" : "may not"} create schemas in ${target.database}`,
  );

  const state = (await client.query(QUERIES.state)).rows[0];
  check(
    state?.app_relations === 0,
    `${name}: no application tables, views, or sequences in ${target.database}`,
  );
  check(
    state?.drizzle_schema === false && state?.migrations_table === false,
    `${name}: no migrations applied (no drizzle schema or migrations table)`,
  );
}

// Fixed codes for validator and pool-configuration errors. Only these codes
// are printed, never the messages, so the output can't carry a value even if
// a validator message changes. The patterns match the messages in
// src/lib/db/env.ts and pool-config.ts; anything else is OTHER.
const CONFIGURATION_CODES: ReadonlyArray<readonly [RegExp, string]> = [
  [/ is not set\.$/, "NOT_SET"],
  [/ is set but invalid, so TEST_DATABASE_URL/, "OTHER_URL_INVALID"],
  [/ is not a valid URL\.$/, "INVALID_URL"],
  [/ must start with postgresql:\/\//, "SCHEME"],
  [/ must not include query parameters/, "QUERY_PARAMETERS"],
  [/ must not include a #fragment/, "FRAGMENT"],
  [/ host name/, "HOST"],
  [/ port/, "PORT"],
  [/ user name/, "USER"],
  [/ password/, "PASSWORD"],
  [/ database name|must name exactly one database/, "DATABASE"],
  [/^DATABASE_SSL_MODE=disable is only allowed/, "TLS_REMOTE_DISABLE"],
  [/^DATABASE_SSL_MODE must be/, "TLS_MODE"],
  [/^DATABASE_SSL_CA/, "TLS_CA"],
  [/^PGOPTIONS must not be set/, "PGOPTIONS"],
  [/NODE_ENV is production/, "NODE_ENV_PRODUCTION"],
  [/must name a database ending in _test/, "TEST_DATABASE_NAME"],
  [/must point to a loopback host/, "TEST_HOST_NOT_LOOPBACK"],
  [/must not point to the same database/, "TEST_SAME_DATABASE"],
];

export function configurationCodes(errors: readonly string[]): string {
  const codes = errors.map(
    (message) =>
      CONFIGURATION_CODES.find(([pattern]) => pattern.test(message))?.[1] ??
      "OTHER",
  );
  return [...new Set(codes)].join(", ");
}

// Only codes the driver or Node.js produce, never a message: a five-character
// SQLSTATE (28P01, 3D000), a Node error code (ECONNREFUSED, ERR_…), or a
// built-in error class name.
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "AggregateError",
  "DatabaseError",
  "RangeError",
  "TypeError",
]);

export function errorKind(error: unknown): string {
  if (error && typeof error === "object") {
    if (
      "code" in error &&
      typeof error.code === "string" &&
      /^(?:[0-9A-Z]{5}|E[A-Z0-9]{2,20}|ERR_[A-Z0-9_]{1,40})$/.test(error.code)
    ) {
      return error.code;
    }
    if (error instanceof Error && SAFE_ERROR_NAMES.has(error.name)) {
      return error.name;
    }
  }
  return "unknown error";
}

export function formatResults(results: CheckResult[]): string {
  const lines = results.map(
    ({ pass, label, detail }) =>
      `${pass ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`,
  );
  const failed = results.filter((result) => !result.pass).length;
  lines.push(
    "",
    failed === 0
      ? `ALL ${results.length} CHECKS PASSED`
      : `${failed} OF ${results.length} CHECKS FAILED`,
  );
  return lines.join("\n");
}
