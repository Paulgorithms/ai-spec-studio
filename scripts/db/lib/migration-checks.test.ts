import { readFileSync } from "node:fs";
import type { Pool, PoolConfig } from "pg";
import { describe, expect, test } from "vitest";
import {
  PROJECT_SLUG_PATTERN,
  SPECIFICATION_KEY_PATTERN,
} from "../../../src/lib/db/schema";
import { formatResults, type CheckResult } from "./live-verification";
import {
  APPROVED_MIGRATION,
  compareConstraints,
  type ConstraintRow,
  EXPECTED_COLUMNS,
  EXPECTED_CONSTRAINTS,
  EXPECTED_INDEXES,
  QUERIES,
  REGEX_CASES,
  runMigrationChecks,
  type MigrationFiles,
  type Phase,
} from "./migration-checks";

// A fake pg pool, as in live-verification.test.ts: no sockets; queries are
// answered by the /* name */ comment that starts each one.
type Rows = Record<string, unknown>[];
type Answers = Record<string, Rows | Error>;

const PASSWORD = "FakeMigrator:p@ss/word";
const MIGRATION_URL = `postgresql://ai_spec_studio_migrator:${encodeURIComponent(PASSWORD)}@127.0.0.1:5432/ai_spec_studio_dev`;
const ENV = {
  DATABASE_MIGRATION_URL: MIGRATION_URL,
  DATABASE_SSL_MODE: "disable",
};
const FILES: MigrationFiles = {
  journalEntries: 1,
  tag: APPROVED_MIGRATION.tag,
  when: 1794739919891,
  sha256: APPROVED_MIGRATION.sha256,
};

const common = (schemas: string[]): Answers => ({
  session: [
    {
      version_num: 180006,
      server_addr: "127.0.0.1/32",
      server_port: 5432,
      client_addr: "127.0.0.1/32",
      current_role_name: "ai_spec_studio_migrator",
      session_role_name: "ai_spec_studio_migrator",
      database_name: "ai_spec_studio_dev",
      auth_identity: "scram-sha-256:ai_spec_studio_migrator",
      search_path: '"$user", public',
      current_schema_name: "public",
      read_only: "on",
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
  label: [{ setconfig: ["app.environment=development"] }],
  schemas: schemas.map((name) => ({ name })),
});

// What PostgreSQL returns for the matching regex inputs: the expected values.
const regexRows = (flip: number[] = []) =>
  REGEX_CASES.map((c, i) => ({
    i: i + 1,
    matched: flip.includes(i + 1) ? !c.matches : c.matches,
  }));

const PRE: Answers = {
  ...common(["public"]),
  privileges: [{ create_db: true, usage_public: true, create_public: true }],
  objects: [
    {
      projects: false,
      specifications: false,
      journal: false,
      public_relations: 0,
    },
  ],
  sessions: [{ other_migrator_sessions: 0 }],
  regex: regexRows(),
};

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

// pg_constraint for schema public as PostgreSQL 18 returns it: the eight
// approved constraints plus one NOT NULL row (contype 'n', named
// <table>_<column>_not_null) per column, sorted by table and name in byte
// order, as QUERIES.constraints sorts them.
function pg18ConstraintRows(): Rows {
  const approved = EXPECTED_CONSTRAINTS.map(([table_name, name, type]) => ({
    table_name,
    name,
    type,
    definition: DEFS[name],
    column_name: null,
  }));
  const notNull = EXPECTED_COLUMNS.map(([table_name, column]) => ({
    table_name,
    name: `${table_name}_${column}_not_null`,
    type: "n",
    definition: `NOT NULL ${column}`,
    column_name: column,
  }));
  const key = (row: { table_name: string; name: string }) =>
    `${row.table_name}\u0000${row.name}`;
  return [...approved, ...notNull].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
}

const POST: Answers = {
  ...common(["drizzle", "public"]),
  tables: ["projects", "specifications"].map((name) => ({
    name,
    kind: "r",
    owner: "ai_spec_studio_migrator",
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
  constraints: pg18ConstraintRows(),
  indexes: EXPECTED_INDEXES.map(([table_name, name, fragment]) => ({
    table_name,
    name,
    definition: `CREATE INDEX ${name} ON public.${table_name} ${fragment}`,
  })),
  extras: [{ triggers: 0, functions: 0 }],
  grants: ["projects", "specifications"].map((table_name) => ({
    table_name,
    app_select: true,
    app_insert: true,
    app_update: true,
    app_delete: true,
    app_other: false,
    test_any: false,
    public_any: false,
  })),
  journal_access: [
    {
      schema_owner: "ai_spec_studio_migrator",
      table_owner: "ai_spec_studio_migrator",
      app_usage: false,
      test_usage: false,
      app_create_public: false,
    },
  ],
  journal: [{ hash: APPROVED_MIGRATION.sha256, created_at: "1794739919891" }],
};

type Call = { text: string; values?: unknown[] };

function fakePool(answers: Answers, connectError?: Error) {
  const state = {
    created: 0,
    ended: false,
    released: false,
    calls: [] as Call[],
  };
  const createPool = (config: PoolConfig): Pool => {
    state.created += 1;
    expect(config).toMatchObject({
      user: "ai_spec_studio_migrator",
      max: 1,
      ssl: false,
    });
    const client = {
      query: async (text: string, values?: unknown[]) => {
        state.calls.push(values === undefined ? { text } : { text, values });
        if (text === QUERIES.begin || text === QUERIES.rollback)
          return { rows: [] };
        const name = /^\/\* (\w+) \*\//.exec(text)?.[1] ?? "";
        const answer = answers[name];
        if (answer instanceof Error) throw answer;
        return { rows: answer ?? [] };
      },
      release: () => {
        state.released = true;
      },
    };
    const pool = {
      totalCount: 1,
      on: () => pool,
      connect: async () => {
        if (connectError) throw connectError;
        return client;
      },
      end: async () => {
        state.ended = true;
        pool.totalCount = 0;
      },
    };
    return pool as unknown as Pool;
  };
  return { state, createPool };
}

async function run(
  phase: Phase,
  answers: Answers,
  options: {
    env?: Record<string, string | undefined>;
    files?: MigrationFiles;
    connectError?: Error;
  } = {},
) {
  const { state, createPool } = fakePool(answers, options.connectError);
  const results = await runMigrationChecks(
    phase,
    options.env ?? ENV,
    createPool,
    options.files ?? FILES,
  );
  return { state, results, output: formatResults(results) };
}

const failed = (results: CheckResult[]) =>
  results.filter((r) => !r.pass).map((r) => r.label);

function expectNoSecrets(output: string) {
  expect(output).not.toContain(PASSWORD);
  expect(output).not.toContain(encodeURIComponent(PASSWORD));
  expect(output).not.toContain("postgresql://");
  expect(output).not.toContain("Fake");
}

describe("the pre phase", () => {
  test("passes with the approved state, read-only, and closes the pool", async () => {
    const { state, results, output } = await run("pre", PRE);
    expect(failed(results)).toEqual([]);
    expect(output).toMatch(/ALL 27 CHECKS PASSED$/);
    expect(state.created).toBe(1);
    expect(state.released && state.ended).toBe(true);
    expect(state.calls[0]?.text).toBe("BEGIN TRANSACTION READ ONLY");
    expect(state.calls.at(-1)?.text).toBe("ROLLBACK");
    for (const call of state.calls.slice(1, -1)) {
      expect(call.text).toMatch(/^\/\* \w+ \*\/\nSELECT /);
    }
    expectNoSecrets(output);
  });

  test("sends the regex cases and the schema's own patterns as parameters", async () => {
    const { state } = await run("pre", PRE);
    const call = state.calls.find((c) => c.text === QUERIES.regex);
    expect(call?.values).toEqual([
      REGEX_CASES.map((c) => c.input),
      REGEX_CASES.map((c) =>
        c.pattern === "slug" ? PROJECT_SLUG_PATTERN : SPECIFICATION_KEY_PATTERN,
      ),
    ]);
  });

  test.each([
    [
      "the journal already exists",
      {
        objects: [
          {
            projects: false,
            specifications: false,
            journal: true,
            public_relations: 0,
          },
        ],
      },
      "state: no drizzle migration journal",
    ],
    [
      "a table already exists",
      {
        objects: [
          {
            projects: true,
            specifications: false,
            journal: false,
            public_relations: 1,
          },
        ],
      },
      [
        "state: public.projects and public.specifications don't exist",
        "state: schema public is empty",
      ],
    ],
    [
      "a schema named after the migrator",
      { schemas: [{ name: "ai_spec_studio_migrator" }, { name: "public" }] },
      [
        "database: no schema named ai_spec_studio_migrator (it would come first in search_path)",
        "database: the only non-system schemas are public",
      ],
    ],
    [
      "a different search_path",
      {
        session: [{ ...(PRE.session as Rows)[0], search_path: "app, public" }],
      },
      'session: search_path is "$user", public and current_schema() is public',
    ],
    [
      "another migrator session",
      { sessions: [{ other_migrator_sessions: 1 }] },
      "concurrency: no other session is connected as the migrator",
    ],
    [
      "no CREATE on the database",
      {
        privileges: [
          { create_db: false, usage_public: true, create_public: true },
        ],
      },
      "privileges: CREATE on database ai_spec_studio_dev (for the drizzle schema)",
    ],
    [
      "no CREATE on public",
      {
        privileges: [
          { create_db: true, usage_public: true, create_public: false },
        ],
      },
      "privileges: USAGE and CREATE on schema public",
    ],
    [
      "trust or peer login",
      { session: [{ ...(PRE.session as Rows)[0], auth_identity: null }] },
      "session: authenticated with SCRAM-SHA-256",
    ],
    [
      "PostgreSQL 17",
      { session: [{ ...(PRE.session as Rows)[0], version_num: 170005 }] },
      "server: PostgreSQL 18",
    ],
    [
      "another port",
      { session: [{ ...(PRE.session as Rows)[0], server_port: 5433 }] },
      "server: loopback endpoint, port 5432",
    ],
    [
      "a missing label",
      { label: [] },
      "database: labeled app.environment=development",
    ],
    [
      "a superuser migrator",
      { role: [{ ...(PRE.role as Rows)[0], rolsuper: true }] },
      "role: no superuser, CREATEROLE, CREATEDB, REPLICATION, or BYPASSRLS",
    ],
  ])("fails when %s", async (_, override, label) => {
    const { results, state } = await run("pre", {
      ...PRE,
      ...(override as Answers),
    });
    expect(failed(results)).toEqual([label].flat());
    expect(state.ended).toBe(true);
  });

  test("names the regex cases PostgreSQL evaluates differently, by number", async () => {
    const { results } = await run("pre", {
      ...PRE,
      regex: regexRows([10, 22]),
    });
    expect(results.filter((r) => !r.pass)).toEqual([
      {
        pass: false,
        label:
          "regex: the slug pattern gives the expected result for all 17 cases",
        detail: "failing cases: 10",
      },
      {
        pass: false,
        label:
          "regex: the key pattern gives the expected result for all 12 cases",
        detail: "failing cases: 22",
      },
    ]);
  });
});

describe("failing closed before connecting", () => {
  test.each([
    [
      "a changed migration file",
      { files: { ...FILES, sha256: "0".repeat(64) } },
      "files: 0000_initial_schema.sql matches the reviewed SHA-256",
    ],
    [
      "a second journal entry",
      { files: { ...FILES, journalEntries: 2 } },
      "files: the journal has exactly one entry, 0000_initial_schema",
    ],
    [
      "a PG* variable",
      { env: { ...ENV, PGHOST: "FakeHost" } },
      "environment: no PG*, NODE_TLS_REJECT_UNAUTHORIZED, or NODE_EXTRA_CA_CERTS variables",
    ],
    [
      "NODE_TLS_REJECT_UNAUTHORIZED",
      { env: { ...ENV, NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
      "environment: no PG*, NODE_TLS_REJECT_UNAUTHORIZED, or NODE_EXTRA_CA_CERTS variables",
    ],
    [
      "the app role's URL",
      {
        env: {
          ...ENV,
          DATABASE_MIGRATION_URL: MIGRATION_URL.replace(
            "ai_spec_studio_migrator",
            "ai_spec_studio_app",
          ),
        },
      },
      "target: DATABASE_MIGRATION_URL is ai_spec_studio_migrator on loopback port 5432, database ai_spec_studio_dev, TLS off",
    ],
    [
      "the test database",
      {
        env: {
          ...ENV,
          DATABASE_MIGRATION_URL: MIGRATION_URL.replace(/_dev$/, "_test"),
        },
      },
      "target: DATABASE_MIGRATION_URL is ai_spec_studio_migrator on loopback port 5432, database ai_spec_studio_dev, TLS off",
    ],
    [
      "a remote host",
      {
        env: {
          DATABASE_MIGRATION_URL: MIGRATION_URL.replace(
            "127.0.0.1",
            "db.example.com",
          ),
        },
      },
      "target: DATABASE_MIGRATION_URL is ai_spec_studio_migrator on loopback port 5432, database ai_spec_studio_dev, TLS off",
    ],
    [
      "a missing URL",
      { env: { DATABASE_SSL_MODE: "disable" } },
      "target: DATABASE_MIGRATION_URL passes the project validator",
    ],
  ])("never creates a pool for %s", async (_, options, label) => {
    for (const phase of ["pre", "post"] as const) {
      const { state, results, output } = await run(
        phase,
        phase === "pre" ? PRE : POST,
        options,
      );
      expect(state.created).toBe(0);
      expect(failed(results)).toEqual([
        label,
        "connection skipped (a check above failed)",
      ]);
      expectNoSecrets(output);
      expect(output).not.toContain("FakeHost");
    }
  });
});

describe("the post phase", () => {
  test("passes with the reviewed result", async () => {
    const { results, output, state } = await run("post", POST);
    expect(failed(results)).toEqual([]);
    expect(output).toMatch(/ALL 30 CHECKS PASSED$/);
    expect(state.calls.find((c) => c.text === QUERIES.grants)?.values).toEqual([
      "ai_spec_studio_app",
      "ai_spec_studio_test",
    ]);
    expectNoSecrets(output);
  });

  const tables = POST.tables as Rows;
  const columns = POST.columns as Rows;
  const constraints = POST.constraints as Rows;
  const indexes = POST.indexes as Rows;
  const grants = POST.grants as Rows;
  const access = (POST.journal_access as Rows)[0];

  test.each([
    [
      "a table owned by someone else",
      { tables: [{ ...tables[0], owner: "postgres" }, tables[1]] },
      "tables: exactly projects and specifications in public, owned by ai_spec_studio_migrator, no row-level security",
    ],
    [
      "an extra table",
      {
        tables: [
          ...tables,
          {
            name: "users",
            kind: "r",
            owner: "ai_spec_studio_migrator",
            rls: false,
          },
        ],
      },
      "tables: exactly projects and specifications in public, owned by ai_spec_studio_migrator, no row-level security",
    ],
    [
      "a changed default",
      {
        columns: columns.map((c) =>
          c.column_name === "status" ? { ...c, default_value: null } : c,
        ),
      },
      "columns: names, order, types, NOT NULL, and defaults as reviewed",
    ],
    [
      "a nullable column",
      {
        columns: columns.map((c, i) =>
          i === 1 ? { ...c, nullable: "YES" } : c,
        ),
      },
      "columns: names, order, types, NOT NULL, and defaults as reviewed",
    ],
    [
      "a CASCADE foreign key",
      {
        constraints: constraints.map((c) =>
          c.type === "f"
            ? {
                ...c,
                definition:
                  "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE",
              }
            : c,
        ),
      },
      "constraints: primary keys, UNIQUE, CHECK, and the RESTRICT foreign key as reviewed",
    ],
    [
      "a missing NOT NULL constraint",
      {
        constraints: constraints.filter(
          (c) => c.name !== "specifications_title_not_null",
        ),
      },
      "constraints: exactly one NOT NULL constraint for each of the 14 columns",
    ],
    [
      "no NOT NULL rows (the pre-18 catalog shape)",
      { constraints: constraints.filter((c) => c.type !== "n") },
      "constraints: exactly one NOT NULL constraint for each of the 14 columns",
    ],
    [
      "a NOT NULL constraint on an unknown column",
      {
        constraints: [
          ...constraints,
          {
            table_name: "projects",
            name: "projects_extra_not_null",
            type: "n",
            definition: "NOT NULL extra",
            column_name: "extra",
          },
        ],
      },
      "constraints: exactly one NOT NULL constraint for each of the 14 columns",
    ],
    [
      "a missing CHECK",
      {
        constraints: constraints.filter(
          (c) => c.name !== "specifications_status_check",
        ),
      },
      "constraints: primary keys, UNIQUE, CHECK, and the RESTRICT foreign key as reviewed",
    ],
    [
      "an ascending index",
      {
        indexes: indexes.map((x) =>
          x.name === "specifications_updated_at_key_idx"
            ? {
                ...x,
                definition:
                  "CREATE INDEX x ON public.specifications USING btree (updated_at, key)",
              }
            : x,
        ),
      },
      "indexes: exactly the six reviewed indexes, with updated_at DESC",
    ],
    [
      "a trigger",
      { extras: [{ triggers: 1, functions: 1 }] },
      "objects: no triggers or functions in public or drizzle",
    ],
    [
      "TRUNCATE for the app",
      { grants: grants.map((g) => ({ ...g, app_other: true })) },
      "grants: ai_spec_studio_app has exactly SELECT, INSERT, UPDATE, DELETE on both tables",
    ],
    [
      "a missing app grant",
      { grants: [{ ...grants[0], app_delete: false }, grants[1]] },
      "grants: ai_spec_studio_app has exactly SELECT, INSERT, UPDATE, DELETE on both tables",
    ],
    [
      "a PUBLIC grant",
      { grants: grants.map((g) => ({ ...g, public_any: true })) },
      "grants: ai_spec_studio_test and PUBLIC have no table privileges",
    ],
    [
      "app access to the journal",
      { journal_access: [{ ...access, app_usage: true }] },
      "journal: the app and test roles can't use the drizzle schema; the app can't create in public",
    ],
    [
      "a journal owned by someone else",
      { journal_access: [{ ...access, table_owner: "postgres" }] },
      "journal: drizzle schema and __drizzle_migrations owned by ai_spec_studio_migrator",
    ],
    [
      "an empty journal",
      { journal: [] },
      "journal: exactly one applied migration, with the hash and timestamp of 0000_initial_schema",
    ],
    [
      "two journal rows",
      { journal: [...(POST.journal as Rows), ...(POST.journal as Rows)] },
      "journal: exactly one applied migration, with the hash and timestamp of 0000_initial_schema",
    ],
    [
      "a different hash",
      { journal: [{ hash: "0".repeat(64), created_at: "1794739919891" }] },
      "journal: exactly one applied migration, with the hash and timestamp of 0000_initial_schema",
    ],
    [
      "a missing drizzle schema",
      { schemas: [{ name: "public" }] },
      "database: the only non-system schemas are drizzle and public",
    ],
  ])("fails on %s", async (_, override, label) => {
    const { results } = await run("post", {
      ...POST,
      ...(override as Answers),
    });
    expect(failed(results)).toEqual([label]);
  });

  test("a missing journal table is reported by SQLSTATE, and the pool still closes", async () => {
    const { results, state, output } = await run("post", {
      ...POST,
      journal: Object.assign(
        new Error(`relation does not exist in ${MIGRATION_URL}`),
        { code: "42P01" },
      ),
    });
    expect(
      results.find((r) => r.label === "checks could not finish")?.detail,
    ).toBe("(42P01)");
    expect(state.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(state.released && state.ended).toBe(true);
    expectNoSecrets(output);
  });
});

describe("connection errors", () => {
  test("a failed login prints only its SQLSTATE", async () => {
    const { results, state, output } = await run("pre", PRE, {
      connectError: Object.assign(
        new Error(`password authentication failed: ${PASSWORD}`),
        { code: "28P01" },
      ),
    });
    expect(failed(results)).toEqual(["checks could not finish"]);
    expect(output).toContain("(28P01)");
    expect(state.ended).toBe(true);
    expectNoSecrets(output);
  });
});

describe("REGEX_CASES", () => {
  test("agree with the schema patterns evaluated in JavaScript", () => {
    for (const c of REGEX_CASES) {
      const pattern =
        c.pattern === "slug" ? PROJECT_SLUG_PATTERN : SPECIFICATION_KEY_PATTERN;
      expect([c.input, new RegExp(pattern).test(c.input)]).toEqual([
        c.input,
        c.matches,
      ]);
    }
    expect(REGEX_CASES).toHaveLength(29);
  });
});

describe("the SQL", () => {
  test.each(Object.entries(QUERIES))("%s is read-only", (_, text) => {
    const code = text.replace(/'[^']*'/g, "''");
    expect(code).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|SET|RESET|LOCK|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|COMMENT|SECURITY|nextval|setval|pg_terminate|pg_cancel|pg_reload|set_config|lo_)\b/i,
    );
  });
});

// Regression (Step 4C-1A): `ORDER BY 1 COLLATE "C"` is not a column position
// but the integer constant 1 with a collation, which PostgreSQL rejects with
// SQLSTATE 42804 ("collations are not supported by type integer"). The fake
// pool can't catch that, so these tests read the SQL itself.
describe("ORDER BY clauses", () => {
  const orderByItems = (text: string) => {
    const match = /\bORDER BY\s+([\s\S]*?)\s*$/i.exec(text.trim());
    return match ? match[1].split(",").map((item) => item.trim()) : [];
  };

  test.each(Object.entries(QUERIES))(
    "%s never applies COLLATE to a column position",
    (_, text) => {
      for (const item of orderByItems(text)) {
        expect(item).not.toMatch(/^\d+\s+COLLATE\b/i);
      }
    },
  );

  test.each(Object.entries(QUERIES))(
    "%s applies COLLATE only to an expression cast to text",
    (_, text) => {
      for (const item of orderByItems(text)) {
        if (/\bCOLLATE\b/i.test(item)) {
          expect(item).toMatch(/^[a-z_][a-z0-9_.]*::text COLLATE "C"$/);
        }
      }
    },
  );

  test("the queries that sort names do so in byte order", () => {
    for (const name of [
      "schemas",
      "tables",
      "constraints",
      "indexes",
    ] as const) {
      expect(orderByItems(QUERIES[name]).length).toBeGreaterThan(0);
      for (const item of orderByItems(QUERIES[name])) {
        expect(item).toMatch(/::text COLLATE "C"$/);
      }
    }
  });

  test("the schemas query, which runs right after the label check, sorts by nspname", () => {
    expect(orderByItems(QUERIES.schemas)).toEqual([
      'nspname::text COLLATE "C"',
    ]);
  });
});

// Regression (Step 4C-3A): on PostgreSQL 18, pg_constraint also holds one
// NOT NULL row (contype 'n') per column, so the catalog returns 22 rows, not
// the 8 approved constraints. compareConstraints is the exact logic the post
// check and the diagnostic use.
describe("compareConstraints", () => {
  const rows = POST.constraints as Rows as ConstraintRow[];

  test("accepts the PostgreSQL 18 catalog: 8 approved constraints plus 14 NOT NULL", () => {
    expect(rows).toHaveLength(22);
    const result = compareConstraints(rows);
    expect(result.approved).toBe(true);
    expect(result.notNull).toBe(true);
    expect(result.entries.map((e) => e.status)).toEqual(
      Array(22).fill("expected"),
    );
  });

  test("the approved check is unchanged: the 8 rows alone still pass it", () => {
    const approvedOnly = rows.filter((row) => row.type !== "n");
    expect(approvedOnly).toHaveLength(8);
    expect(compareConstraints(approvedOnly).approved).toBe(true);
    expect(compareConstraints(approvedOnly).notNull).toBe(false);
  });

  test("an extra CHECK constraint fails the approved check and is listed as unexpected", () => {
    const result = compareConstraints([
      ...rows,
      {
        table_name: "projects",
        name: "projects_zz_check",
        type: "c",
        definition: "CHECK (true)",
        column_name: null,
      },
    ]);
    expect(result.approved).toBe(false);
    expect(
      result.entries.find((e) => e.name === "projects_zz_check")?.status,
    ).toBe("unexpected");
  });

  test("a changed definition is a mismatch", () => {
    const result = compareConstraints(
      rows.map((row) =>
        row.name === "specifications_project_id_fkey"
          ? {
              ...row,
              definition:
                "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE",
            }
          : row,
      ),
    );
    expect(result.approved).toBe(false);
    expect(
      result.entries.find((e) => e.name === "specifications_project_id_fkey")
        ?.status,
    ).toBe("mismatch");
  });

  test("a wrong constraint type is a mismatch", () => {
    const result = compareConstraints(
      rows.map((row) =>
        row.name === "projects_slug_unique" ? { ...row, type: "x" } : row,
      ),
    );
    expect(result.approved).toBe(false);
    expect(
      result.entries.find((e) => e.name === "projects_slug_unique")?.status,
    ).toBe("mismatch");
  });

  test("missing constraints are listed", () => {
    const result = compareConstraints(
      rows.filter(
        (row) =>
          row.name !== "projects_pkey" && row.name !== "projects_slug_not_null",
      ),
    );
    expect(result.approved).toBe(false);
    expect(result.notNull).toBe(false);
    expect(
      result.entries
        .filter((e) => e.status === "missing")
        .map((e) => `${e.table}.${e.name}`),
    ).toEqual(["projects.projects_pkey", "projects.NOT NULL slug"]);
  });

  test("a duplicated NOT NULL row fails", () => {
    const duplicate = rows.find((row) => row.name === "projects_name_not_null");
    expect(
      compareConstraints([
        ...rows,
        { ...duplicate, name: "projects_name_not_null1" },
      ]).notNull,
    ).toBe(false);
  });

  test("a NOT NULL row whose column can't be resolved fails", () => {
    expect(
      compareConstraints(
        rows.map((row) =>
          row.name === "projects_id_not_null"
            ? { ...row, column_name: null }
            : row,
        ),
      ).notNull,
    ).toBe(false);
  });

  test("the approved order still matters", () => {
    const approved = rows.filter((row) => row.type !== "n");
    expect(compareConstraints([...approved].reverse()).approved).toBe(false);
  });
});

describe("the constraints diagnostic", () => {
  test("lists every stored constraint with its definition, then both verdicts", async () => {
    const { results, output, state } = await run("constraints", POST);
    expect(failed(results)).toEqual([]);
    const lines = results.filter((r) => r.label.startsWith("constraint "));
    expect(lines).toHaveLength(22);
    expect(output).toMatch(/ALL 43 CHECKS PASSED$/);
    expect(lines[0]).toEqual({
      pass: true,
      label: "constraint projects.projects_created_at_not_null [n]: expected",
      detail: "NOT NULL created_at",
    });
    expect(output).toContain(
      "PASS  constraint specifications.specifications_project_id_fkey [f]: expected\n      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT",
    );
    expect(output).toContain(
      "PASS  constraints: exactly one NOT NULL constraint for each of the 14 columns",
    );
    expect(state.calls[0]?.text).toBe("BEGIN TRANSACTION READ ONLY");
    expect(state.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(state.ended).toBe(true);
    expect(
      state.calls.some(
        (c) => c.text === QUERIES.journal || c.text === QUERIES.grants,
      ),
    ).toBe(false);
    expectNoSecrets(output);
  });

  test("marks mismatched, unexpected, and missing constraints as FAIL", async () => {
    const stored = (POST.constraints as Rows)
      .filter((row) => row.name !== "specifications_key_unique")
      .map((row) =>
        row.name === "specifications_status_check"
          ? { ...row, definition: "CHECK (true)" }
          : row,
      );
    stored.push({
      table_name: "projects",
      name: "projects_zz_check",
      type: "c",
      definition: "CHECK (false)",
      column_name: null,
    });
    const { results } = await run("constraints", {
      ...POST,
      constraints: stored,
    });
    expect(results.filter((r) => !r.pass)).toEqual([
      {
        pass: false,
        label:
          "constraint specifications.specifications_status_check [c]: mismatch",
        detail: "CHECK (true)",
      },
      {
        pass: false,
        label: "constraint projects.projects_zz_check [c]: unexpected",
        detail: "CHECK (false)",
      },
      {
        pass: false,
        label:
          "constraint specifications.specifications_key_unique [u]: missing",
      },
      {
        pass: false,
        label:
          "constraints: primary keys, UNIQUE, CHECK, and the RESTRICT foreign key as reviewed",
      },
    ]);
  });

  test("still fails closed before connecting", async () => {
    const { state, results } = await run("constraints", POST, {
      env: { ...ENV, PGHOST: "FakeHost" },
    });
    expect(state.created).toBe(0);
    expect(failed(results)).toContain(
      "connection skipped (a check above failed)",
    );
  });
});

// Regression (Step 5B-1): the development profile's results, captured from
// the code before the profile refactor, must stay exactly the same: every
// label, detail, and pass/fail, in order.
describe("the development profile is unchanged", () => {
  const baseline = JSON.parse(
    readFileSync(
      new URL("./fixtures/development-profile-output.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, CheckResult[]>;

  test.each([
    ["pre", () => run("pre", PRE)],
    ["post", () => run("post", POST)],
    ["constraints", () => run("constraints", POST)],
    [
      "pre-failing",
      () =>
        run("pre", {
          ...PRE,
          regex: regexRows([10, 22]),
          sessions: [{ other_migrator_sessions: 1 }],
        }),
    ],
    ["closed", () => run("pre", PRE, { env: { ...ENV, PGHOST: "x" } })],
  ] as const)("%s", async (name, execute) => {
    const { results } = await execute();
    expect(results).toEqual(baseline[name]);
  });

  test("the baseline has the approved counts", () => {
    expect(baseline.pre).toHaveLength(27);
    expect(baseline.post).toHaveLength(30);
    expect(baseline.constraints).toHaveLength(43);
  });
});
