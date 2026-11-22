import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, test } from "vitest";
import { users, verifications } from "@/lib/db/schema";
import { recordInserts } from "./record-inserts";

// A real Drizzle instance on a fake client: it records the SQL and answers
// every query with no rows. No database is involved.
function fakeDb() {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (config: string | { text: string; values?: unknown[] }) => {
      const text = typeof config === "string" ? config : config.text;
      const values = typeof config === "string" ? undefined : config.values;
      queries.push({ text, values });
      return { rows: [], rowCount: 0, fields: [], command: "INSERT" };
    },
  };
  return { db: drizzle({ client: client as never }), queries };
}

describe("recordInserts", () => {
  test("records each insert's table and keys, and the insert still runs", async () => {
    const { db, queries } = fakeDb();
    const recorder = recordInserts(db);
    await recorder.db
      .insert(users)
      .values({ name: "Ada", email: "ada@example.com" })
      .returning();
    expect(recorder.inserts).toEqual([
      { table: "users", keys: ["name", "email"] },
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toMatch(/^insert into "users"/);
    // An omitted id is sent as DEFAULT, so PostgreSQL generates it.
    expect(queries[0]?.text).toContain('("id", "name", "email"');
    expect(queries[0]?.text).toContain("values (default, $1, $2,");
  });

  test("records multi-row inserts and ignores undefined keys", async () => {
    const { db } = fakeDb();
    const recorder = recordInserts(db);
    await recorder.db.insert(verifications).values([
      { identifier: "a", value: "1", expiresAt: new Date(), id: undefined },
      {
        id: "2ed6657d-e927-568b-95e1-2665a8aea6a2",
        identifier: "b",
        value: "2",
        expiresAt: new Date(),
      },
    ]);
    expect(recorder.inserts).toEqual([
      { table: "verifications", keys: ["identifier", "value", "expiresAt"] },
      {
        table: "verifications",
        keys: ["id", "identifier", "value", "expiresAt"],
      },
    ]);
  });

  test("passes everything else through", async () => {
    const { db, queries } = fakeDb();
    const recorder = recordInserts(db);
    await recorder.db.select().from(users);
    expect(queries[0]?.text).toMatch(/^select /);
    expect(recorder.db._).toBe(db._);
    expect(recorder.inserts).toEqual([]);
  });
});

// Offline proof of what the integration tests check on PostgreSQL: with the
// app's own adapter configuration (createAuthOptions: the Drizzle adapter,
// provider pg, generateId "uuid"), Better Auth sends no id when it creates a
// user, session, account, or verification.
describe("Better Auth on the app's Drizzle adapter", () => {
  test("never sends a primary key; the database generates it", async () => {
    const { vi } = await import("vitest");
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/lib/db/client", () => ({
      getDb: () => {
        throw new Error("not the app's client");
      },
    }));
    const { betterAuth } = await import("better-auth/minimal");
    const { createAuthOptions } = await import("@/lib/auth/server");
    const { TEST_AUTH_CONFIG } = await import("./oauth-flow");
    const { db } = fakeDb();
    const recorder = recordInserts(db);
    const auth = betterAuth(
      createAuthOptions(TEST_AUTH_CONFIG, recorder.db as never),
    );
    const ctx = await auth.$context;
    const attempt = (fn: () => Promise<unknown>) => fn().catch(() => undefined);
    await attempt(() =>
      ctx.internalAdapter.createUser(
        { name: "Ada", email: "ada@example.com", emailVerified: true },
        { method: "oauth", oauth: { providerId: "github" } },
      ),
    );
    await attempt(() =>
      ctx.internalAdapter.createVerificationValue({
        identifier: "state",
        value: "{}",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await attempt(() =>
      ctx.internalAdapter.createAccount({
        userId: "2ed6657d-e927-568b-95e1-2665a8aea6a2",
        providerId: "github",
        accountId: "1",
      }),
    );
    await attempt(() =>
      ctx.internalAdapter.createSession("2ed6657d-e927-568b-95e1-2665a8aea6a2"),
    );
    expect(recorder.inserts.map((i) => i.table).sort()).toEqual([
      "accounts",
      "sessions",
      "users",
      "verifications",
    ]);
    for (const insert of recorder.inserts) {
      expect(insert.keys, insert.table).not.toContain("id");
    }
  });
});
