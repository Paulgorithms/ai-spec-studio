// Fake catalog answers, as PostgreSQL 18 returns them, keyed by each query's
// leading /* name */ comment, for any number of applied approved migrations.
// Used by the offline tests of the development checks, the test-database
// preflight and migration runner, and the integration run.
import {
  PROJECT_SLUG_PATTERN,
  SPECIFICATION_KEY_PATTERN,
} from "../../../../src/lib/db/schema";
import {
  APPROVED_MIGRATIONS,
  EXPECTED_LISTING,
  expectedStructure,
  type MigrationFiles,
} from "../approved-migrations";
import { REGEX_CASES } from "../migration-checks";

export type Rows = Record<string, unknown>[];
export type Answers = Record<string, Rows | Error>;

export const TOTAL = APPROVED_MIGRATIONS.length;

// The files exactly as approved (what readMigrationFiles returns for the
// reviewed drizzle/ folder).
export const FILES: MigrationFiles = {
  listing: EXPECTED_LISTING,
  journal: {
    version: "7",
    dialect: "postgresql",
    entries: APPROVED_MIGRATIONS.map((m, idx) => ({
      idx,
      version: "7",
      when: m.when,
      tag: m.tag,
      breakpoints: true,
    })),
  },
  sha256: Object.fromEntries(
    APPROVED_MIGRATIONS.flatMap((m) => [
      [`${m.tag}.sql`, m.sha256],
      [m.snapshot.file, m.snapshot.sha256],
    ]),
  ),
  snapshots: Object.fromEntries(
    APPROVED_MIGRATIONS.map((m) => [
      m.snapshot.file,
      { id: m.snapshot.id, prevId: m.snapshot.prevId },
    ]),
  ),
};

// The full pg_get_constraintdef text of the 0000 constraints, whose reviewed
// rules only require fragments of it.
export const DEFS: Record<string, string> = {
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

// pg_constraint for schema public as PostgreSQL 18 returns it: the approved
// constraints plus one NOT NULL row (contype 'n', named
// <table>_<column>_not_null) per NOT NULL column, sorted by table and name in
// byte order, as QUERIES.constraints sorts them.
export function pg18Constraints(applied = TOTAL): Rows {
  const structure = expectedStructure(applied);
  const all = [
    ...structure.constraints.map(([table_name, name, type, def, match]) => ({
      table_name,
      name,
      type,
      definition: match === "exact" ? def[0] : DEFS[name],
      column_name: null,
    })),
    ...structure.columns
      .filter((column) => column[3] === "NO")
      .map(([table_name, column]) => ({
        table_name,
        name: `${table_name}_${column}_not_null`,
        type: "n",
        definition: `NOT NULL ${column}`,
        column_name: column,
      })),
  ];
  const key = (row: { table_name: string; name: string }) =>
    `${row.table_name}\u0000${row.name}`;
  return all.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export const journalRows = (applied = TOTAL): Rows =>
  APPROVED_MIGRATIONS.slice(0, applied).map((m) => ({
    hash: m.sha256,
    created_at: String(m.when),
  }));

// The structure queries' answers after `applied` migrations, owned by `owner`.
export function structureAnswers(applied: number, owner: string): Answers {
  const structure = expectedStructure(applied);
  return {
    objects: [{ journal: true, public_relations: 4 * structure.tables.length }],
    schemas: [{ name: "drizzle" }, { name: "public" }],
    journal: journalRows(applied),
    tables: structure.tables.map((name) => ({
      name,
      kind: "r",
      owner,
      rls: false,
    })),
    columns: structure.columns.map(
      ([table_name, column_name, type, nullable, default_value]) => ({
        table_name,
        column_name,
        type,
        nullable,
        default_value,
      }),
    ),
    constraints: pg18Constraints(applied),
    indexes: structure.indexes.map(([table_name, name, def, match]) => ({
      table_name,
      name,
      definition:
        match === "exact"
          ? def
          : `CREATE INDEX ${name} ON public.${table_name} ${def}`,
    })),
    extras: [{ triggers: 0, functions: 0 }],
  };
}

export const tablesAfter = (applied = TOTAL) =>
  expectedStructure(applied).tables;

export const rowCounts = (
  applied = TOTAL,
  counts: Record<string, number> = {},
): Rows => [
  Object.fromEntries(tablesAfter(applied).map((t) => [t, counts[t] ?? 0])),
];

export const regexRows = (flip: number[] = []): Rows =>
  REGEX_CASES.map((c, i) => ({
    i: i + 1,
    matched: flip.includes(i + 1) ? !c.matches : c.matches,
  }));

// --- The test database -------------------------------------------------------

export const SESSION = {
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

const ROLE_ROW = {
  rolsuper: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
  rolbypassrls: false,
};

const COMMON: Answers = {
  session: [SESSION],
  role: [ROLE_ROW],
  label: [{ setconfig: ["app.environment=test"] }],
  memberships: [{ memberships: 0 }],
  privileges: [{ create_db: true, usage_public: true, create_public: true }],
  sessions: [{ other_migrator_sessions: 0 }],
  lock_holders: [{ holders: 0 }],
  lock_holders_while_locked: [{ mine: 1, others: 0 }],
  regex: regexRows(),
};

export const FRESH: Answers = {
  ...COMMON,
  objects: [{ journal: false, public_relations: 0 }],
  schemas: [{ name: "public" }],
};

// The test database after the first `applied` approved migrations, exactly.
export function testDatabaseAfter(applied: number): Answers {
  return {
    ...COMMON,
    ...structureAnswers(applied, "ai_spec_studio_test"),
    journal_owner: [
      {
        schema_owner: "ai_spec_studio_test",
        table_owner: "ai_spec_studio_test",
      },
    ],
    foreign_grants: tablesAfter(applied).map((table_name) => ({
      table_name,
      app_any: false,
      migrator_any: false,
      public_any: false,
    })),
    row_counts: rowCounts(applied),
  };
}

// Only 0000_initial_schema applied: a partially migrated database.
export const PARTIAL: Answers = testDatabaseAfter(1);
// Every approved migration applied.
export const APPLIED: Answers = testDatabaseAfter(TOTAL);

// Broken: the drizzle schema exists but nothing else (what a failed first
// migration leaves behind, since the migrator creates it outside its
// transaction).
export const BROKEN: Answers = {
  ...FRESH,
  schemas: [{ name: "drizzle" }, { name: "public" }],
};

// --- The development database ------------------------------------------------

export const DEV_SESSION = {
  ...SESSION,
  current_role_name: "ai_spec_studio_migrator",
  session_role_name: "ai_spec_studio_migrator",
  database_name: "ai_spec_studio_dev",
  auth_identity: "scram-sha-256:ai_spec_studio_migrator",
};

const DEV_COMMON: Answers = {
  session: [DEV_SESSION],
  role: [ROLE_ROW],
  label: [{ setconfig: ["app.environment=development"] }],
  privileges: [{ create_db: true, usage_public: true, create_public: true }],
  sessions: [{ other_migrator_sessions: 0 }],
  regex: regexRows(),
};

export const DEV_FRESH: Answers = {
  ...DEV_COMMON,
  objects: [{ journal: false, public_relations: 0 }],
  schemas: [{ name: "public" }],
};

// The development database after the first `applied` migrations, exactly:
// owned by the migrator, with the app role's grants.
export function developmentAfter(applied: number): Answers {
  return {
    ...DEV_COMMON,
    ...structureAnswers(applied, "ai_spec_studio_migrator"),
    grants: tablesAfter(applied).map((table_name) => ({
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
  };
}

export const DEV_PARTIAL: Answers = developmentAfter(1);
export const DEV_APPLIED: Answers = developmentAfter(TOTAL);
