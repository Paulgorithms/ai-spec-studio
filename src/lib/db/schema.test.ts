// Schema tests: inspect the table definitions and the SQL Drizzle renders for
// their constraints. Nothing here connects to PostgreSQL. (This file lives
// outside schema/, because Drizzle Kit loads every file in that folder.)
import { getTableColumns, is, type SQL } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, test, vi } from "vitest";

// The schema must never load the database driver: importing it can't connect.
vi.mock("pg", () => {
  throw new Error("The schema must not import pg.");
});
import {
  PROJECT_SLUG_PATTERN,
  SPECIFICATION_KEY_PATTERN,
  accounts,
  projects,
  sessions,
  specifications,
  users,
  verifications,
} from "@/lib/db/schema";
import { SPEC_STATUSES } from "@/lib/spec-status";

const dialect = new PgDialect();
const render = (value: SQL) => dialect.sqlToQuery(value);

function columnSummary(table: PgTable) {
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => [
      key,
      {
        name: column.name,
        type: column.getSQLType(),
        notNull: column.notNull,
        primary: column.primary,
        hasDefault: column.hasDefault,
      },
    ]),
  );
}

function checks(table: PgTable) {
  return Object.fromEntries(
    getTableConfig(table).checks.map((c) => [c.name, render(c.value)]),
  );
}

describe("projects", () => {
  const config = getTableConfig(projects);

  test("is the projects table with snake_case columns", () => {
    expect(config.name).toBe("projects");
    expect(config.schema).toBeUndefined();
    expect(columnSummary(projects)).toEqual({
      id: {
        name: "id",
        type: "uuid",
        notNull: true,
        primary: true,
        hasDefault: true,
      },
      slug: {
        name: "slug",
        type: "text",
        notNull: true,
        primary: false,
        hasDefault: false,
      },
      name: {
        name: "name",
        type: "text",
        notNull: true,
        primary: false,
        hasDefault: false,
      },
      description: {
        name: "description",
        type: "text",
        notNull: true,
        primary: false,
        hasDefault: true,
      },
      createdAt: {
        name: "created_at",
        type: "timestamp (3) with time zone",
        notNull: true,
        primary: false,
        hasDefault: true,
      },
      updatedAt: {
        name: "updated_at",
        type: "timestamp (3) with time zone",
        notNull: true,
        primary: false,
        hasDefault: true,
      },
    });
  });

  test("generates UUID keys and defaults in the database", () => {
    const columns = getTableColumns(projects);
    expect(render(columns.id.default as SQL).sql).toBe("gen_random_uuid()");
    expect(columns.description.default).toBe("");
    expect(render(columns.createdAt.default as SQL).sql).toBe("now()");
    expect(render(columns.updatedAt.default as SQL).sql).toBe("now()");
  });

  test("keeps updated_at current on ORM updates", () => {
    const { updatedAt, createdAt } = getTableColumns(projects);
    expect(updatedAt.onUpdateFn?.()).toBeInstanceOf(Date);
    expect(createdAt.onUpdateFn).toBeUndefined();
  });

  test("makes slug unique and checks its format", () => {
    expect(
      config.uniqueConstraints.map((u) => [
        u.name,
        u.columns.map((c) => c.name),
      ]),
    ).toEqual([["projects_slug_unique", ["slug"]]]);
    expect(checks(projects)).toEqual({
      projects_slug_format_check: {
        sql: `"projects"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
        params: [],
      },
    });
  });

  test.each([
    ["billing-service", true],
    ["a", true],
    ["v2-api", true],
    ["Billing-Service", false],
    ["billing_service", false],
    ["-billing", false],
    ["billing-", false],
    ["billing--service", false],
    ["", false],
  ])("slug pattern: %j -> %s", (slug, valid) => {
    // The same POSIX pattern PostgreSQL evaluates; it uses only syntax that
    // means the same thing in JavaScript.
    expect(new RegExp(PROJECT_SLUG_PATTERN).test(slug)).toBe(valid);
  });

  test("has no foreign keys or extra indexes", () => {
    expect(config.foreignKeys).toEqual([]);
    expect(config.indexes).toEqual([]);
  });
});

describe("specifications", () => {
  const config = getTableConfig(specifications);

  test("is the specifications table with snake_case columns", () => {
    expect(config.name).toBe("specifications");
    expect(columnSummary(specifications)).toEqual({
      id: {
        name: "id",
        type: "uuid",
        notNull: true,
        primary: true,
        hasDefault: true,
      },
      projectId: {
        name: "project_id",
        type: "uuid",
        notNull: true,
        primary: false,
        hasDefault: false,
      },
      key: {
        name: "key",
        type: "text",
        notNull: true,
        primary: false,
        hasDefault: false,
      },
      title: {
        name: "title",
        type: "text",
        notNull: true,
        primary: false,
        hasDefault: false,
      },
      summary: {
        name: "summary",
        type: "text",
        notNull: true,
        primary: false,
        hasDefault: true,
      },
      status: {
        name: "status",
        type: "text",
        notNull: true,
        primary: false,
        hasDefault: true,
      },
      createdAt: {
        name: "created_at",
        type: "timestamp (3) with time zone",
        notNull: true,
        primary: false,
        hasDefault: true,
      },
      updatedAt: {
        name: "updated_at",
        type: "timestamp (3) with time zone",
        notNull: true,
        primary: false,
        hasDefault: true,
      },
    });
    const columns = getTableColumns(specifications);
    expect(render(columns.id.default as SQL).sql).toBe("gen_random_uuid()");
    expect(columns.summary.default).toBe("");
    expect(columns.status.default).toBe("draft");
    expect(columns.updatedAt.onUpdateFn?.()).toBeInstanceOf(Date);
  });

  test("references projects.id with ON DELETE RESTRICT", () => {
    expect(config.foreignKeys).toHaveLength(1);
    const [fk] = config.foreignKeys;
    const reference = fk?.reference();
    expect(fk?.getName()).toBe("specifications_project_id_fkey");
    expect(reference?.columns.map((c) => c.name)).toEqual(["project_id"]);
    expect(getTableConfig(reference!.foreignTable).name).toBe("projects");
    expect(reference?.foreignColumns.map((c) => c.name)).toEqual(["id"]);
    expect(fk?.onDelete).toBe("restrict");
    expect(fk?.onUpdate).toBe("no action");
  });

  test("makes key unique and checks key and status", () => {
    expect(
      config.uniqueConstraints.map((u) => [
        u.name,
        u.columns.map((c) => c.name),
      ]),
    ).toEqual([["specifications_key_unique", ["key"]]]);
    expect(checks(specifications)).toEqual({
      specifications_key_format_check: {
        sql: `"specifications"."key" ~ '^SPEC-[0-9]{3,}$'`,
        params: [],
      },
      specifications_status_check: {
        sql: `"specifications"."status" IN ('draft', 'in-review', 'approved')`,
        params: [],
      },
    });
  });

  test("allows exactly the app's statuses, which are safe to inline", () => {
    for (const status of SPEC_STATUSES)
      expect(status).toMatch(/^[a-z]+(-[a-z]+)*$/);
    const rendered =
      checks(specifications).specifications_status_check?.sql ?? "";
    expect(rendered.match(/'[^']*'/g)).toEqual(
      SPEC_STATUSES.map((s) => `'${s}'`),
    );
  });

  test.each([
    ["SPEC-001", true],
    ["SPEC-007", true],
    ["SPEC-1234", true],
    ["SPEC-01", false],
    ["spec-001", false],
    ["SPEC-00A", false],
    ["SPEC 001", false],
    ["XSPEC-001", false],
    ["SPEC-001 ", false],
  ])("key pattern: %j -> %s", (key, valid) => {
    expect(new RegExp(SPECIFICATION_KEY_PATTERN).test(key)).toBe(valid);
  });

  test("indexes project_id and (updated_at DESC, key)", () => {
    const indexes = config.indexes.map((i) => ({
      name: i.config.name,
      unique: i.config.unique,
      columns: i.config.columns.map((c) =>
        "name" in c
          ? { name: c.name, order: c.indexConfig?.order ?? "asc" }
          : c,
      ),
    }));
    expect(indexes).toEqual([
      {
        name: "specifications_project_id_idx",
        unique: false,
        columns: [{ name: "project_id", order: "asc" }],
      },
      {
        name: "specifications_updated_at_key_idx",
        unique: false,
        columns: [
          { name: "updated_at", order: "desc" },
          { name: "key", order: "asc" },
        ],
      },
    ]);
  });
});

describe("the schema module", () => {
  test("exports only the six approved tables", async () => {
    const schema = await import("@/lib/db/schema");
    const tables = Object.entries(schema)
      .filter(([, value]) => is(value, PgTable))
      .map(([name]) => name);
    expect(tables.sort()).toEqual([
      "accounts",
      "projects",
      "sessions",
      "specifications",
      "users",
      "verifications",
    ]);
  });
});

// Authentication tables (Better Auth). Shared shapes for every auth table.
const TIMESTAMPTZ = "timestamp (3) with time zone";
const ID = {
  name: "id",
  type: "uuid",
  notNull: true,
  primary: true,
  hasDefault: true,
};
const CREATED_UPDATED = {
  createdAt: {
    name: "created_at",
    type: TIMESTAMPTZ,
    notNull: true,
    primary: false,
    hasDefault: true,
  },
  updatedAt: {
    name: "updated_at",
    type: TIMESTAMPTZ,
    notNull: true,
    primary: false,
    hasDefault: true,
  },
};
const column = (
  name: string,
  type: string,
  notNull: boolean,
  hasDefault = false,
) => ({ name, type, notNull, primary: false, hasDefault });

function uniques(table: PgTable) {
  return getTableConfig(table).uniqueConstraints.map((u) => [
    u.name,
    u.columns.map((c) => c.name),
  ]);
}

function indexSummary(table: PgTable) {
  return getTableConfig(table).indexes.map((i) => ({
    name: i.config.name,
    unique: i.config.unique,
    columns: i.config.columns.map((c) => ("name" in c ? c.name : c)),
  }));
}

function foreignKeySummary(table: PgTable) {
  return getTableConfig(table).foreignKeys.map((fk) => {
    const reference = fk.reference();
    return {
      name: fk.getName(),
      columns: reference.columns.map((c) => c.name),
      foreignTable: getTableConfig(reference.foreignTable).name,
      foreignColumns: reference.foreignColumns.map((c) => c.name),
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
    };
  });
}

describe.each([
  ["users", users],
  ["sessions", sessions],
  ["accounts", accounts],
  ["verifications", verifications],
] as const)("%s (auth)", (name, table) => {
  test("is a plural snake_case table with a database-generated UUID key", () => {
    expect(getTableConfig(table).name).toBe(name);
    const columns = getTableColumns(table);
    expect(render(columns.id.default as SQL).sql).toBe("gen_random_uuid()");
    expect(render(columns.createdAt.default as SQL).sql).toBe("now()");
    expect(render(columns.updatedAt.default as SQL).sql).toBe("now()");
    expect(columns.updatedAt.onUpdateFn?.()).toBeInstanceOf(Date);
    expect(columns.createdAt.onUpdateFn).toBeUndefined();
  });
});

describe("users", () => {
  test("has Better Auth's user fields", () => {
    expect(columnSummary(users)).toEqual({
      id: ID,
      name: column("name", "text", true),
      email: column("email", "text", true),
      emailVerified: column("email_verified", "boolean", true, true),
      image: column("image", "text", false),
      ...CREATED_UPDATED,
    });
    expect(getTableColumns(users).emailVerified.default).toBe(false);
  });

  test("makes email unique with a plain (case-sensitive) constraint", () => {
    expect(uniques(users)).toEqual([["users_email_unique", ["email"]]]);
    expect(indexSummary(users)).toEqual([]);
    expect(foreignKeySummary(users)).toEqual([]);
    expect(checks(users)).toEqual({});
  });
});

describe("sessions", () => {
  test("has Better Auth's session fields, with a nullable ip_address", () => {
    expect(columnSummary(sessions)).toEqual({
      id: ID,
      expiresAt: column("expires_at", TIMESTAMPTZ, true),
      token: column("token", "text", true),
      ipAddress: column("ip_address", "text", false),
      userAgent: column("user_agent", "text", false),
      userId: column("user_id", "uuid", true),
      ...CREATED_UPDATED,
    });
  });

  test("makes token unique, indexes user_id, and cascades from users", () => {
    expect(uniques(sessions)).toEqual([["sessions_token_unique", ["token"]]]);
    expect(indexSummary(sessions)).toEqual([
      { name: "sessions_user_id_idx", unique: false, columns: ["user_id"] },
    ]);
    expect(foreignKeySummary(sessions)).toEqual([
      {
        name: "sessions_user_id_fkey",
        columns: ["user_id"],
        foreignTable: "users",
        foreignColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
    ]);
    expect(checks(sessions)).toEqual({});
  });
});

describe("accounts", () => {
  test("has Better Auth's account fields", () => {
    expect(columnSummary(accounts)).toEqual({
      id: ID,
      accountId: column("account_id", "text", true),
      providerId: column("provider_id", "text", true),
      userId: column("user_id", "uuid", true),
      accessToken: column("access_token", "text", false),
      refreshToken: column("refresh_token", "text", false),
      idToken: column("id_token", "text", false),
      accessTokenExpiresAt: column(
        "access_token_expires_at",
        TIMESTAMPTZ,
        false,
      ),
      refreshTokenExpiresAt: column(
        "refresh_token_expires_at",
        TIMESTAMPTZ,
        false,
      ),
      scope: column("scope", "text", false),
      password: column("password", "text", false),
      ...CREATED_UPDATED,
    });
  });

  test("makes each provider identity unique, indexes user_id, and cascades from users", () => {
    expect(uniques(accounts)).toEqual([
      ["accounts_provider_id_account_id_unique", ["provider_id", "account_id"]],
    ]);
    expect(indexSummary(accounts)).toEqual([
      { name: "accounts_user_id_idx", unique: false, columns: ["user_id"] },
    ]);
    expect(foreignKeySummary(accounts)).toEqual([
      {
        name: "accounts_user_id_fkey",
        columns: ["user_id"],
        foreignTable: "users",
        foreignColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
    ]);
  });

  test("forbids stored passwords, and allows any provider id", () => {
    // No provider allowlist (approved decision): only the password check.
    expect(checks(accounts)).toEqual({
      accounts_password_null_check: {
        sql: `"accounts"."password" IS NULL`,
        params: [],
      },
    });
  });
});

describe("verifications", () => {
  test("has Better Auth's verification fields, indexed by identifier", () => {
    expect(columnSummary(verifications)).toEqual({
      id: ID,
      identifier: column("identifier", "text", true),
      value: column("value", "text", true),
      expiresAt: column("expires_at", TIMESTAMPTZ, true),
      ...CREATED_UPDATED,
    });
    expect(indexSummary(verifications)).toEqual([
      {
        name: "verifications_identifier_idx",
        unique: false,
        columns: ["identifier"],
      },
    ]);
    expect(uniques(verifications)).toEqual([]);
    expect(foreignKeySummary(verifications)).toEqual([]);
    expect(checks(verifications)).toEqual({});
  });
});
