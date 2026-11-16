import { describe, expect, test } from "vitest";
import type { DatabaseConnection } from "@/lib/db/env";
import { buildPoolConfig, checkPgEnvironment } from "@/lib/db/pool-config";

const LOCAL: DatabaseConnection = {
  host: "127.0.0.1",
  port: 5432,
  user: "ai_spec_studio_app",
  password: "Fake-password",
  database: "ai_spec_studio_dev",
  ssl: false,
};

describe("buildPoolConfig", () => {
  test("refuses a connection without a password, so ~/.pgpass is never read", () => {
    expect(buildPoolConfig({ ...LOCAL, password: "" }, 10)).toEqual({
      ok: false,
      errors: ["The database password is missing."],
    });
  });

  test("never passes a connection string", () => {
    const result = buildPoolConfig(LOCAL, 10);
    if (!result.ok) throw new Error("Expected a pool config.");
    expect(result.value).not.toHaveProperty("connectionString");
    expect(result.value.ssl).toBe(false);
  });

  test("keeps full verification for TLS connections", () => {
    const result = buildPoolConfig(
      { ...LOCAL, host: "db.example.com", ssl: { rejectUnauthorized: true } },
      10,
    );
    if (!result.ok) throw new Error("Expected a pool config.");
    expect(result.value.ssl).toEqual({ rejectUnauthorized: true });
  });
});

describe("checkPgEnvironment", () => {
  test("accepts an environment without PGBINARY or PGREPLICATION", () => {
    expect(checkPgEnvironment({ PGBINARY: " ", PGREPLICATION: "" })).toEqual(
      [],
    );
  });

  test("names each variable it refuses, never its value", () => {
    const errors = checkPgEnvironment({
      PGBINARY: "true",
      PGREPLICATION: "database",
    });
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).not.toMatch(/true|database\b/);
  });
});
