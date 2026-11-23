// The migration files as the drizzle-orm migrator reads them: the journal,
// and the SHA-256 of each whole file (the migrator hashes each SQL file the
// same way). Every entry under drizzle/ is listed, so a missing, extra, or
// renamed file is caught by checkMigrationFiles (approved-migrations.ts),
// which judges what this returns. Symbolic links and other non-regular
// entries are listed but never followed or read.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import type { JournalEntry, MigrationFiles } from "./approved-migrations";

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function list(root: string, prefix = ""): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(`${root}/${prefix}`)) {
    const path = `${prefix}${name}`;
    const stat = lstatSync(`${root}/${path}`);
    if (stat.isDirectory()) {
      entries.push(`${path}/`);
      // Only the one known subdirectory is descended into.
      if (path === "meta") entries.push(...list(root, `${path}/`));
    } else if (stat.isFile()) {
      entries.push(path);
    } else {
      entries.push(`${path}@`);
    }
  }
  return entries;
}

export function readMigrationFiles(root = "."): MigrationFiles {
  const folder = `${root}/drizzle`;
  const listing = list(folder).sort(byteOrder);
  const sha256: Record<string, string> = {};
  const snapshots: Record<string, { id?: unknown; prevId?: unknown }> = {};
  let journal: MigrationFiles["journal"] = { entries: [] };

  for (const path of listing) {
    if (path.endsWith("/") || path.endsWith("@")) continue;
    const content = readFileSync(`${folder}/${path}`);
    sha256[path] = createHash("sha256").update(content).digest("hex");
    if (path === "meta/_journal.json") {
      const parsed = parseJson(content) as {
        version?: unknown;
        dialect?: unknown;
        entries?: unknown;
      } | null;
      journal = {
        version: parsed?.version,
        dialect: parsed?.dialect,
        entries: Array.isArray(parsed?.entries)
          ? (parsed.entries as unknown[]).map((entry) =>
              entry && typeof entry === "object" ? (entry as JournalEntry) : {},
            )
          : [],
      };
    } else if (/^meta\/\d{4}_snapshot\.json$/.test(path)) {
      const parsed = parseJson(content) as {
        id?: unknown;
        prevId?: unknown;
      } | null;
      if (parsed) snapshots[path] = { id: parsed.id, prevId: parsed.prevId };
    }
  }
  return { listing, journal, sha256, snapshots };
}

function parseJson(content: Buffer): unknown {
  try {
    const value: unknown = JSON.parse(content.toString("utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
