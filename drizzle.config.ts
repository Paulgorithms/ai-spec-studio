// Drizzle Kit configuration (npm run db:generate, db:check, db:migrate).
//
// Credentials come only from DATABASE_MIGRATION_URL (the migration role),
// validated by parseMigrationDatabaseEnv. There is no fallback to
// DATABASE_URL. Locally the value comes from .env.local, loaded with Node's
// built-in process.loadEnvFile(); a variable already set in the environment
// (as in CI) takes precedence over the file.
//
// Offline commands (db:generate, db:check, and drizzle-kit up, drop, and
// export) never load .env.local or read credentials. Every other command
// (db:migrate, and any unrecognized command) loads them and fails unless
// DATABASE_MIGRATION_URL is set and valid.
//
// Connecting commands may reach only the local development database
// (checkMigrationTarget: ai_spec_studio_migrator on loopback port 5432,
// database ai_spec_studio_dev, TLS off). There is no override.
//
// Loading this file never connects to the database. `drizzle-kit push` is
// refused: schema changes go through reviewed, committed migrations.
//
// Never log the connection object: it holds the password. Log
// describeDatabaseTarget() instead.
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { defineConfig } from "drizzle-kit";
import {
  drizzleKitCommand,
  drizzleKitNeedsDatabase,
} from "./src/lib/db/drizzle-kit-command";
import {
  describeDatabaseTarget,
  parseMigrationDatabaseEnv,
} from "./src/lib/db/env";
import { checkMigrationTarget } from "./src/lib/db/migration-target";

if (process.argv.slice(2).includes("push")) {
  throw new Error(
    "drizzle-kit push is disabled in this project. Generate a migration with npm run db:generate, review it, and apply it with npm run db:migrate.",
  );
}

// Drizzle Kit bundles dotenv and loads ./.env (or DOTENV_CONFIG_PATH) into
// the environment before reading this file. This project keeps credentials
// only in .env.local, so refuse anything else rather than use it silently.
if (existsSync(".env") || process.env.DOTENV_CONFIG_PATH) {
  throw new Error(
    "Drizzle Kit loaded environment variables from .env or DOTENV_CONFIG_PATH. Database settings belong in .env.local only: remove .env or unset DOTENV_CONFIG_PATH.",
  );
}

function loadLocalEnv() {
  try {
    loadEnvFile(".env.local");
  } catch (error) {
    // No .env.local is fine (CI sets variables directly). Rethrow anything
    // else, by code only: the parser's message could quote the file.
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : "unknown";
    if (code !== "ENOENT") {
      throw new Error(`Could not load .env.local (${code}).`);
    }
  }
}

function migrationCredentials() {
  if (!process.env.DATABASE_MIGRATION_URL?.trim()) {
    throw new Error(
      `DATABASE_MIGRATION_URL is required for drizzle-kit ${drizzleKitCommand(process.argv)}. Set it in .env.local (see scripts/db/README.md).`,
    );
  }

  const parsed = parseMigrationDatabaseEnv(process.env);
  if (!parsed.ok) {
    // The validator's messages name variables and rules, never values.
    throw new Error(
      `Invalid migration database settings:\n- ${parsed.errors.join("\n- ")}`,
    );
  }
  const { connection } = parsed.value;
  const targetErrors = checkMigrationTarget(connection);
  if (targetErrors.length > 0) {
    // Fail closed before Drizzle Kit connects. Messages never contain values.
    throw new Error(
      `drizzle-kit ${drizzleKitCommand(process.argv)} is limited to the local development database:\n- ${targetErrors.join("\n- ")}`,
    );
  }
  console.log(
    `Migration database: ${describeDatabaseTarget(connection)} (DATABASE_MIGRATION_URL)`,
  );
  // The object form of ssl, always: Drizzle Kit 0.31 turns the strings
  // "require", "prefer", and "allow" into { rejectUnauthorized: false } and a
  // missing ssl into {}. false (loopback only) or full verification.
  return {
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
    ssl: connection.ssl,
  };
}

let dbCredentials: ReturnType<typeof migrationCredentials> | undefined;
if (drizzleKitNeedsDatabase(process.argv)) {
  loadLocalEnv();
  dbCredentials = migrationCredentials();
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema",
  // Committed, reviewed SQL migrations and their snapshots.
  out: "./drizzle",
  migrations: { table: "__drizzle_migrations", schema: "drizzle" },
  strict: true,
  ...(dbCredentials ? { dbCredentials } : {}),
});
