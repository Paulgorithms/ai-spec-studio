// The only database Drizzle Kit may connect to in this development phase.
// drizzle.config.ts applies this to every command that connects (db:migrate,
// studio, pull), after parseMigrationDatabaseEnv and before Drizzle Kit opens
// a connection. There is no override: migrating anything else needs the
// remote safeguards first (explicit host and database confirmation, the
// server's environment label, protected credentials).
//
// Pure and import-free apart from env.ts, so Drizzle Kit can load it.
import { isLoopbackHost, type DatabaseConnection } from "./env";

export const APPROVED_MIGRATION_TARGET = {
  port: 5432,
  database: "ai_spec_studio_dev",
  user: "ai_spec_studio_migrator",
} as const;

// One message per mismatch, naming the setting and the approved value, never
// the configured value.
export function checkMigrationTarget(connection: DatabaseConnection): string[] {
  const errors: string[] = [];
  if (!isLoopbackHost(connection.host)) {
    errors.push(
      "DATABASE_MIGRATION_URL must use a loopback host (localhost, 127.0.0.1, or ::1).",
    );
  }
  if (connection.port !== APPROVED_MIGRATION_TARGET.port) {
    errors.push(
      `DATABASE_MIGRATION_URL must use port ${APPROVED_MIGRATION_TARGET.port}.`,
    );
  }
  if (connection.database !== APPROVED_MIGRATION_TARGET.database) {
    errors.push(
      `DATABASE_MIGRATION_URL must name the database ${APPROVED_MIGRATION_TARGET.database}.`,
    );
  }
  if (connection.user !== APPROVED_MIGRATION_TARGET.user) {
    errors.push(
      `DATABASE_MIGRATION_URL must use the role ${APPROVED_MIGRATION_TARGET.user}.`,
    );
  }
  if (connection.ssl !== false) {
    errors.push(
      "The local migration target must use DATABASE_SSL_MODE=disable (TLS off for loopback).",
    );
  }
  return errors;
}
