// The migration as the drizzle-orm migrator reads it: the first journal
// entry, and the SHA-256 of its whole SQL file. (scripts/db/migration-check.ts
// keeps its own reviewed copy of this logic.)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MigrationFiles } from "./migration-checks";

export function readMigrationFiles(root = "."): MigrationFiles {
  const journal = JSON.parse(
    readFileSync(`${root}/drizzle/meta/_journal.json`, "utf8"),
  ) as { entries?: Array<{ tag?: unknown; when?: unknown }> };
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const first = entries[0];
  const tag = typeof first?.tag === "string" ? first.tag : "";
  const when = typeof first?.when === "number" ? first.when : Number.NaN;
  const sql = /^[0-9a-z_]+$/.test(tag)
    ? readFileSync(`${root}/drizzle/${tag}.sql`, "utf8")
    : "";
  return {
    journalEntries: entries.length,
    tag,
    when,
    sha256: createHash("sha256").update(sql).digest("hex"),
  };
}
