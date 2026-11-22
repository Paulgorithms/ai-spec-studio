import { readFileSync } from "node:fs";
import type { Pool, PoolConfig } from "pg";
import { describe, expect, test } from "vitest";
import {
  PROJECT_SLUG_PATTERN,
  SPECIFICATION_KEY_PATTERN,
} from "../../../src/lib/db/schema";
import {
  DEV_APPLIED,
  DEV_FRESH,
  DEV_PARTIAL,
  FILES,
  journalRows,
  pg18Constraints,
  regexRows,
  type Answers,
  type Rows,
} from "./fixtures/test-database-answers";
import { formatResults, type CheckResult } from "./live-verification";
import {
  APPROVED_MIGRATIONS,
  compareConstraints,
  expectedStructure,
  QUERIES,
  REGEX_CASES,
  runMigrationChecks,
  type ConstraintRow,
  type MigrationFiles,
  type Phase,
} from "./migration-checks";

// A fake pg pool, as in live-verification.test.ts: no sockets; queries are
// answered by the /* name */ comment that starts each one.
const PASSWORD = "FakeMigrator:p@ss/word";
const MIGRATION_URL = `postgresql://ai_spec_studio_migrator:${encodeURIComponent(PASSWORD)}@127.0.0.1:5432/ai_spec_studio_dev`;
const ENV = {
  DATABASE_MIGRATION_URL: MIGRATION_URL,
  DATABASE_SSL_MODE: "disable",
};
const [M0, M1] = APPROVED_MIGRATIONS;
if (!M0 || !M1) throw new Error("two approved migrations expected");

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

const UNEXPECTED =
  "state: neither fresh nor exactly the first approved migrations, in order";
const READY_FROM_PARTIAL =
  "state: ready to apply 0001_auth_tables (0000_initial_schema applied exactly)";

describe("the pre phase", () => {
  test("passes on a fresh database, read-only, and closes the pool", async () => {
    const { state, results, output } = await run("pre", DEV_FRESH);
    expect(failed(results)).toEqual([]);
    expect(output).toContain(
      "PASS  state: ready to apply 0000_initial_schema, 0001_auth_tables",
    );
    expect(output).toMatch(/ALL 32 CHECKS PASSED$/);
    expect(state.created).toBe(1);
    expect(state.released && state.ended).toBe(true);
    expect(state.calls[0]?.text).toBe("BEGIN TRANSACTION READ ONLY");
    expect(state.calls.at(-1)?.text).toBe("ROLLBACK");
    for (const call of state.calls.slice(1, -1)) {
      expect(call.text).toMatch(/^\/\* \w+ \*\/\nSELECT /);
    }
    // A fresh database has no journal to read.
    expect(state.calls.some((c) => c.text === QUERIES.journal)).toBe(false);
    expectNoSecrets(output);
  });

  test("passes with exactly 0000_initial_schema applied (the development database today)", async () => {
    const { state, results, output } = await run("pre", DEV_PARTIAL);
    expect(failed(results)).toEqual([]);
    expect(output).toContain(`PASS  ${READY_FROM_PARTIAL}`);
    expect(output).toContain(
      "PASS  tables: exactly projects and specifications in public, owned by ai_spec_studio_migrator, no row-level security",
    );
    expect(output).toContain(
      "PASS  grants: ai_spec_studio_app has exactly SELECT, INSERT, UPDATE, DELETE on all 2 tables",
    );
    expect(output).toMatch(/ALL 42 CHECKS PASSED$/);
    expect(state.calls.find((c) => c.text === QUERIES.grants)?.values).toEqual([
      "ai_spec_studio_app",
      "ai_spec_studio_test",
      ["projects", "specifications"],
    ]);
    expectNoSecrets(output);
  });

  test("fails when every approved migration is already applied", async () => {
    const { results } = await run("pre", DEV_APPLIED);
    expect(failed(results)).toEqual([
      "state: nothing to migrate (every approved migration is already applied); use the post phase",
    ]);
  });

  test("sends the regex cases and the schema's own patterns as parameters", async () => {
    const { state } = await run("pre", DEV_FRESH);
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
      "a journal without the drizzle schema",
      { ...DEV_FRESH, objects: [{ journal: true, public_relations: 0 }] },
      "(NO_DRIZZLE_SCHEMA, JOURNAL, PUBLIC_EMPTY)",
    ],
    [
      "the drizzle schema without a journal",
      { ...DEV_FRESH, schemas: [{ name: "drizzle" }, { name: "public" }] },
      "(DRIZZLE_SCHEMA, NO_JOURNAL, PUBLIC_EMPTY)",
    ],
    [
      "tables without a journal",
      { ...DEV_FRESH, objects: [{ journal: false, public_relations: 8 }] },
      "(NO_DRIZZLE_SCHEMA, NO_JOURNAL, PUBLIC_NOT_EMPTY)",
    ],
    [
      "an empty journal (a failed first migration)",
      { ...DEV_PARTIAL, journal: [] },
      "(DRIZZLE_SCHEMA, JOURNAL, PUBLIC_NOT_EMPTY, JOURNAL_ROWS_0, JOURNAL_EMPTY)",
    ],
    [
      "only 0001 journaled",
      { ...DEV_PARTIAL, journal: journalRows(2).slice(1) },
      "(DRIZZLE_SCHEMA, JOURNAL, PUBLIC_NOT_EMPTY, JOURNAL_ROWS_1, JOURNAL_NOT_APPROVED_PREFIX)",
    ],
    [
      "the two migrations journaled in the wrong order",
      { ...DEV_PARTIAL, journal: [...journalRows(2)].reverse() },
      "(DRIZZLE_SCHEMA, JOURNAL, PUBLIC_NOT_EMPTY, JOURNAL_ROWS_2, JOURNAL_NOT_APPROVED_PREFIX)",
    ],
    [
      "a changed hash",
      {
        ...DEV_PARTIAL,
        journal: [{ hash: "0".repeat(64), created_at: String(M0.when) }],
      },
      "(DRIZZLE_SCHEMA, JOURNAL, PUBLIC_NOT_EMPTY, JOURNAL_ROWS_1, JOURNAL_NOT_APPROVED_PREFIX)",
    ],
    [
      "a changed timestamp",
      {
        ...DEV_PARTIAL,
        journal: [{ hash: M0.sha256, created_at: String(M0.when + 1) }],
      },
      "(DRIZZLE_SCHEMA, JOURNAL, PUBLIC_NOT_EMPTY, JOURNAL_ROWS_1, JOURNAL_NOT_APPROVED_PREFIX)",
    ],
    [
      "a migration journaled twice",
      { ...DEV_PARTIAL, journal: [...journalRows(1), ...journalRows(1)] },
      "(DRIZZLE_SCHEMA, JOURNAL, PUBLIC_NOT_EMPTY, JOURNAL_ROWS_2, JOURNAL_NOT_APPROVED_PREFIX)",
    ],
    [
      "an unknown third migration",
      {
        ...DEV_PARTIAL,
        journal: [
          ...journalRows(2),
          { hash: "f".repeat(64), created_at: String(M1.when + 1) },
        ],
      },
      "(DRIZZLE_SCHEMA, JOURNAL, PUBLIC_NOT_EMPTY, JOURNAL_ROWS_3, JOURNAL_NOT_APPROVED_PREFIX)",
    ],
  ])("refuses %s as unexpected", async (_, answers, detail) => {
    const { results, state } = await run("pre", answers as Answers);
    const result = results.find((r) => r.label === UNEXPECTED);
    expect(result).toEqual({ pass: false, label: UNEXPECTED, detail });
    expect(failed(results)).toContain(UNEXPECTED);
    expect(state.ended).toBe(true);
  });

  const partialTables = DEV_PARTIAL.tables as Rows;
  const partialGrants = DEV_PARTIAL.grants as Rows;
  test.each([
    [
      "the auth tables created without being journaled",
      {
        tables: [
          ...partialTables,
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
      "a table owned by someone else",
      {
        tables: [{ ...partialTables[0], owner: "postgres" }, partialTables[1]],
      },
      "tables: exactly projects and specifications in public, owned by ai_spec_studio_migrator, no row-level security",
    ],
    [
      "a missing app grant",
      {
        grants: [{ ...partialGrants[0], app_delete: false }, partialGrants[1]],
      },
      "grants: ai_spec_studio_app has exactly SELECT, INSERT, UPDATE, DELETE on all 2 tables",
    ],
    [
      "a PUBLIC grant",
      { grants: partialGrants.map((g) => ({ ...g, public_any: true })) },
      "grants: ai_spec_studio_test and PUBLIC have no table privileges",
    ],
    [
      "app access to the journal",
      {
        journal_access: [
          { ...(DEV_PARTIAL.journal_access as Rows)[0], app_usage: true },
        ],
      },
      "journal: the app and test roles can't use the drizzle schema; the app can't create in public",
    ],
  ])(
    "refuses a partially migrated database with %s",
    async (_, change, label) => {
      const { results } = await run("pre", {
        ...DEV_PARTIAL,
        ...(change as Answers),
      });
      expect(results.find((r) => r.label === READY_FROM_PARTIAL)).toEqual({
        pass: false,
        label: READY_FROM_PARTIAL,
        detail: "(see the failures above)",
      });
      expect(failed(results)).toEqual([label, READY_FROM_PARTIAL]);
    },
  );

  test.each([
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
        session: [
          { ...(DEV_FRESH.session as Rows)[0], search_path: "app, public" },
        ],
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
      {
        session: [{ ...(DEV_FRESH.session as Rows)[0], auth_identity: null }],
      },
      "session: authenticated with SCRAM-SHA-256",
    ],
    [
      "PostgreSQL 17",
      {
        session: [{ ...(DEV_FRESH.session as Rows)[0], version_num: 170005 }],
      },
      "server: PostgreSQL 18",
    ],
    [
      "another port",
      { session: [{ ...(DEV_FRESH.session as Rows)[0], server_port: 5433 }] },
      "server: loopback endpoint, port 5432",
    ],
    [
      "a missing label",
      { label: [] },
      "database: labeled app.environment=development",
    ],
    [
      "a superuser migrator",
      { role: [{ ...(DEV_FRESH.role as Rows)[0], rolsuper: true }] },
      "role: no superuser, CREATEROLE, CREATEDB, REPLICATION, or BYPASSRLS",
    ],
  ])("fails when %s", async (_, override, label) => {
    for (const base of [DEV_FRESH, DEV_PARTIAL]) {
      const changed = { ...base, ...(override as Answers) };
      // A schema list that doesn't match the state also fails the schema
      // check for a partially migrated database.
      if ("schemas" in (override as Answers) && base === DEV_PARTIAL) continue;
      const { results, state } = await run("pre", changed);
      expect(failed(results)).toEqual([label].flat());
      expect(state.ended).toBe(true);
    }
  });

  test("names the regex cases PostgreSQL evaluates differently, by number", async () => {
    const { results } = await run("pre", {
      ...DEV_FRESH,
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
  const entries = FILES.journal.entries;
  const filesWith = (change: Partial<MigrationFiles>): MigrationFiles => ({
    ...FILES,
    ...change,
  });
  const JOURNAL_LABEL =
    "files: the journal lists exactly 0000_initial_schema, 0001_auth_tables, in that order, with the reviewed timestamps";
  const LISTING_LABEL =
    "files: drizzle/ holds exactly the 2 approved migrations, their snapshots, and the journal";
  const CHAIN_LABEL =
    "files: the snapshots form one chain (each prevId is the previous snapshot's id)";
  const ORDER_LABEL =
    "files: journal timestamps strictly increase (the migrator relies on it)";

  test.each([
    [
      "a changed 0000 migration",
      filesWith({
        sha256: { ...FILES.sha256, "0000_initial_schema.sql": "0".repeat(64) },
      }),
      ["files: 0000_initial_schema.sql matches the reviewed SHA-256"],
    ],
    [
      "a changed 0001 migration",
      filesWith({
        sha256: { ...FILES.sha256, "0001_auth_tables.sql": "0".repeat(64) },
      }),
      ["files: 0001_auth_tables.sql matches the reviewed SHA-256"],
    ],
    [
      "a changed snapshot",
      filesWith({
        sha256: { ...FILES.sha256, "meta/0001_snapshot.json": "0".repeat(64) },
      }),
      ["files: meta/0001_snapshot.json matches the reviewed SHA-256"],
    ],
    [
      "a missing 0001 (journal, SQL, and snapshot)",
      filesWith({
        listing: FILES.listing.filter(
          (p) => !p.startsWith("0001") && p !== "meta/0001_snapshot.json",
        ),
        journal: { ...FILES.journal, entries: entries.slice(0, 1) },
        sha256: {
          "0000_initial_schema.sql": M0.sha256,
          "meta/0000_snapshot.json": M0.snapshot.sha256,
        },
        snapshots: {
          "meta/0000_snapshot.json": {
            id: M0.snapshot.id,
            prevId: M0.snapshot.prevId,
          },
        },
      }),
      [
        LISTING_LABEL,
        JOURNAL_LABEL,
        "files: 0001_auth_tables.sql matches the reviewed SHA-256",
        "files: meta/0001_snapshot.json matches the reviewed SHA-256",
        CHAIN_LABEL,
      ],
    ],
    [
      "an extra SQL file",
      filesWith({ listing: [...FILES.listing, "0002_extra.sql"].sort() }),
      [LISTING_LABEL],
    ],
    [
      "a symbolic link in drizzle/",
      filesWith({ listing: [...FILES.listing, "0002_extra.sql@"].sort() }),
      [LISTING_LABEL],
    ],
    [
      "a third journal entry",
      filesWith({
        journal: {
          ...FILES.journal,
          entries: [
            ...entries,
            {
              idx: 2,
              version: "7",
              when: M1.when + 1,
              tag: "0002_extra",
              breakpoints: true,
            },
          ],
        },
      }),
      [JOURNAL_LABEL],
    ],
    [
      "reordered journal entries",
      filesWith({
        journal: { ...FILES.journal, entries: [...entries].reverse() },
      }),
      [JOURNAL_LABEL, ORDER_LABEL],
    ],
    [
      "a changed journal timestamp",
      filesWith({
        journal: {
          ...FILES.journal,
          entries: [entries[0]!, { ...entries[1]!, when: M0.when - 1 }],
        },
      }),
      [JOURNAL_LABEL, ORDER_LABEL],
    ],
    [
      "journal entries without breakpoints",
      filesWith({
        journal: {
          ...FILES.journal,
          entries: entries.map((e) => ({ ...e, breakpoints: false })),
        },
      }),
      [JOURNAL_LABEL],
    ],
    [
      "a broken snapshot chain",
      filesWith({
        snapshots: {
          ...FILES.snapshots,
          "meta/0001_snapshot.json": {
            id: M1.snapshot.id,
            prevId: "00000000-0000-0000-0000-000000000000",
          },
        },
      }),
      [CHAIN_LABEL],
    ],
  ])("never creates a pool for %s", async (_, files, labels) => {
    for (const phase of ["pre", "post", "constraints"] as const) {
      const { state, results } = await run(
        phase,
        phase === "pre" ? DEV_FRESH : DEV_APPLIED,
        { files },
      );
      expect(state.created).toBe(0);
      expect(failed(results)).toEqual([
        ...labels,
        "connection skipped (a check above failed)",
      ]);
    }
  });

  test.each([
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
        phase === "pre" ? DEV_FRESH : DEV_APPLIED,
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
  test("passes with every approved migration applied as reviewed", async () => {
    const { results, output, state } = await run("post", DEV_APPLIED);
    expect(failed(results)).toEqual([]);
    expect(output).toContain(
      "PASS  tables: exactly accounts, projects, sessions, specifications, users, and verifications in public, owned by ai_spec_studio_migrator, no row-level security",
    );
    expect(output).toContain(
      "PASS  journal: exactly 2 applied migrations, in order, with the reviewed hashes and timestamps (0000_initial_schema, 0001_auth_tables)",
    );
    expect(output).toContain(
      "PASS  constraints: exactly the 18 reviewed primary key, UNIQUE, CHECK, and foreign key constraints",
    );
    expect(output).toContain(
      "PASS  constraints: exactly one NOT NULL constraint for each of the 38 NOT NULL columns",
    );
    expect(output).toContain(
      "PASS  indexes: exactly the 16 reviewed indexes, with updated_at DESC",
    );
    expect(output).toMatch(/ALL 36 CHECKS PASSED$/);
    expect(state.calls.find((c) => c.text === QUERIES.grants)?.values).toEqual([
      "ai_spec_studio_app",
      "ai_spec_studio_test",
      [
        "accounts",
        "projects",
        "sessions",
        "specifications",
        "users",
        "verifications",
      ],
    ]);
    expectNoSecrets(output);
  });

  test.each([
    [
      "only 0000_initial_schema applied",
      DEV_PARTIAL,
      "(pending: 0001_auth_tables)",
    ],
    ["a fresh database", DEV_FRESH, "(FRESH)"],
    [
      "an unexpected journal",
      { ...DEV_APPLIED, journal: [...journalRows(2)].reverse() },
      "(DRIZZLE_SCHEMA, JOURNAL, PUBLIC_NOT_EMPTY, JOURNAL_ROWS_2, JOURNAL_NOT_APPROVED_PREFIX)",
    ],
  ])("fails for %s", async (_, answers, detail) => {
    const { results } = await run("post", answers as Answers);
    expect(
      results.find((r) => r.label.startsWith("state: every approved")),
    ).toEqual({
      pass: false,
      label:
        "state: every approved migration is applied (0000_initial_schema, 0001_auth_tables)",
      detail,
    });
  });

  const tables = DEV_APPLIED.tables as Rows;
  const columns = DEV_APPLIED.columns as Rows;
  const constraints = DEV_APPLIED.constraints as Rows;
  const indexes = DEV_APPLIED.indexes as Rows;
  const grants = DEV_APPLIED.grants as Rows;
  const access = (DEV_APPLIED.journal_access as Rows)[0];
  const TABLES_LABEL =
    "tables: exactly accounts, projects, sessions, specifications, users, and verifications in public, owned by ai_spec_studio_migrator, no row-level security";
  const COLUMNS_LABEL =
    "columns: names, order, types, nullability, and defaults of the 48 reviewed columns";
  const CONSTRAINTS_LABEL =
    "constraints: exactly the 18 reviewed primary key, UNIQUE, CHECK, and foreign key constraints";
  const NOT_NULL_LABEL =
    "constraints: exactly one NOT NULL constraint for each of the 38 NOT NULL columns";
  const INDEXES_LABEL =
    "indexes: exactly the 16 reviewed indexes, with updated_at DESC";
  const APP_GRANTS_LABEL =
    "grants: ai_spec_studio_app has exactly SELECT, INSERT, UPDATE, DELETE on all 6 tables";
  const withDefinition = (name: string, definition: string) =>
    constraints.map((c) => (c.name === name ? { ...c, definition } : c));

  test.each([
    [
      "a table owned by someone else",
      {
        tables: tables.map((t) =>
          t.name === "sessions" ? { ...t, owner: "postgres" } : t,
        ),
      },
      TABLES_LABEL,
    ],
    [
      "row-level security on users",
      {
        tables: tables.map((t) =>
          t.name === "users" ? { ...t, rls: true } : t,
        ),
      },
      TABLES_LABEL,
    ],
    [
      "an extra table",
      {
        tables: [
          ...tables,
          {
            name: "zz_extra",
            kind: "r",
            owner: "ai_spec_studio_migrator",
            rls: false,
          },
        ],
      },
      TABLES_LABEL,
    ],
    [
      "a missing table",
      { tables: tables.filter((t) => t.name !== "verifications") },
      TABLES_LABEL,
    ],
    [
      "a changed default",
      {
        columns: columns.map((c) =>
          c.column_name === "status" ? { ...c, default_value: null } : c,
        ),
      },
      COLUMNS_LABEL,
    ],
    [
      "email_verified defaulting to true",
      {
        columns: columns.map((c) =>
          c.column_name === "email_verified"
            ? { ...c, default_value: "true" }
            : c,
        ),
      },
      COLUMNS_LABEL,
    ],
    [
      "a NOT NULL ip_address",
      {
        columns: columns.map((c) =>
          c.column_name === "ip_address" ? { ...c, nullable: "NO" } : c,
        ),
      },
      COLUMNS_LABEL,
    ],
    [
      "a text user_id",
      {
        columns: columns.map((c) =>
          c.table_name === "sessions" && c.column_name === "user_id"
            ? { ...c, type: "text" }
            : c,
        ),
      },
      COLUMNS_LABEL,
    ],
    [
      "a timestamp without time zone",
      {
        columns: columns.map((c) =>
          c.table_name === "sessions" && c.column_name === "expires_at"
            ? { ...c, type: "timestamp(3) without time zone" }
            : c,
        ),
      },
      COLUMNS_LABEL,
    ],
    [
      "a CASCADE foreign key on specifications",
      {
        constraints: withDefinition(
          "specifications_project_id_fkey",
          "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE",
        ),
      },
      CONSTRAINTS_LABEL,
    ],
    [
      "a RESTRICT foreign key on sessions",
      {
        constraints: withDefinition(
          "sessions_user_id_fkey",
          "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT",
        ),
      },
      CONSTRAINTS_LABEL,
    ],
    [
      "ON UPDATE CASCADE on accounts",
      {
        constraints: withDefinition(
          "accounts_user_id_fkey",
          "FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE",
        ),
      },
      CONSTRAINTS_LABEL,
    ],
    [
      "a deferrable foreign key",
      {
        constraints: withDefinition(
          "accounts_user_id_fkey",
          "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE DEFERRABLE",
        ),
      },
      CONSTRAINTS_LABEL,
    ],
    [
      "a weakened password CHECK",
      {
        constraints: withDefinition(
          "accounts_password_null_check",
          "CHECK (((password IS NULL) OR true))",
        ),
      },
      CONSTRAINTS_LABEL,
    ],
    [
      "a NOT VALID password CHECK",
      {
        constraints: withDefinition(
          "accounts_password_null_check",
          "CHECK ((password IS NULL)) NOT VALID",
        ),
      },
      CONSTRAINTS_LABEL,
    ],
    [
      "a missing password CHECK",
      {
        constraints: constraints.filter(
          (c) => c.name !== "accounts_password_null_check",
        ),
      },
      CONSTRAINTS_LABEL,
    ],
    [
      "a provider allowlist CHECK (rejected in the design)",
      {
        constraints: pg18Constraints()
          .concat({
            table_name: "accounts",
            name: "accounts_provider_id_check",
            type: "c",
            definition:
              "CHECK ((provider_id = ANY (ARRAY['github'::text, 'google'::text])))",
            column_name: null,
          })
          .sort((a, b) =>
            `${a.table_name}\u0000${a.name}` < `${b.table_name}\u0000${b.name}`
              ? -1
              : 1,
          ),
      },
      CONSTRAINTS_LABEL,
    ],
    [
      "a case-insensitive email UNIQUE instead of the plain one",
      {
        constraints: constraints.filter((c) => c.name !== "users_email_unique"),
      },
      CONSTRAINTS_LABEL,
    ],
    [
      "a reversed (account_id, provider_id) UNIQUE",
      {
        constraints: withDefinition(
          "accounts_provider_id_account_id_unique",
          "UNIQUE (account_id, provider_id)",
        ),
      },
      CONSTRAINTS_LABEL,
    ],
    [
      "UNIQUE NULLS NOT DISTINCT on the session token",
      {
        constraints: withDefinition(
          "sessions_token_unique",
          "UNIQUE NULLS NOT DISTINCT (token)",
        ),
      },
      CONSTRAINTS_LABEL,
    ],
    [
      "a missing NOT NULL constraint",
      {
        constraints: constraints.filter(
          (c) => c.name !== "sessions_token_not_null",
        ),
      },
      NOT_NULL_LABEL,
    ],
    [
      "no NOT NULL rows (the pre-18 catalog shape)",
      { constraints: constraints.filter((c) => c.type !== "n") },
      NOT_NULL_LABEL,
    ],
    [
      "a NOT NULL constraint on a nullable column",
      {
        constraints: [
          ...constraints,
          {
            table_name: "accounts",
            name: "accounts_password_not_null",
            type: "n",
            definition: "NOT NULL password",
            column_name: "password",
          },
        ],
      },
      NOT_NULL_LABEL,
    ],
    [
      "an ascending specifications index",
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
      INDEXES_LABEL,
    ],
    [
      "a hash index on sessions.user_id",
      {
        indexes: indexes.map((x) =>
          x.name === "sessions_user_id_idx"
            ? {
                ...x,
                definition:
                  "CREATE INDEX sessions_user_id_idx ON public.sessions USING hash (user_id)",
              }
            : x,
        ),
      },
      INDEXES_LABEL,
    ],
    [
      "a partial index on verifications",
      {
        indexes: indexes.map((x) =>
          x.name === "verifications_identifier_idx"
            ? {
                ...x,
                definition: `${x.definition as string} WHERE (expires_at > now())`,
              }
            : x,
        ),
      },
      INDEXES_LABEL,
    ],
    [
      "a missing index",
      { indexes: indexes.filter((x) => x.name !== "accounts_user_id_idx") },
      INDEXES_LABEL,
    ],
    [
      "a trigger",
      { extras: [{ triggers: 1, functions: 1 }] },
      "objects: no triggers or functions in public or drizzle",
    ],
    [
      "TRUNCATE for the app",
      { grants: grants.map((g) => ({ ...g, app_other: true })) },
      APP_GRANTS_LABEL,
    ],
    [
      "a missing app grant on sessions",
      {
        grants: grants.map((g) =>
          g.table_name === "sessions" ? { ...g, app_update: false } : g,
        ),
      },
      APP_GRANTS_LABEL,
    ],
    [
      "a table missing from the grants (to_regclass found nothing)",
      {
        grants: grants.map((g) =>
          g.table_name === "accounts"
            ? {
                ...g,
                app_select: null,
                app_insert: null,
                app_update: null,
                app_delete: null,
                app_other: null,
                test_any: null,
                public_any: null,
              }
            : g,
        ),
      },
      [
        APP_GRANTS_LABEL,
        "grants: ai_spec_studio_test and PUBLIC have no table privileges",
      ],
    ],
    [
      "a test-role grant on users",
      {
        grants: grants.map((g) =>
          g.table_name === "users" ? { ...g, test_any: true } : g,
        ),
      },
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
  ])("fails on %s", async (_, override, label) => {
    const { results } = await run("post", {
      ...DEV_APPLIED,
      ...(override as Answers),
    });
    expect(failed(results)).toEqual([label].flat());
  });

  test("a missing drizzle schema makes the state unexpected", async () => {
    const { results } = await run("post", {
      ...DEV_APPLIED,
      schemas: [{ name: "public" }],
    });
    expect(failed(results)).toEqual([
      "database: the only non-system schemas are drizzle and public",
      "state: every approved migration is applied (0000_initial_schema, 0001_auth_tables)",
    ]);
  });

  test("a failing journal query is reported by SQLSTATE, and the pool still closes", async () => {
    const { results, state, output } = await run("post", {
      ...DEV_APPLIED,
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
    const { results, state, output } = await run("pre", DEV_FRESH, {
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

  test("the grants query takes the table names as a parameter, never in its text", () => {
    expect(QUERIES.grants).toContain("unnest($3::text[])");
    for (const table of expectedStructure(2).tables) {
      expect(QUERIES.grants).not.toContain(table);
    }
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
      "grants",
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
// NOT NULL row (contype 'n') per NOT NULL column. compareConstraints is the
// exact logic the post check and the diagnostic use.
describe("compareConstraints", () => {
  const rows = DEV_APPLIED.constraints as Rows as ConstraintRow[];

  test("accepts the PostgreSQL 18 catalog: 18 approved constraints plus 38 NOT NULL", () => {
    expect(rows).toHaveLength(56);
    const result = compareConstraints(rows);
    expect(result.approved).toBe(true);
    expect(result.notNull).toBe(true);
    expect(result.entries.map((e) => e.status)).toEqual(
      Array(56).fill("expected"),
    );
  });

  test("after 0000 only, the original rules apply unchanged: 8 constraints plus 14 NOT NULL", () => {
    const initial = pg18Constraints(1) as ConstraintRow[];
    expect(initial).toHaveLength(22);
    const result = compareConstraints(initial, expectedStructure(1));
    expect(result.approved && result.notNull).toBe(true);
    // ...and the full list rejects that catalog: the auth tables are missing.
    expect(compareConstraints(initial).approved).toBe(false);
  });

  test("the approved check alone: the 18 rows still pass it", () => {
    const approvedOnly = rows.filter((row) => row.type !== "n");
    expect(approvedOnly).toHaveLength(18);
    expect(compareConstraints(approvedOnly).approved).toBe(true);
    expect(compareConstraints(approvedOnly).notNull).toBe(false);
  });

  test("an extra CHECK constraint fails the approved check and is listed as unexpected", () => {
    const result = compareConstraints([
      ...rows,
      {
        table_name: "users",
        name: "users_zz_check",
        type: "c",
        definition: "CHECK (true)",
        column_name: null,
      },
    ]);
    expect(result.approved).toBe(false);
    expect(
      result.entries.find((e) => e.name === "users_zz_check")?.status,
    ).toBe("unexpected");
  });

  test.each([
    [
      "specifications_project_id_fkey",
      "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE",
    ],
    [
      "sessions_user_id_fkey",
      "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL",
    ],
    ["accounts_password_null_check", "CHECK ((password IS NOT NULL))"],
  ])("a changed definition of %s is a mismatch", (name, definition) => {
    const result = compareConstraints(
      rows.map((row) => (row.name === name ? { ...row, definition } : row)),
    );
    expect(result.approved).toBe(false);
    expect(result.entries.find((e) => e.name === name)?.status).toBe(
      "mismatch",
    );
  });

  test("a wrong constraint type is a mismatch", () => {
    const result = compareConstraints(
      rows.map((row) =>
        row.name === "users_email_unique" ? { ...row, type: "x" } : row,
      ),
    );
    expect(result.approved).toBe(false);
    expect(
      result.entries.find((e) => e.name === "users_email_unique")?.status,
    ).toBe("mismatch");
  });

  test("missing constraints are listed", () => {
    const result = compareConstraints(
      rows.filter(
        (row) =>
          row.name !== "projects_pkey" &&
          row.name !== "projects_slug_not_null" &&
          row.name !== "sessions_token_unique",
      ),
    );
    expect(result.approved).toBe(false);
    expect(result.notNull).toBe(false);
    expect(
      result.entries
        .filter((e) => e.status === "missing")
        .map((e) => `${e.table}.${e.name}`),
    ).toEqual([
      "projects.projects_pkey",
      "sessions.sessions_token_unique",
      "projects.NOT NULL slug",
    ]);
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
          row.name === "users_id_not_null"
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
    const { results, output, state } = await run("constraints", DEV_APPLIED);
    expect(failed(results)).toEqual([]);
    const lines = results.filter((r) => r.label.startsWith("constraint "));
    expect(lines).toHaveLength(56);
    expect(output).toMatch(/ALL 83 CHECKS PASSED$/);
    expect(lines[0]).toEqual({
      pass: true,
      label: "constraint accounts.accounts_account_id_not_null [n]: expected",
      detail: "NOT NULL account_id",
    });
    expect(output).toContain(
      "PASS  constraint specifications.specifications_project_id_fkey [f]: expected\n      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT",
    );
    expect(output).toContain(
      "PASS  constraint accounts.accounts_user_id_fkey [f]: expected\n      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
    );
    expect(output).toContain(
      "PASS  constraints: exactly one NOT NULL constraint for each of the 38 NOT NULL columns",
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
    const stored = (DEV_APPLIED.constraints as Rows)
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
      ...DEV_APPLIED,
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
          "constraints: exactly the 18 reviewed primary key, UNIQUE, CHECK, and foreign key constraints",
      },
    ]);
  });

  test("still fails closed before connecting", async () => {
    const { state, results } = await run("constraints", DEV_APPLIED, {
      env: { ...ENV, PGHOST: "FakeHost" },
    });
    expect(state.created).toBe(0);
    expect(failed(results)).toContain(
      "connection skipped (a check above failed)",
    );
  });
});

// Regression baseline: the development checks' results, label by label, in
// order. Re-captured in Task 1.2.3 Phase 3D, when the checks moved from one
// migration to the ordered list of approved migrations (the Step 5B-1
// baseline it replaces covered 0000_initial_schema alone). A change to any
// label, detail, or verdict must be deliberate and reviewed.
describe("the development profile is unchanged", () => {
  const baseline = JSON.parse(
    readFileSync(
      new URL("./fixtures/development-profile-output.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, CheckResult[]>;

  test.each([
    ["pre-fresh", () => run("pre", DEV_FRESH)],
    ["pre-partial", () => run("pre", DEV_PARTIAL)],
    ["post", () => run("post", DEV_APPLIED)],
    ["constraints", () => run("constraints", DEV_APPLIED)],
    [
      "pre-failing",
      () =>
        run("pre", {
          ...DEV_PARTIAL,
          regex: regexRows([10, 22]),
          sessions: [{ other_migrator_sessions: 1 }],
        }),
    ],
    ["closed", () => run("pre", DEV_FRESH, { env: { ...ENV, PGHOST: "x" } })],
  ] as const)("%s", async (name, execute) => {
    const { results } = await execute();
    expect(results).toEqual(baseline[name]);
  });

  test("the baseline has the approved counts", () => {
    expect(baseline["pre-fresh"]).toHaveLength(32);
    expect(baseline["pre-partial"]).toHaveLength(42);
    expect(baseline.post).toHaveLength(36);
    expect(baseline.constraints).toHaveLength(83);
  });
});
