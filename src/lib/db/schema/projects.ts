import { sql } from "drizzle-orm";
import { check, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./columns";

// Lowercase kebab-case, such as "billing-service".
export const PROJECT_SLUG_PATTERN = "^[a-z0-9]+(-[a-z0-9]+)*$";

// A project groups specifications. `slug` is the stable, human-readable key;
// `id` is the primary key. When workspaces arrive, UNIQUE(slug) becomes
// UNIQUE(workspace_id, slug) (expand and contract).
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    ...timestamps(),
  },
  (table) => [
    unique("projects_slug_unique").on(table.slug),
    check(
      "projects_slug_format_check",
      sql`${table.slug} ~ ${sql.raw(`'${PROJECT_SLUG_PATTERN}'`)}`,
    ),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
