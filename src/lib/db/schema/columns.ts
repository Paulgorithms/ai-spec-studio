// Shared column helpers. Schema files stay free of `server-only` and use
// relative imports, because Drizzle Kit loads them outside Next.js.
import { timestamp } from "drizzle-orm/pg-core";

// timestamptz(3): UTC instants with millisecond precision, matching
// JavaScript Date. The data access layer converts them to ISO strings.
export function timestampColumn(name: string) {
  return timestamp(name, { withTimezone: true, precision: 3, mode: "date" });
}

// created_at and updated_at for every table. updated_at defaults to now() on
// insert, and Drizzle sets it on every update it runs ($onUpdate). Updates
// made with raw SQL must set it themselves.
export function timestamps() {
  return {
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  };
}
