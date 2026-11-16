import { describe, expect, test } from "vitest";
import { parseMigrationDatabaseEnv, type DatabaseEnv } from "@/lib/db/env";
import { checkMigrationTarget } from "@/lib/db/migration-target";

const PASSWORD = "FakeMigrator-pw";
const url = (
  user = "ai_spec_studio_migrator",
  host = "127.0.0.1",
  port = 5432,
  database = "ai_spec_studio_dev",
) => `postgresql://${user}:${PASSWORD}@${host}:${port}/${database}`;

// Validate as drizzle.config.ts does, then apply the target check.
function targetErrors(env: DatabaseEnv): string[] {
  const parsed = parseMigrationDatabaseEnv(env);
  if (!parsed.ok)
    throw new Error(`Unexpected validator errors: ${parsed.errors}`);
  return checkMigrationTarget(parsed.value.connection);
}

describe("checkMigrationTarget", () => {
  test.each(["127.0.0.1", "localhost", "LOCALHOST", "[::1]", "127.0.0.2"])(
    "accepts the loopback host %s",
    (host) => {
      expect(
        targetErrors({
          DATABASE_MIGRATION_URL: url(undefined, host),
          DATABASE_SSL_MODE: "disable",
        }),
      ).toEqual([]);
    },
  );

  test.each(["db.example.com", "10.0.0.5", "192.168.1.20", "0.0.0.0"])(
    "rejects the remote host %s, even with full TLS verification",
    (host) => {
      expect(
        targetErrors({ DATABASE_MIGRATION_URL: url(undefined, host) }),
      ).toEqual([
        "DATABASE_MIGRATION_URL must use a loopback host (localhost, 127.0.0.1, or ::1).",
        "The local migration target must use DATABASE_SSL_MODE=disable (TLS off for loopback).",
      ]);
    },
  );

  test.each([
    [
      "the test database",
      url(undefined, undefined, undefined, "ai_spec_studio_test"),
      "DATABASE_MIGRATION_URL must name the database ai_spec_studio_dev.",
    ],
    [
      "the postgres database",
      url(undefined, undefined, undefined, "postgres"),
      "DATABASE_MIGRATION_URL must name the database ai_spec_studio_dev.",
    ],
    [
      "the app role",
      url("ai_spec_studio_app"),
      "DATABASE_MIGRATION_URL must use the role ai_spec_studio_migrator.",
    ],
    [
      "the test role",
      url("ai_spec_studio_test"),
      "DATABASE_MIGRATION_URL must use the role ai_spec_studio_migrator.",
    ],
    [
      "the postgres role",
      url("postgres"),
      "DATABASE_MIGRATION_URL must use the role ai_spec_studio_migrator.",
    ],
    [
      "port 5433",
      url(undefined, undefined, 5433),
      "DATABASE_MIGRATION_URL must use port 5432.",
    ],
  ])("rejects %s", (_, migrationUrl, message) => {
    expect(
      targetErrors({
        DATABASE_MIGRATION_URL: migrationUrl,
        DATABASE_SSL_MODE: "disable",
      }),
    ).toEqual([message]);
  });

  test("rejects TLS on the local target (DATABASE_SSL_MODE unset means verify-full)", () => {
    expect(targetErrors({ DATABASE_MIGRATION_URL: url() })).toEqual([
      "The local migration target must use DATABASE_SSL_MODE=disable (TLS off for loopback).",
    ]);
    expect(
      targetErrors({
        DATABASE_MIGRATION_URL: url(),
        DATABASE_SSL_MODE: "verify-full",
      }),
    ).toHaveLength(1);
  });

  test("reports every mismatch at once, without the configured values", () => {
    const errors = targetErrors({
      DATABASE_MIGRATION_URL: url(
        "FakeRole",
        "db.example.com",
        6543,
        "FakeDatabase",
      ),
    });
    expect(errors).toHaveLength(5);
    const text = errors.join("\n");
    for (const value of [
      "FakeRole",
      "db.example.com",
      "6543",
      "FakeDatabase",
      PASSWORD,
    ]) {
      expect(text).not.toContain(value);
    }
  });
});
