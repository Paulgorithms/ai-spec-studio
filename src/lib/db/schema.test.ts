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
  projects,
  specifications,
} from "@/lib/db/schema";
import { SPEC_STATUSES } from "@/lib/spec-status";

const dialect = new PgDialect();
const render = (value: SQL) => dialect.sqlToQuery(value);

function columnSummary(table: typeof projects | typeof specifications) {
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

function checks(table: typeof projects | typeof specifications) {
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
  test("exports only the two approved tables", async () => {
    const schema = await import("@/lib/db/schema");
    const tables = Object.entries(schema)
      .filter(([, value]) => is(value, PgTable))
      .map(([name]) => name);
    expect(tables.sort()).toEqual(["projects", "specifications"]);
  });
});
