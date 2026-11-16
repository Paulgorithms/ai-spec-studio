// node-postgres pool settings built from a validated DatabaseConnection.
// Pure (no connection, no process.env reads), and free of `server-only`, so
// standalone scripts and tests can reuse it. The app gets its pool through
// src/lib/db/client.ts.
//
// Error messages never contain values: the inputs carry passwords.
import { X509Certificate } from "node:crypto";
import type { PoolConfig } from "pg";
import type { DatabaseConnection, DatabaseEnv, EnvParseResult } from "./env";

export const APPLICATION_NAME = "ai-spec-studio";

// Fail fast instead of waiting forever for a connection (pg's default is 0).
export const CONNECTION_TIMEOUT_MS = 5_000;
export const IDLE_TIMEOUT_MS = 10_000;
// Rotate connections, so the pool recovers after a failover.
export const MAX_LIFETIME_SECONDS = 1_800;
// Server-side limits for each session.
export const STATEMENT_TIMEOUT_MS = 30_000;
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

// node-postgres reads PG* environment variables for every setting the config
// leaves empty, each time it opens a connection. The config below sets the
// password, host, port, user, database, ssl, options, application_name, and
// client_encoding explicitly, so none of those can come from the environment
// (and a nonempty password means ~/.pgpass is never read). `binary` and
// `replication` can't be pinned that way (pg ignores false), so their
// variables are refused instead. PGOPTIONS is refused by env.ts.
const UNPINNABLE_PG_VARIABLES = ["PGBINARY", "PGREPLICATION"] as const;

export function checkPgEnvironment(env: DatabaseEnv): string[] {
  return UNPINNABLE_PG_VARIABLES.filter((name) => env[name]?.trim()).map(
    (name) =>
      `${name} must not be set. Database connection settings are configured in code.`,
  );
}

export function buildPoolConfig(
  connection: DatabaseConnection,
  max: number,
): EnvParseResult<PoolConfig> {
  if (!connection.password) {
    // env.ts already requires one; this keeps the ~/.pgpass fallback closed
    // even if a caller builds a connection by hand.
    return { ok: false, errors: ["The database password is missing."] };
  }

  let ssl: PoolConfig["ssl"] = false;
  if (connection.ssl !== false) {
    const { ca } = connection.ssl;
    if (ca !== undefined && !isParsableCaBundle(ca)) {
      return {
        ok: false,
        errors: [
          "DATABASE_SSL_CA contains a certificate that can't be parsed. Check that each PEM block is complete.",
        ],
      };
    }
    ssl =
      ca === undefined
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: true, ca };
  }

  return {
    ok: true,
    value: {
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: connection.password,
      database: connection.database,
      ssl,
      // Also keeps PGOPTIONS out: pg uses the variable only when this is empty.
      options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
      application_name: APPLICATION_NAME,
      client_encoding: "UTF8",
      max,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      maxLifetimeSeconds: MAX_LIFETIME_SECONDS,
    },
  };
}

// Each PEM block must parse as an X.509 certificate. env.ts checks only the
// markers, because it stays free of imports.
function isParsableCaBundle(pem: string): boolean {
  const blocks = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (!blocks) return false;
  try {
    for (const block of blocks) new X509Certificate(block);
    return true;
  } catch {
    return false;
  }
}
