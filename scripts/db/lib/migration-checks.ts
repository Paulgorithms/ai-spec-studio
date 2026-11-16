// Read-only checks around the first migration (Step 4B-S).
//
//   pre   before `npm run db:migrate`: the target is the approved local
//         development database, reached as the migrator with SCRAM; nothing
//         from the migration exists yet; the migrator has exactly the
//         privileges it needs; no other migrator session is open; and
//         PostgreSQL evaluates the two CHECK patterns as tested.
//   post  after it: the tables, columns, constraints, indexes, owners, grants,
//         and the migration journal match the reviewed migration.
//   constraints
//         diagnostic: lists every constraint in schema public as PostgreSQL
//         stores it (name, type, pg_get_constraintdef), marking each one
//         expected, mismatched, unexpected, or missing.
//
// Both phases connect once as DATABASE_MIGRATION_URL, inside a READ ONLY
// transaction that is always rolled back, and print fixed PASS/FAIL labels
// with codes only (helpers from live-verification.ts). They fail closed: an
// unexpected environment or target means no connection at all.
import type { Pool, PoolClient } from "pg";
import {
  isLoopbackHost,
  parseMigrationDatabaseEnv,
  type DatabaseEnv,
} from "../../../src/lib/db/env";
import {
  buildPoolConfig,
  checkPgEnvironment,
} from "../../../src/lib/db/pool-config";
import { PROJECT_SLUG_PATTERN } from "../../../src/lib/db/schema/projects";
import { SPECIFICATION_KEY_PATTERN } from "../../../src/lib/db/schema/specifications";
import {
  configurationCodes,
  errorKind,
  type CheckResult,
  type PoolFactory,
} from "./live-verification";

export type Phase = "pre" | "post" | "constraints";

// The reviewed migration (Step 4B). The entry script hashes the file on disk
// the way the drizzle-orm migrator does (SHA-256 of the whole file).
export const APPROVED_MIGRATION = {
  tag: "0000_initial_schema",
  sha256: "cb836c11552e8658df70d3366b9a26c4bb8c31e3fc82156a085216eae292eaf3",
} as const;

export type MigrationFiles = {
  journalEntries: number;
  tag: string;
  when: number;
  sha256: string;
};

const MIGRATOR = "ai_spec_studio_migrator";
const APP = "ai_spec_studio_app";
const TEST_ROLE = "ai_spec_studio_test";
const DEV_DB = "ai_spec_studio_dev";
export const LOCAL_PORT = 5432;
export const UNEXPECTED_VARIABLES =
  /^(PG[A-Z_]*|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS)$/;

// The cases checked in JavaScript by the schema tests, plus non-ASCII and
// newline cases. Expected results are what the CHECK constraints must do.
export const REGEX_CASES: ReadonlyArray<{
  pattern: "slug" | "key";
  input: string;
  matches: boolean;
}> = [
  ...(
    [
      ["billing-service", true],
      ["a", true],
      ["v2-api", true],
      ["Billing-Service", false],
      ["billing_service", false],
      ["-billing", false],
      ["billing-", false],
      ["billing--service", false],
      ["", false],
      ["B", false],
      ["Z", false],
      ["é", false],
      ["ä-b", false],
      ["ı", false],
      ["billing\n", false],
      ["billing\nservice", false],
      ["billing service", false],
    ] as const
  ).map(([input, matches]) => ({ pattern: "slug" as const, input, matches })),
  ...(
    [
      ["SPEC-001", true],
      ["SPEC-007", true],
      ["SPEC-1234", true],
      ["SPEC-01", false],
      ["spec-001", false],
      ["SPEC-00A", false],
      ["SPEC 001", false],
      ["XSPEC-001", false],
      ["SPEC-001 ", false],
      ["SPEC-001\n", false],
      ["SPEC-٠٠١", false],
      ["SPEC-１２３", false],
    ] as const
  ).map(([input, matches]) => ({ pattern: "key" as const, input, matches })),
];

const PATTERNS = { slug: PROJECT_SLUG_PATTERN, key: SPECIFICATION_KEY_PATTERN };

// Expected state after the migration.
export const EXPECTED_COLUMNS: ReadonlyArray<
  readonly [
    table: string,
    column: string,
    type: string,
    nullable: "NO",
    default_: string | null,
  ]
> = [
  ["projects", "id", "uuid", "NO", "gen_random_uuid()"],
  ["projects", "slug", "text", "NO", null],
  ["projects", "name", "text", "NO", null],
  ["projects", "description", "text", "NO", "''::text"],
  ["projects", "created_at", "timestamp(3) with time zone", "NO", "now()"],
  ["projects", "updated_at", "timestamp(3) with time zone", "NO", "now()"],
  ["specifications", "id", "uuid", "NO", "gen_random_uuid()"],
  ["specifications", "project_id", "uuid", "NO", null],
  ["specifications", "key", "text", "NO", null],
  ["specifications", "title", "text", "NO", null],
  ["specifications", "summary", "text", "NO", "''::text"],
  ["specifications", "status", "text", "NO", "'draft'::text"],
  [
    "specifications",
    "created_at",
    "timestamp(3) with time zone",
    "NO",
    "now()",
  ],
  [
    "specifications",
    "updated_at",
    "timestamp(3) with time zone",
    "NO",
    "now()",
  ],
];

// [table, constraint, contype, required fragments of pg_get_constraintdef]
export const EXPECTED_CONSTRAINTS: ReadonlyArray<
  readonly [string, string, string, readonly string[]]
> = [
  ["projects", "projects_pkey", "p", ["PRIMARY KEY (id)"]],
  [
    "projects",
    "projects_slug_format_check",
    "c",
    [`'${PROJECT_SLUG_PATTERN}'`],
  ],
  ["projects", "projects_slug_unique", "u", ["UNIQUE (slug)"]],
  [
    "specifications",
    "specifications_key_format_check",
    "c",
    [`'${SPECIFICATION_KEY_PATTERN}'`],
  ],
  ["specifications", "specifications_key_unique", "u", ["UNIQUE (key)"]],
  ["specifications", "specifications_pkey", "p", ["PRIMARY KEY (id)"]],
  [
    "specifications",
    "specifications_project_id_fkey",
    "f",
    ["FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT"],
  ],
  [
    "specifications",
    "specifications_status_check",
    "c",
    ["'draft'::text", "'in-review'::text", "'approved'::text"],
  ],
];

// [table, index, required fragment of pg_indexes.indexdef]
export const EXPECTED_INDEXES: ReadonlyArray<
  readonly [string, string, string]
> = [
  ["projects", "projects_pkey", "USING btree (id)"],
  ["projects", "projects_slug_unique", "USING btree (slug)"],
  ["specifications", "specifications_key_unique", "USING btree (key)"],
  ["specifications", "specifications_pkey", "USING btree (id)"],
  [
    "specifications",
    "specifications_project_id_idx",
    "USING btree (project_id)",
  ],
  [
    "specifications",
    "specifications_updated_at_key_idx",
    "USING btree (updated_at DESC NULLS LAST, key)",
  ],
];

export const QUERIES = {
  begin: "BEGIN TRANSACTION READ ONLY",
  rollback: "ROLLBACK",
  session: `/* session */
SELECT current_setting('server_version_num')::int AS version_num,
       inet_server_addr()::text AS server_addr,
       inet_server_port() AS server_port,
       inet_client_addr()::text AS client_addr,
       current_user::text AS current_role_name,
       session_user::text AS session_role_name,
       current_database()::text AS database_name,
       system_user::text AS auth_identity,
       current_setting('search_path') AS search_path,
       current_schema()::text AS current_schema_name,
       current_setting('transaction_read_only') AS read_only,
       (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl`,
  role: `/* role */
SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
FROM pg_roles WHERE rolname = current_user`,
  label: `/* label */
SELECT s.setconfig
FROM pg_db_role_setting AS s
JOIN pg_database AS d ON d.oid = s.setdatabase
WHERE d.datname = current_database() AND s.setrole = 0`,
  schemas: `/* schemas */
SELECT nspname::text AS name FROM pg_namespace
WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
ORDER BY nspname::text COLLATE "C"`,
  privileges: `/* privileges */
SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS create_db,
       has_schema_privilege(current_user, 'public', 'USAGE') AS usage_public,
       has_schema_privilege(current_user, 'public', 'CREATE') AS create_public`,
  objects: `/* objects */
SELECT to_regclass('public.projects') IS NOT NULL AS projects,
       to_regclass('public.specifications') IS NOT NULL AS specifications,
       to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS journal,
       (SELECT count(*)::int FROM pg_class AS c
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public') AS public_relations`,
  sessions: `/* sessions */
SELECT count(*)::int AS other_migrator_sessions
FROM pg_stat_activity
WHERE usename = current_user AND pid <> pg_backend_pid()`,
  regex: `/* regex */
SELECT t.i::int AS i, (t.v ~ t.p) AS matched
FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t (v, p, i)
ORDER BY t.i`,
  tables: `/* tables */
SELECT c.relname::text AS name, c.relkind::text AS kind,
       pg_get_userbyid(c.relowner)::text AS owner, c.relrowsecurity AS rls
FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
ORDER BY c.relname::text COLLATE "C"`,
  columns: `/* columns */
SELECT c.relname::text AS table_name, a.attname::text AS column_name,
       format_type(a.atttypid, a.atttypmod) AS type,
       CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable,
       pg_get_expr(d.adbin, d.adrelid) AS default_value
FROM pg_attribute AS a
JOIN pg_class AS c ON c.oid = a.attrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum`,
  constraints: `/* constraints */
SELECT c.relname::text AS table_name, k.conname::text AS name,
       k.contype::text AS type, pg_get_constraintdef(k.oid) AS definition,
       CASE WHEN k.contype = 'n' AND cardinality(k.conkey) = 1 THEN
         (SELECT a.attname::text FROM pg_attribute AS a
          WHERE a.attrelid = k.conrelid AND a.attnum = k.conkey[1])
       END AS column_name
FROM pg_constraint AS k
JOIN pg_class AS c ON c.oid = k.conrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
ORDER BY c.relname::text COLLATE "C", k.conname::text COLLATE "C"`,
  indexes: `/* indexes */
SELECT tablename::text AS table_name, indexname::text AS name, indexdef AS definition
FROM pg_indexes WHERE schemaname = 'public'
ORDER BY tablename::text COLLATE "C", indexname::text COLLATE "C"`,
  extras: `/* extras */
SELECT (SELECT count(*)::int FROM pg_trigger AS t
        JOIN pg_class AS c ON c.oid = t.tgrelid
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal) AS triggers,
       (SELECT count(*)::int FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'drizzle')) AS functions`,
  grants: `/* grants */
SELECT t.name AS table_name,
       has_table_privilege($1, t.qualified, 'SELECT') AS app_select,
       has_table_privilege($1, t.qualified, 'INSERT') AS app_insert,
       has_table_privilege($1, t.qualified, 'UPDATE') AS app_update,
       has_table_privilege($1, t.qualified, 'DELETE') AS app_delete,
       has_table_privilege($1, t.qualified, 'TRUNCATE, REFERENCES, TRIGGER') AS app_other,
       has_table_privilege($2, t.qualified, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS test_any,
       has_table_privilege('public', t.qualified, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS public_any
FROM (VALUES ('projects', 'public.projects'), ('specifications', 'public.specifications'))
  AS t (name, qualified)
ORDER BY 1`,
  journalAccess: `/* journal_access */
SELECT pg_get_userbyid(n.nspowner)::text AS schema_owner,
       pg_get_userbyid(c.relowner)::text AS table_owner,
       has_schema_privilege($1, 'drizzle', 'USAGE') AS app_usage,
       has_schema_privilege($2, 'drizzle', 'USAGE') AS test_usage,
       has_schema_privilege($1, 'public', 'CREATE') AS app_create_public
FROM pg_namespace AS n
JOIN pg_class AS c ON c.relnamespace = n.oid AND c.relname = '__drizzle_migrations'
WHERE n.nspname = 'drizzle'`,
  journal: `/* journal */
SELECT hash, created_at::text AS created_at
FROM drizzle.__drizzle_migrations ORDER BY id`,
} as const;

export type Check = (pass: boolean, label: string, detail?: string) => void;

// Who a session must be, and which database it must be in. The development
// profile is the migrator in ai_spec_studio_dev; test-database-target.ts
// defines the test profile. Labels are built from these values, so the
// development output is the same as before profiles existed.
export type SessionProfile = {
  role: string;
  database: string;
  environmentLabel: string;
};

export const DEVELOPMENT_PROFILE: SessionProfile = {
  role: MIGRATOR,
  database: DEV_DB,
  environmentLabel: "development",
};

// Every column is NOT NULL. PostgreSQL 18 stores each column's NOT NULL as
// its own pg_constraint row (contype 'n'); earlier versions don't. The
// preflight requires PostgreSQL 18, so exactly one per column is expected.
export const EXPECTED_NOT_NULL_COLUMNS: readonly string[] =
  EXPECTED_COLUMNS.map(([table, column]) => `${table}.${column}`);

export type ConstraintRow = {
  table_name?: unknown;
  name?: unknown;
  type?: unknown;
  definition?: unknown;
  column_name?: unknown;
};

export type ConstraintEntry = {
  status: "expected" | "mismatch" | "unexpected" | "missing";
  table: string;
  name: string;
  type: string;
  definition: string;
};

// Compares the catalog's constraints in schema public with the reviewed
// migration: the eight approved constraints (exact names, order, types, and
// definition fragments) and one NOT NULL constraint per column.
export function compareConstraints(rows: readonly ConstraintRow[]): {
  approved: boolean;
  notNull: boolean;
  entries: ConstraintEntry[];
} {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const others = rows.filter((row) => row.type !== "n");
  const notNullRows = rows.filter((row) => row.type === "n");

  const approved =
    others.length === EXPECTED_CONSTRAINTS.length &&
    EXPECTED_CONSTRAINTS.every(([table, name, type, fragments], i) => {
      const row = others[i];
      return (
        row?.table_name === table &&
        row.name === name &&
        row.type === type &&
        typeof row.definition === "string" &&
        fragments.every((fragment) =>
          (row.definition as string).includes(fragment),
        )
      );
    });

  const notNullColumns = notNullRows.map(
    (row) => `${text(row.table_name)}.${text(row.column_name)}`,
  );
  const notNull =
    notNullRows.every((row) => typeof row.column_name === "string") &&
    JSON.stringify([...notNullColumns].sort()) ===
      JSON.stringify([...EXPECTED_NOT_NULL_COLUMNS].sort());

  const entries: ConstraintEntry[] = rows.map((row) => {
    const table = text(row.table_name);
    const name = text(row.name);
    const type = text(row.type);
    const definition = text(row.definition);
    let status: ConstraintEntry["status"];
    if (type === "n") {
      status = EXPECTED_NOT_NULL_COLUMNS.includes(
        `${table}.${text(row.column_name)}`,
      )
        ? "expected"
        : "unexpected";
    } else {
      const expected = EXPECTED_CONSTRAINTS.find(
        ([t, n]) => t === table && n === name,
      );
      status = !expected
        ? "unexpected"
        : expected[2] === type &&
            expected[3].every((fragment) => definition.includes(fragment))
          ? "expected"
          : "mismatch";
    }
    return { status, table, name, type, definition };
  });
  for (const [table, name, type] of EXPECTED_CONSTRAINTS) {
    if (!rows.some((row) => row.table_name === table && row.name === name)) {
      entries.push({ status: "missing", table, name, type, definition: "" });
    }
  }
  for (const column of EXPECTED_NOT_NULL_COLUMNS) {
    if (!notNullColumns.includes(column)) {
      const [table = "", name = ""] = column.split(".");
      entries.push({
        status: "missing",
        table,
        name: `NOT NULL ${name}`,
        type: "n",
        definition: "",
      });
    }
  }
  return { approved, notNull, entries };
}

const APPROVED_LABEL =
  "constraints: primary keys, UNIQUE, CHECK, and the RESTRICT foreign key as reviewed";
const NOT_NULL_LABEL =
  "constraints: exactly one NOT NULL constraint for each of the 14 columns";

export async function runMigrationChecks(
  phase: Phase,
  env: DatabaseEnv,
  createPool: PoolFactory,
  files: MigrationFiles,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check: Check = (pass, label, detail) =>
    results.push(
      detail === undefined ? { pass, label } : { pass, label, detail },
    );

  // 1. The migration files are the reviewed ones.
  check(
    files.journalEntries === 1 && files.tag === APPROVED_MIGRATION.tag,
    `files: the journal has exactly one entry, ${APPROVED_MIGRATION.tag}`,
  );
  check(
    files.sha256 === APPROVED_MIGRATION.sha256,
    `files: ${APPROVED_MIGRATION.tag}.sql matches the reviewed SHA-256`,
  );

  // 2. The environment (fail closed: no pool at all).
  const unexpected = Object.keys(env).filter(
    (name) => UNEXPECTED_VARIABLES.test(name) && env[name] !== undefined,
  );
  check(
    unexpected.length === 0,
    "environment: no PG*, NODE_TLS_REJECT_UNAUTHORIZED, or NODE_EXTRA_CA_CERTS variables",
    unexpected.length > 0 ? `set: ${unexpected.sort().join(", ")}` : undefined,
  );
  check(
    checkPgEnvironment(env).length === 0,
    "environment: no PGBINARY or PGREPLICATION",
  );

  // 3. The target.
  const parsed = parseMigrationDatabaseEnv(env);
  if (!parsed.ok) {
    check(
      false,
      "target: DATABASE_MIGRATION_URL passes the project validator",
      `(${configurationCodes(parsed.errors)})`,
    );
  }
  const connection = parsed.ok ? parsed.value.connection : undefined;
  const expectedTarget =
    connection !== undefined &&
    connection.user === MIGRATOR &&
    connection.database === DEV_DB &&
    connection.port === LOCAL_PORT &&
    isLoopbackHost(connection.host) &&
    connection.ssl === false;
  if (connection) {
    check(
      expectedTarget,
      `target: DATABASE_MIGRATION_URL is ${MIGRATOR} on loopback port ${LOCAL_PORT}, database ${DEV_DB}, TLS off`,
    );
  }

  if (results.some((result) => !result.pass) || !connection) {
    check(false, "connection skipped (a check above failed)");
    return results;
  }

  const config = buildPoolConfig(connection, 1);
  if (!config.ok) {
    check(
      false,
      "pool configuration",
      `(${configurationCodes(config.errors)})`,
    );
    return results;
  }

  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  try {
    pool = createPool({ ...config.value, max: 1, allowExitOnIdle: true });
    pool.on("error", () => {
      // Reported through the failing call; never log the driver message.
    });
    client = await pool.connect();
    check(true, "connected as the migrator");
    await client.query(QUERIES.begin);
    try {
      await checkSession(client, phase, check);
      if (phase === "pre") await checkBefore(client, check);
      else if (phase === "post") await checkAfter(client, files, check);
      else await diagnoseConstraints(client, check);
    } finally {
      await client.query(QUERIES.rollback);
    }
  } catch (error) {
    check(false, "checks could not finish", `(${errorKind(error)})`);
  } finally {
    try {
      client?.release();
    } catch {
      // Already released or broken; ending the pool cleans up.
    }
    if (pool) {
      try {
        await pool.end();
        check(pool.totalCount === 0, "pool closed");
      } catch (error) {
        check(false, "pool closed", `(${errorKind(error)})`);
      }
    }
  }
  return results;
}

export async function rows(
  client: PoolClient,
  text: string,
  values?: unknown[],
) {
  return (await client.query(text, values)).rows as Record<string, unknown>[];
}

async function checkSession(client: PoolClient, phase: Phase, check: Check) {
  await checkSessionIdentity(client, DEVELOPMENT_PROFILE, check);
  await checkSchemas(
    client,
    DEVELOPMENT_PROFILE,
    phase === "pre" ? ["public"] : ["drizzle", "public"],
    check,
  );
}

// Server, session, role attributes, and the database's own label.
export async function checkSessionIdentity(
  client: PoolClient,
  profile: SessionProfile,
  check: Check,
) {
  const { role: expectedRole, database: expectedDatabase } = profile;
  const s = (await rows(client, QUERIES.session))[0] ?? {};
  const addr = (value: unknown) =>
    typeof value === "string" && isLoopbackHost(value.replace(/\/\d+$/, ""));
  check(
    typeof s.version_num === "number" &&
      s.version_num >= 180000 &&
      s.version_num < 190000,
    "server: PostgreSQL 18",
  );
  check(
    addr(s.server_addr) && addr(s.client_addr) && s.server_port === LOCAL_PORT,
    `server: loopback endpoint, port ${LOCAL_PORT}`,
  );
  check(s.ssl === false, "server: session is not using TLS");
  check(
    s.current_role_name === expectedRole &&
      s.session_role_name === expectedRole,
    `session: current_user and session_user are ${expectedRole}`,
  );
  check(
    s.database_name === expectedDatabase,
    `session: current_database() is ${expectedDatabase}`,
  );
  check(
    s.auth_identity === `scram-sha-256:${expectedRole}`,
    "session: authenticated with SCRAM-SHA-256",
  );
  check(s.read_only === "on", "session: read-only transaction");
  check(
    s.search_path === '"$user", public' && s.current_schema_name === "public",
    'session: search_path is "$user", public and current_schema() is public',
  );

  const role = (await rows(client, QUERIES.role))[0];
  check(
    role !== undefined &&
      [
        role.rolsuper,
        role.rolcreaterole,
        role.rolcreatedb,
        role.rolreplication,
        role.rolbypassrls,
      ].every((value) => value === false),
    "role: no superuser, CREATEROLE, CREATEDB, REPLICATION, or BYPASSRLS",
  );

  const labels = (await rows(client, QUERIES.label))
    .flatMap((row) => (Array.isArray(row.setconfig) ? row.setconfig : []))
    .filter(
      (setting): setting is string =>
        typeof setting === "string" && setting.startsWith("app.environment="),
    );
  check(
    labels.length === 1 &&
      labels[0] === `app.environment=${profile.environmentLabel}`,
    `database: labeled app.environment=${profile.environmentLabel}`,
  );
}

// No schema named after the role (it would come first in search_path), and
// exactly the expected non-system schemas. Returns the schemas found.
export async function checkSchemas(
  client: PoolClient,
  profile: SessionProfile,
  expectedSchemas: readonly string[],
  check: Check,
): Promise<unknown[]> {
  const schemas = (await rows(client, QUERIES.schemas)).map((row) => row.name);
  check(
    !schemas.includes(profile.role),
    `database: no schema named ${profile.role} (it would come first in search_path)`,
  );
  check(
    JSON.stringify(schemas) === JSON.stringify(expectedSchemas),
    `database: the only non-system schemas are ${expectedSchemas.join(" and ")}`,
  );
  return schemas;
}

async function checkBefore(client: PoolClient, check: Check) {
  const priv = (await rows(client, QUERIES.privileges))[0] ?? {};
  check(
    priv.create_db === true,
    `privileges: CREATE on database ${DEV_DB} (for the drizzle schema)`,
  );
  check(
    priv.usage_public === true && priv.create_public === true,
    "privileges: USAGE and CREATE on schema public",
  );

  const objects = (await rows(client, QUERIES.objects))[0] ?? {};
  check(
    objects.projects === false && objects.specifications === false,
    "state: public.projects and public.specifications don't exist",
  );
  check(objects.journal === false, "state: no drizzle migration journal");
  check(objects.public_relations === 0, "state: schema public is empty");

  const sessions = (await rows(client, QUERIES.sessions))[0] ?? {};
  check(
    sessions.other_migrator_sessions === 0,
    "concurrency: no other session is connected as the migrator",
  );

  await checkRegexCases(client, check);
}

// PostgreSQL's evaluation of the two CHECK patterns on REGEX_CASES.
export async function checkRegexCases(client: PoolClient, check: Check) {
  const matched = (
    await rows(client, QUERIES.regex, [
      REGEX_CASES.map((c) => c.input),
      REGEX_CASES.map((c) => PATTERNS[c.pattern]),
    ])
  ).map((row) => row.matched);
  for (const pattern of ["slug", "key"] as const) {
    const failures = REGEX_CASES.flatMap((c, i) =>
      c.pattern === pattern && matched[i] !== c.matches ? [i + 1] : [],
    );
    const count = REGEX_CASES.filter((c) => c.pattern === pattern).length;
    check(
      matched.length === REGEX_CASES.length && failures.length === 0,
      `regex: the ${pattern} pattern gives the expected result for all ${count} cases`,
      failures.length > 0 ? `failing cases: ${failures.join(", ")}` : undefined,
    );
  }
}

async function checkAfter(
  client: PoolClient,
  files: MigrationFiles,
  check: Check,
) {
  await checkStructure(client, MIGRATOR, check);
  await checkDevelopmentGrantsAndJournal(client, files, check);
}

// The migration's objects in schema public: tables (with their owner),
// columns, constraints, indexes, and no triggers or functions.
export async function checkStructure(
  client: PoolClient,
  owner: string,
  check: Check,
) {
  const tables = await rows(client, QUERIES.tables);
  check(
    JSON.stringify(tables) ===
      JSON.stringify(
        ["projects", "specifications"].map((name) => ({
          name,
          kind: "r",
          owner,
          rls: false,
        })),
      ),
    `tables: exactly projects and specifications in public, owned by ${owner}, no row-level security`,
  );

  const columns = (await rows(client, QUERIES.columns)).map((row) => [
    row.table_name,
    row.column_name,
    row.type,
    row.nullable,
    row.default_value ?? null,
  ]);
  check(
    JSON.stringify(columns) === JSON.stringify(EXPECTED_COLUMNS),
    "columns: names, order, types, NOT NULL, and defaults as reviewed",
  );

  const constraints = compareConstraints(
    await rows(client, QUERIES.constraints),
  );
  check(constraints.approved, APPROVED_LABEL);
  check(constraints.notNull, NOT_NULL_LABEL);

  const indexes = await rows(client, QUERIES.indexes);
  check(
    indexes.length === EXPECTED_INDEXES.length &&
      EXPECTED_INDEXES.every(([table, name, fragment], i) => {
        const row = indexes[i];
        return (
          row?.table_name === table &&
          row.name === name &&
          typeof row.definition === "string" &&
          row.definition.includes(fragment)
        );
      }),
    "indexes: exactly the six reviewed indexes, with updated_at DESC",
  );

  const extras = (await rows(client, QUERIES.extras))[0] ?? {};
  check(
    extras.triggers === 0 && extras.functions === 0,
    "objects: no triggers or functions in public or drizzle",
  );
}

async function checkDevelopmentGrantsAndJournal(
  client: PoolClient,
  files: MigrationFiles,
  check: Check,
) {
  const grants = await rows(client, QUERIES.grants, [APP, TEST_ROLE]);
  check(
    grants.length === 2 &&
      grants.every(
        (row) =>
          row.app_select === true &&
          row.app_insert === true &&
          row.app_update === true &&
          row.app_delete === true &&
          row.app_other === false,
      ),
    `grants: ${APP} has exactly SELECT, INSERT, UPDATE, DELETE on both tables`,
  );
  check(
    grants.length === 2 &&
      grants.every((row) => row.test_any === false && row.public_any === false),
    `grants: ${TEST_ROLE} and PUBLIC have no table privileges`,
  );

  const access = (
    await rows(client, QUERIES.journalAccess, [APP, TEST_ROLE])
  )[0];
  check(
    access?.schema_owner === MIGRATOR && access.table_owner === MIGRATOR,
    `journal: drizzle schema and __drizzle_migrations owned by ${MIGRATOR}`,
  );
  check(
    access?.app_usage === false &&
      access.test_usage === false &&
      access.app_create_public === false,
    "journal: the app and test roles can't use the drizzle schema; the app can't create in public",
  );

  const journal = await rows(client, QUERIES.journal);
  check(
    journal.length === 1 &&
      journal[0]?.hash === files.sha256 &&
      journal[0]?.created_at === String(files.when),
    `journal: exactly one applied migration, with the hash and timestamp of ${APPROVED_MIGRATION.tag}`,
  );
}

// The constraints diagnostic: one line per constraint as stored, then the
// same two verdicts the post phase uses. Constraint names and definitions are
// catalog metadata, not credentials.
async function diagnoseConstraints(client: PoolClient, check: Check) {
  const { approved, notNull, entries } = compareConstraints(
    await rows(client, QUERIES.constraints),
  );
  for (const entry of entries) {
    check(
      entry.status === "expected",
      `constraint ${entry.table}.${entry.name} [${entry.type}]: ${entry.status}`,
      entry.definition || undefined,
    );
  }
  check(approved, APPROVED_LABEL);
  check(notNull, NOT_NULL_LABEL);
}
