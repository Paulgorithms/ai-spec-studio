// The app's database client: one node-postgres pool per server process,
// created on the first getDb() call, never at import or build time.
//
// Runtime credentials come only from DATABASE_URL (the application role),
// validated by parseRuntimeDatabaseEnv. DATABASE_MIGRATION_URL and
// TEST_DATABASE_URL are never read here.
//
// Never log the pool, its options, or a connection object: they hold the
// password. Errors from this module name settings and rules, never values.
import "server-only";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  describeDatabaseTarget,
  parseRuntimeDatabaseEnv,
  type DatabaseEnv,
} from "./env";
import { buildPoolConfig, checkPgEnvironment } from "./pool-config";

export type Database = NodePgDatabase & { $client: Pool };

// Thrown when the database can't be set up. Its message is safe to log.
export class DatabaseConfigurationError extends Error {
  override name = "DatabaseConfigurationError";
}

type DatabaseClient = { db: Database; pool: Pool };

// Cached on globalThis, so `next dev` hot reloads reuse the pool instead of
// leaking a new one per reload.
const CLIENT_KEY: unique symbol = Symbol.for("ai-spec-studio.database-client");
type ClientCache = typeof globalThis & { [CLIENT_KEY]?: DatabaseClient };
const cache = globalThis as ClientCache;

// The shared Drizzle client. Creates the pool on first use; creating it
// doesn't connect (connections open when the first query runs).
export function getDb(): Database {
  cache[CLIENT_KEY] ??= createClient(process.env);
  return cache[CLIENT_KEY].db;
}

// Ends the pool (for shutdown and tests). The next getDb() creates a new one.
export async function closeDb(): Promise<void> {
  const client = cache[CLIENT_KEY];
  if (!client) return;
  delete cache[CLIENT_KEY];
  await client.pool.end();
}

function createClient(env: DatabaseEnv): DatabaseClient {
  const parsed = parseRuntimeDatabaseEnv(env);
  const pgErrors = checkPgEnvironment(env);
  if (!parsed.ok || pgErrors.length > 0) {
    throw configurationError([
      ...(parsed.ok ? [] : parsed.errors),
      ...pgErrors,
    ]);
  }

  const { connection, poolMax } = parsed.value;
  const config = buildPoolConfig(connection, poolMax);
  if (!config.ok) throw configurationError(config.errors);

  const target = describeDatabaseTarget(connection);
  let pool: Pool;
  try {
    pool = new Pool(config.value);
  } catch (error) {
    // The driver's message could quote the configuration: report the kind
    // of error only.
    throw new DatabaseConfigurationError(
      `Could not create the database pool for ${target} (${errorKind(error)}).`,
    );
  }

  // Required: without a listener, an error on an idle client crashes the
  // process. Log the kind of error only.
  pool.on("error", (error) => {
    console.error(
      `[db] An idle database connection to ${target} failed (${errorKind(error)}). The pool will replace it.`,
    );
  });

  return { db: drizzle({ client: pool }), pool };
}

function configurationError(errors: string[]): DatabaseConfigurationError {
  return new DatabaseConfigurationError(
    `The database configuration is invalid:\n- ${errors.join("\n- ")}`,
  );
}

// A code (ECONNRESET, 57P01) or class name: never the message.
function errorKind(error: unknown): string {
  if (error && typeof error === "object") {
    if ("code" in error && typeof error.code === "string") return error.code;
    if (error instanceof Error) return error.name;
  }
  return "unknown error";
}
