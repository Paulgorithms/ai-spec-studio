// Fake catalog answers for the test database, as PostgreSQL 18 returns them,
// keyed by each query's leading /* name */ comment. Used by the offline tests
// of the test-database migration runner.
import {
  PROJECT_SLUG_PATTERN,
  SPECIFICATION_KEY_PATTERN,
} from "../../../../src/lib/db/schema";
import {
  APPROVED_MIGRATION,
  EXPECTED_COLUMNS,
  EXPECTED_CONSTRAINTS,
  EXPECTED_INDEXES,
  REGEX_CASES,
} from "../migration-checks";

export type Rows = Record<string, unknown>[];
export type Answers = Record<string, Rows | Error>;

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

export function pg18Constraints(): Rows {
  const all = [
    ...EXPECTED_CONSTRAINTS.map(([table_name, name, type]) => ({
      table_name,
      name,
      type,
      definition: DEFS[name],
      column_name: null,
    })),
    ...EXPECTED_COLUMNS.map(([table_name, column]) => ({
      table_name,
      name: `${table_name}_${column}_not_null`,
      type: "n",
      definition: `NOT NULL ${column}`,
      column_name: column,
    })),
  ];
  const key = (row: { table_name: string; name: string }) =>
    `${row.table_name}\u0000${row.name}`;
  return all.sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

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

const COMMON: Answers = {
  session: [SESSION],
  role: [
    {
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
    },
  ],
  label: [{ setconfig: ["app.environment=test"] }],
  memberships: [{ memberships: 0 }],
  privileges: [{ create_db: true, usage_public: true, create_public: true }],
  sessions: [{ other_migrator_sessions: 0 }],
  lock_holders: [{ holders: 0 }],
  lock_holders_while_locked: [{ mine: 1, others: 0 }],
  regex: REGEX_CASES.map((c, i) => ({ i: i + 1, matched: c.matches })),
};

export const FRESH: Answers = {
  ...COMMON,
  objects: [
    {
      projects: false,
      specifications: false,
      journal: false,
      public_relations: 0,
    },
  ],
  schemas: [{ name: "public" }],
};

export const APPLIED: Answers = {
  ...COMMON,
  objects: [
    {
      projects: true,
      specifications: true,
      journal: true,
      public_relations: 8,
    },
  ],
  schemas: [{ name: "drizzle" }, { name: "public" }],
  journal: [{ hash: APPROVED_MIGRATION.sha256, created_at: "1794739919891" }],
  journal_owner: [
    { schema_owner: "ai_spec_studio_test", table_owner: "ai_spec_studio_test" },
  ],
  tables: ["projects", "specifications"].map((name) => ({
    name,
    kind: "r",
    owner: "ai_spec_studio_test",
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
  constraints: pg18Constraints(),
  indexes: EXPECTED_INDEXES.map(([table_name, name, fragment]) => ({
    table_name,
    name,
    definition: `CREATE INDEX ${name} ON public.${table_name} ${fragment}`,
  })),
  extras: [{ triggers: 0, functions: 0 }],
  foreign_grants: ["projects", "specifications"].map((table_name) => ({
    table_name,
    app_any: false,
    migrator_any: false,
    public_any: false,
  })),
  row_counts: [{ projects: 0, specifications: 0 }],
};

// A partial state: the drizzle schema exists but nothing else.
export const PARTIAL: Answers = {
  ...FRESH,
  schemas: [{ name: "drizzle" }, { name: "public" }],
};
