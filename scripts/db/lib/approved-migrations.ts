// The reviewed migrations, in the order the drizzle-orm migrator applies
// them, and what a database must contain after each one.
//
// Every migration tool here (the development checks, the test-database
// preflight and migration, the integration run) accepts exactly this list:
// the same tags, journal timestamps, and SHA-256 hashes, in this order, with
// nothing missing and nothing extra. A database is either fresh or has
// exactly the first N of them applied, structure included; anything else is
// refused. Adding a migration means reviewing it and adding it here.
//
// Pure: no database access. The file checks read nothing themselves; they
// judge what readMigrationFiles (migration-files.ts) found on disk.
import { PROJECT_SLUG_PATTERN } from "../../../src/lib/db/schema/projects";
import { SPECIFICATION_KEY_PATTERN } from "../../../src/lib/db/schema/specifications";

export type Check = (pass: boolean, label: string, detail?: string) => void;

// [table, column, format_type, nullable, pg_get_expr of the default]
export type ColumnSpec = readonly [
  table: string,
  column: string,
  type: string,
  nullable: "NO" | "YES",
  default_: string | null,
];

// [table, constraint, contype, pg_get_constraintdef, how to compare]:
// "fragments" requires each string to appear in the definition (the rules
// reviewed for 0000, kept as they were); "exact" requires the definition to
// equal the single string.
export type ConstraintSpec = readonly [
  table: string,
  name: string,
  type: string,
  definition: readonly string[],
  match: "fragments" | "exact",
];

// [table, index, pg_indexes.indexdef, how to compare] (as for constraints)
export type IndexSpec = readonly [
  table: string,
  name: string,
  definition: string,
  match: "fragment" | "exact",
];

export type ApprovedMigration = {
  tag: string;
  // The journal's `when`: the drizzle-orm migrator stores it as created_at
  // and applies a migration only when it is later than the last one stored.
  when: number;
  // SHA-256 of the whole SQL file, as the migrator computes it.
  sha256: string;
  snapshot: { file: string; sha256: string; id: string; prevId: string };
  tables: readonly string[];
  columns: readonly ColumnSpec[];
  constraints: readonly ConstraintSpec[];
  indexes: readonly IndexSpec[];
};

export const FIRST_SNAPSHOT_PREV_ID = "00000000-0000-0000-0000-000000000000";

const TIMESTAMP = "timestamp(3) with time zone";
const timestamps = (table: string): ColumnSpec[] => [
  [table, "created_at", TIMESTAMP, "NO", "now()"],
  [table, "updated_at", TIMESTAMP, "NO", "now()"],
];
const uuidKey = (table: string): ColumnSpec => [
  table,
  "id",
  "uuid",
  "NO",
  "gen_random_uuid()",
];
const exact = (
  table: string,
  name: string,
  type: string,
  definition: string,
): ConstraintSpec => [table, name, type, [definition], "exact"];
const exactIndex = (
  table: string,
  name: string,
  definition: string,
): IndexSpec => [table, name, definition, "exact"];

export const APPROVED_MIGRATIONS: readonly ApprovedMigration[] = [
  {
    // Reviewed in Step 4B; applied to the development database then.
    tag: "0000_initial_schema",
    when: 1794739919891,
    sha256: "cb836c11552e8658df70d3366b9a26c4bb8c31e3fc82156a085216eae292eaf3",
    snapshot: {
      file: "meta/0000_snapshot.json",
      sha256:
        "29a486b353e5e25a9e96aa1529602e30b6570da4b52f019da4a87b7428fa47d1",
      id: "7148e79d-db45-40ca-b43b-67b970dbd052",
      prevId: FIRST_SNAPSHOT_PREV_ID,
    },
    tables: ["projects", "specifications"],
    columns: [
      uuidKey("projects"),
      ["projects", "slug", "text", "NO", null],
      ["projects", "name", "text", "NO", null],
      ["projects", "description", "text", "NO", "''::text"],
      ...timestamps("projects"),
      uuidKey("specifications"),
      ["specifications", "project_id", "uuid", "NO", null],
      ["specifications", "key", "text", "NO", null],
      ["specifications", "title", "text", "NO", null],
      ["specifications", "summary", "text", "NO", "''::text"],
      ["specifications", "status", "text", "NO", "'draft'::text"],
      ...timestamps("specifications"),
    ],
    constraints: [
      ["projects", "projects_pkey", "p", ["PRIMARY KEY (id)"], "fragments"],
      [
        "projects",
        "projects_slug_format_check",
        "c",
        [`'${PROJECT_SLUG_PATTERN}'`],
        "fragments",
      ],
      ["projects", "projects_slug_unique", "u", ["UNIQUE (slug)"], "fragments"],
      [
        "specifications",
        "specifications_key_format_check",
        "c",
        [`'${SPECIFICATION_KEY_PATTERN}'`],
        "fragments",
      ],
      [
        "specifications",
        "specifications_key_unique",
        "u",
        ["UNIQUE (key)"],
        "fragments",
      ],
      [
        "specifications",
        "specifications_pkey",
        "p",
        ["PRIMARY KEY (id)"],
        "fragments",
      ],
      [
        "specifications",
        "specifications_project_id_fkey",
        "f",
        ["FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT"],
        "fragments",
      ],
      [
        "specifications",
        "specifications_status_check",
        "c",
        ["'draft'::text", "'in-review'::text", "'approved'::text"],
        "fragments",
      ],
    ],
    indexes: [
      ["projects", "projects_pkey", "USING btree (id)", "fragment"],
      ["projects", "projects_slug_unique", "USING btree (slug)", "fragment"],
      [
        "specifications",
        "specifications_key_unique",
        "USING btree (key)",
        "fragment",
      ],
      ["specifications", "specifications_pkey", "USING btree (id)", "fragment"],
      [
        "specifications",
        "specifications_project_id_idx",
        "USING btree (project_id)",
        "fragment",
      ],
      [
        "specifications",
        "specifications_updated_at_key_idx",
        "USING btree (updated_at DESC NULLS LAST, key)",
        "fragment",
      ],
    ],
  },
  {
    // Reviewed in Task 1.2.3 Phase 3C: the Better Auth tables.
    tag: "0001_auth_tables",
    when: 1795337179333,
    sha256: "75ae637faf83a71863593ffc1e6baba8e96239ee2d6234c9f6bd78fa4179afbb",
    snapshot: {
      file: "meta/0001_snapshot.json",
      sha256:
        "098736ea611ca8c49c6f713a27984c76eea4428f35eb38c9d432aef2b4081100",
      id: "c3e1c26b-19f1-45c8-bff9-c488bb198142",
      prevId: "7148e79d-db45-40ca-b43b-67b970dbd052",
    },
    tables: ["accounts", "sessions", "users", "verifications"],
    columns: [
      uuidKey("accounts"),
      ["accounts", "account_id", "text", "NO", null],
      ["accounts", "provider_id", "text", "NO", null],
      ["accounts", "user_id", "uuid", "NO", null],
      ["accounts", "access_token", "text", "YES", null],
      ["accounts", "refresh_token", "text", "YES", null],
      ["accounts", "id_token", "text", "YES", null],
      ["accounts", "access_token_expires_at", TIMESTAMP, "YES", null],
      ["accounts", "refresh_token_expires_at", TIMESTAMP, "YES", null],
      ["accounts", "scope", "text", "YES", null],
      ["accounts", "password", "text", "YES", null],
      ...timestamps("accounts"),
      uuidKey("sessions"),
      ["sessions", "expires_at", TIMESTAMP, "NO", null],
      ["sessions", "token", "text", "NO", null],
      ["sessions", "ip_address", "text", "YES", null],
      ["sessions", "user_agent", "text", "YES", null],
      ["sessions", "user_id", "uuid", "NO", null],
      ...timestamps("sessions"),
      uuidKey("users"),
      ["users", "name", "text", "NO", null],
      ["users", "email", "text", "NO", null],
      ["users", "email_verified", "boolean", "NO", "false"],
      ["users", "image", "text", "YES", null],
      ...timestamps("users"),
      uuidKey("verifications"),
      ["verifications", "identifier", "text", "NO", null],
      ["verifications", "value", "text", "NO", null],
      ["verifications", "expires_at", TIMESTAMP, "NO", null],
      ...timestamps("verifications"),
    ],
    // pg_get_constraintdef as PostgreSQL prints it with search_path
    // "$user", public (so REFERENCES users, not public.users). ON UPDATE NO
    // ACTION is the default, so it isn't printed.
    constraints: [
      exact("accounts", "accounts_pkey", "p", "PRIMARY KEY (id)"),
      exact(
        "accounts",
        "accounts_password_null_check",
        "c",
        "CHECK ((password IS NULL))",
      ),
      exact(
        "accounts",
        "accounts_provider_id_account_id_unique",
        "u",
        "UNIQUE (provider_id, account_id)",
      ),
      exact(
        "accounts",
        "accounts_user_id_fkey",
        "f",
        "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
      ),
      exact("sessions", "sessions_pkey", "p", "PRIMARY KEY (id)"),
      exact("sessions", "sessions_token_unique", "u", "UNIQUE (token)"),
      exact(
        "sessions",
        "sessions_user_id_fkey",
        "f",
        "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
      ),
      exact("users", "users_email_unique", "u", "UNIQUE (email)"),
      exact("users", "users_pkey", "p", "PRIMARY KEY (id)"),
      exact("verifications", "verifications_pkey", "p", "PRIMARY KEY (id)"),
    ],
    indexes: [
      exactIndex(
        "accounts",
        "accounts_pkey",
        "CREATE UNIQUE INDEX accounts_pkey ON public.accounts USING btree (id)",
      ),
      exactIndex(
        "accounts",
        "accounts_provider_id_account_id_unique",
        "CREATE UNIQUE INDEX accounts_provider_id_account_id_unique ON public.accounts USING btree (provider_id, account_id)",
      ),
      exactIndex(
        "accounts",
        "accounts_user_id_idx",
        "CREATE INDEX accounts_user_id_idx ON public.accounts USING btree (user_id)",
      ),
      exactIndex(
        "sessions",
        "sessions_pkey",
        "CREATE UNIQUE INDEX sessions_pkey ON public.sessions USING btree (id)",
      ),
      exactIndex(
        "sessions",
        "sessions_token_unique",
        "CREATE UNIQUE INDEX sessions_token_unique ON public.sessions USING btree (token)",
      ),
      exactIndex(
        "sessions",
        "sessions_user_id_idx",
        "CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id)",
      ),
      exactIndex(
        "users",
        "users_email_unique",
        "CREATE UNIQUE INDEX users_email_unique ON public.users USING btree (email)",
      ),
      exactIndex(
        "users",
        "users_pkey",
        "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
      ),
      exactIndex(
        "verifications",
        "verifications_identifier_idx",
        "CREATE INDEX verifications_identifier_idx ON public.verifications USING btree (identifier)",
      ),
      exactIndex(
        "verifications",
        "verifications_pkey",
        "CREATE UNIQUE INDEX verifications_pkey ON public.verifications USING btree (id)",
      ),
    ],
  },
];

export const APPROVED_TAGS = APPROVED_MIGRATIONS.map((m) => m.tag);

// ---------------------------------------------------------------------------
// The expected structure after the first `applied` migrations

export type ExpectedStructure = {
  applied: number;
  tables: readonly string[];
  columns: readonly ColumnSpec[];
  constraints: readonly ConstraintSpec[];
  indexes: readonly IndexSpec[];
  // "<table>.<column>" for every NOT NULL column: PostgreSQL 18 stores one
  // pg_constraint row (contype 'n') for each.
  notNullColumns: readonly string[];
};

// Byte order, as the catalog queries sort with COLLATE "C" (all names here
// are ASCII).
const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byTableThenName = (
  a: readonly [string, string, ...unknown[]],
  b: readonly [string, string, ...unknown[]],
) => byteOrder(a[0], b[0]) || byteOrder(a[1], b[1]);

export function expectedStructure(applied: number): ExpectedStructure {
  if (
    !Number.isInteger(applied) ||
    applied < 1 ||
    applied > APPROVED_MIGRATIONS.length
  ) {
    throw new RangeError("applied must count approved migrations (1 to N).");
  }
  const migrations = APPROVED_MIGRATIONS.slice(0, applied);
  const tables = migrations.flatMap((m) => m.tables).sort(byteOrder);
  // Columns keep their order within a table (attnum); tables sort by name.
  const columns = migrations
    .flatMap((m) => m.columns)
    .map((column, i) => ({ column, i }))
    .sort((a, b) => byteOrder(a.column[0], b.column[0]) || a.i - b.i)
    .map(({ column }) => column);
  return {
    applied,
    tables,
    columns,
    constraints: migrations.flatMap((m) => m.constraints).sort(byTableThenName),
    indexes: migrations.flatMap((m) => m.indexes).sort(byTableThenName),
    notNullColumns: columns
      .filter((column) => column[3] === "NO")
      .map(([table, column]) => `${table}.${column}`),
  };
}

export const FULL_STRUCTURE = expectedStructure(APPROVED_MIGRATIONS.length);

export function constraintMatches(
  spec: ConstraintSpec,
  type: unknown,
  definition: unknown,
): boolean {
  if (spec[2] !== type || typeof definition !== "string") return false;
  return spec[4] === "exact"
    ? definition === spec[3][0]
    : spec[3].every((fragment) => definition.includes(fragment));
}

export function indexMatches(spec: IndexSpec, definition: unknown): boolean {
  if (typeof definition !== "string") return false;
  return spec[3] === "exact"
    ? definition === spec[2]
    : definition.includes(spec[2]);
}

// "a", "a and b", "a, b, and c"
export function listNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

// ---------------------------------------------------------------------------
// The migration files on disk

export type JournalEntry = {
  idx?: unknown;
  version?: unknown;
  when?: unknown;
  tag?: unknown;
  breakpoints?: unknown;
};

// What readMigrationFiles found under drizzle/.
export type MigrationFiles = {
  // Every entry under drizzle/, relative and sorted: files as their path
  // ("0000_initial_schema.sql", "meta/_journal.json"), directories with a
  // trailing "/", and anything else (a symbolic link, say) with a trailing
  // "@". Only regular files are read.
  listing: readonly string[];
  journal: { version?: unknown; dialect?: unknown; entries: JournalEntry[] };
  // SHA-256 of each regular file, by its listing path.
  sha256: Readonly<Record<string, string>>;
  // id and prevId of each snapshot that parsed as JSON, by listing path.
  snapshots: Readonly<Record<string, { id?: unknown; prevId?: unknown }>>;
};

export const EXPECTED_LISTING: readonly string[] = [
  ...APPROVED_MIGRATIONS.flatMap((m) => [`${m.tag}.sql`, m.snapshot.file]),
  "meta/",
  "meta/_journal.json",
].sort(byteOrder);

// The offline file checks every tool runs before it may connect. Returns
// whether all of them passed.
export function checkMigrationFiles(
  files: MigrationFiles,
  check: Check,
): boolean {
  let ok = true;
  const report: Check = (pass, label, detail) => {
    if (!pass) ok = false;
    check(pass, label, detail);
  };
  const count = APPROVED_MIGRATIONS.length;

  const extra = files.listing.filter((p) => !EXPECTED_LISTING.includes(p));
  const missing = EXPECTED_LISTING.filter((p) => !files.listing.includes(p));
  report(
    extra.length === 0 && missing.length === 0,
    `files: drizzle/ holds exactly the ${count} approved migrations, their snapshots, and the journal`,
    extra.length > 0 || missing.length > 0
      ? `(${[
          ...extra.map((p) => `extra: ${safeName(p)}`),
          ...missing.map((p) => `missing: ${p}`),
        ].join(", ")})`
      : undefined,
  );

  const entries = files.journal.entries;
  report(
    files.journal.version === "7" &&
      files.journal.dialect === "postgresql" &&
      entries.length === count &&
      APPROVED_MIGRATIONS.every((m, i) => {
        const entry = entries[i];
        return (
          entry?.idx === i &&
          entry.version === "7" &&
          entry.tag === m.tag &&
          entry.when === m.when &&
          entry.breakpoints === true
        );
      }),
    `files: the journal lists exactly ${APPROVED_TAGS.join(", ")}, in that order, with the reviewed timestamps`,
  );
  report(
    entries.every(
      (entry, i) =>
        typeof entry.when === "number" &&
        (i === 0 ||
          (typeof entries[i - 1]?.when === "number" &&
            entry.when > (entries[i - 1]?.when as number))),
    ),
    "files: journal timestamps strictly increase (the migrator relies on it)",
  );

  for (const m of APPROVED_MIGRATIONS) {
    report(
      files.sha256[`${m.tag}.sql`] === m.sha256,
      `files: ${m.tag}.sql matches the reviewed SHA-256`,
    );
  }
  for (const m of APPROVED_MIGRATIONS) {
    report(
      files.sha256[m.snapshot.file] === m.snapshot.sha256,
      `files: ${m.snapshot.file} matches the reviewed SHA-256`,
    );
  }
  report(
    APPROVED_MIGRATIONS.every((m, i) => {
      const found = files.snapshots[m.snapshot.file];
      const previous = APPROVED_MIGRATIONS[i - 1];
      return (
        found?.id === m.snapshot.id &&
        found.prevId === m.snapshot.prevId &&
        m.snapshot.prevId ===
          (previous ? previous.snapshot.id : FIRST_SNAPSHOT_PREV_ID)
      );
    }),
    "files: the snapshots form one chain (each prevId is the previous snapshot's id)",
  );
  return ok;
}

// File names in drizzle/ are printed only when they look like ordinary
// migration file names; anything else is reported by length.
function safeName(path: string): string {
  return /^[0-9A-Za-z_./-]{1,80}[/@]?$/.test(path)
    ? path
    : `<${path.length} characters>`;
}
