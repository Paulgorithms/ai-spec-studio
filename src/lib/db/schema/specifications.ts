import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { SPEC_STATUSES, type SpecStatus } from "../../spec-status";
import { timestamps } from "./columns";
import { projects } from "./projects";

// The display key, such as "SPEC-007".
export const SPECIFICATION_KEY_PATTERN = "^SPEC-[0-9]{3,}$";

// SQL list of the allowed statuses, from the app's own SPEC_STATUSES. They
// are fixed identifiers (checked in the schema tests), so inlining them as
// literals is safe; DDL can't take bind parameters.
const STATUS_LIST = sql.raw(
  SPEC_STATUSES.map((status) => `'${status}'`).join(", "),
);

// A specification in a project. `key` is the stable display key; `id` is
// the primary key. Deleting a project that still has specifications is
// refused (ON DELETE RESTRICT).
export const specifications = pgTable(
  "specifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    key: text("key").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    status: text("status").$type<SpecStatus>().notNull().default("draft"),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: "specifications_project_id_fkey",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    unique("specifications_key_unique").on(table.key),
    check(
      "specifications_key_format_check",
      sql`${table.key} ~ ${sql.raw(`'${SPECIFICATION_KEY_PATTERN}'`)}`,
    ),
    check(
      "specifications_status_check",
      sql`${table.status} IN (${STATUS_LIST})`,
    ),
    // Foreign keys aren't indexed automatically; this serves per-project
    // lists and the RESTRICT check on project deletes.
    index("specifications_project_id_idx").on(table.projectId),
    // "Recently updated" lists, newest first, with key as a stable tiebreak.
    // The migration created it as (updated_at DESC NULLS LAST, key). Queries
    // meant to use it must order by exactly that: in Drizzle,
    // orderBy(sql`${specifications.updatedAt} desc nulls last`,
    // specifications.key). A plain desc(...) means DESC NULLS FIRST, which
    // PostgreSQL may not serve from this index, even though the column is
    // NOT NULL. Query-plan checks belong to the data access layer.
    index("specifications_updated_at_key_idx").on(
      table.updatedAt.desc(),
      table.key,
    ),
  ],
);

export type SpecificationRow = typeof specifications.$inferSelect;
export type NewSpecificationRow = typeof specifications.$inferInsert;
