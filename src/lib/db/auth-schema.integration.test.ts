// Integration tests for the Better Auth tables (0001_auth_tables), against
// the local test database (npm run test:integration only). Every database
// access goes through withRollback: one transaction per call, always rolled
// back. Expected errors are asserted by SQLSTATE and constraint name with
// expectPgError, inside savepoints, never by message text.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { accounts, sessions, users, verifications } from "@/lib/db/schema";
import {
  expectPgError,
  withRollback,
  type TestTransaction,
} from "@/lib/db/testing";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;
const inAWeek = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

async function insertUser(
  tx: TestTransaction,
  email = `${unique("u")}@example.com`,
) {
  const [row] = await tx
    .insert(users)
    .values({ name: "Test User", email })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

async function insertSession(tx: TestTransaction, userId: string) {
  const [row] = await tx
    .insert(sessions)
    .values({ userId, token: unique("token"), expiresAt: inAWeek() })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

async function insertAccount(
  tx: TestTransaction,
  userId: string,
  providerId = "github",
  accountId = unique("acct"),
) {
  const [row] = await tx
    .insert(accounts)
    .values({ userId, providerId, accountId })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

describe("generated primary keys and defaults", () => {
  test("users: a database-generated UUID v4, email_verified false, image NULL, timestamps now()", async () => {
    await withRollback(async (tx) => {
      const user = await insertUser(tx);
      expect(user.id).toMatch(UUID_V4);
      expect(user.emailVerified).toBe(false);
      expect(user.image).toBeNull();
      const result = await tx.execute<{ matches: boolean; same: boolean }>(sql`
        select created_at = now()::timestamptz(3) as matches,
               created_at = updated_at as same
        from users where id = ${user.id}`);
      expect(result.rows[0]).toEqual({ matches: true, same: true });
    });
  });

  test("sessions, accounts, and verifications get their own UUIDs and timestamps", async () => {
    await withRollback(async (tx) => {
      const user = await insertUser(tx);
      const session = await insertSession(tx, user.id);
      const account = await insertAccount(tx, user.id);
      const [verification] = await tx
        .insert(verifications)
        .values({
          identifier: unique("state"),
          value: "{}",
          expiresAt: inAWeek(),
        })
        .returning();
      const ids = [user.id, session.id, account.id, verification?.id];
      for (const id of ids) expect(id).toMatch(UUID_V4);
      expect(new Set(ids).size).toBe(4);
      for (const row of [session, account, verification]) {
        expect(row?.createdAt).toBeInstanceOf(Date);
        expect(row?.updatedAt).toBeInstanceOf(Date);
      }
    });
  });

  test("optional columns default to NULL: session ip_address and user_agent, every account token", async () => {
    await withRollback(async (tx) => {
      const user = await insertUser(tx);
      const session = await insertSession(tx, user.id);
      expect(session.ipAddress).toBeNull();
      expect(session.userAgent).toBeNull();
      const account = await insertAccount(tx, user.id);
      expect(account).toMatchObject({
        accessToken: null,
        refreshToken: null,
        idToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: null,
        password: null,
      });
    });
  });

  test("an id Better Auth supplies itself (a version 5 UUID) is accepted", async () => {
    await withRollback(async (tx) => {
      const v5 = "2ed6657d-e927-568b-95e1-2665a8aea6a2";
      const [row] = await tx
        .insert(verifications)
        .values({
          id: v5,
          identifier: unique("reserve"),
          value: "x",
          expiresAt: inAWeek(),
        })
        .returning();
      expect(row?.id).toBe(v5);
    });
  });

  test("an id that isn't a UUID is rejected (22P02)", async () => {
    await withRollback(async (tx) => {
      await expectPgError(tx, { code: "22P02" }, (sp) =>
        sp.execute(
          sql`insert into users (id, name, email) values ('not-a-uuid', 'x', ${`${unique("u")}@example.com`})`,
        ),
      );
    });
  });
});

describe("UNIQUE constraints (23505)", () => {
  test("rejects a second user with the same email", async () => {
    await withRollback(async (tx) => {
      const email = `${unique("dup")}@example.com`;
      await insertUser(tx, email);
      await expectPgError(
        tx,
        { code: "23505", constraint: "users_email_unique" },
        (sp) => insertUser(sp, email),
      );
    });
  });

  test("the email UNIQUE is plain (case-sensitive): Better Auth lowercases emails before writing", async () => {
    // Approved decision 10: plain UNIQUE(email), no lower(email) index.
    await withRollback(async (tx) => {
      const local = unique("case");
      await insertUser(tx, `${local}@example.com`);
      await expect(
        insertUser(tx, `${local.toUpperCase()}@EXAMPLE.COM`),
      ).resolves.toMatchObject({ emailVerified: false });
    });
  });

  test("rejects a duplicate session token, even for another user", async () => {
    await withRollback(async (tx) => {
      const a = await insertUser(tx);
      const b = await insertUser(tx);
      const session = await insertSession(tx, a.id);
      await expectPgError(
        tx,
        { code: "23505", constraint: "sessions_token_unique" },
        (sp) =>
          sp.insert(sessions).values({
            userId: b.id,
            token: session.token,
            expiresAt: inAWeek(),
          }),
      );
    });
  });

  test("rejects a second account for the same provider identity, even for another user", async () => {
    await withRollback(async (tx) => {
      const a = await insertUser(tx);
      const b = await insertUser(tx);
      const account = await insertAccount(tx, a.id, "github", unique("gh"));
      await expectPgError(
        tx,
        { code: "23505", constraint: "accounts_provider_id_account_id_unique" },
        (sp) => insertAccount(sp, b.id, "github", account.accountId),
      );
    });
  });

  test("the same account id at another provider is a different identity", async () => {
    await withRollback(async (tx) => {
      const user = await insertUser(tx);
      const id = unique("shared");
      await insertAccount(tx, user.id, "github", id);
      await expect(
        insertAccount(tx, user.id, "google", id),
      ).resolves.toMatchObject({ providerId: "google", accountId: id });
    });
  });

  test("verification identifiers aren't unique (Better Auth keeps several per identifier)", async () => {
    await withRollback(async (tx) => {
      const identifier = unique("state");
      for (let i = 0; i < 2; i++) {
        await tx
          .insert(verifications)
          .values({ identifier, value: String(i), expiresAt: inAWeek() });
      }
      const rows = await tx
        .select()
        .from(verifications)
        .where(eq(verifications.identifier, identifier));
      expect(rows).toHaveLength(2);
    });
  });
});

describe("foreign keys (23503) and cascading deletes", () => {
  test("rejects a session or an account for a user that doesn't exist", async () => {
    await withRollback(async (tx) => {
      const missing = randomUUID();
      await expectPgError(
        tx,
        { code: "23503", constraint: "sessions_user_id_fkey" },
        (sp) => insertSession(sp, missing),
      );
      await expectPgError(
        tx,
        { code: "23503", constraint: "accounts_user_id_fkey" },
        (sp) => insertAccount(sp, missing),
      );
    });
  });

  test("deleting a user deletes its sessions and accounts, and nobody else's", async () => {
    await withRollback(async (tx) => {
      const ada = await insertUser(tx);
      const grace = await insertUser(tx);
      await insertSession(tx, ada.id);
      await insertSession(tx, ada.id);
      await insertAccount(tx, ada.id, "github");
      await insertAccount(tx, ada.id, "google");
      const graceSession = await insertSession(tx, grace.id);
      const graceAccount = await insertAccount(tx, grace.id);

      await tx.delete(users).where(eq(users.id, ada.id));

      const left = await tx.execute<{ sessions: number; accounts: number }>(sql`
        select (select count(*)::int from sessions where user_id = ${ada.id}) as sessions,
               (select count(*)::int from accounts where user_id = ${ada.id}) as accounts`);
      expect(left.rows[0]).toEqual({ sessions: 0, accounts: 0 });
      const kept = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, grace.id));
      expect(kept).toEqual([{ id: graceSession.id }]);
      const keptAccounts = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.userId, grace.id));
      expect(keptAccounts).toEqual([{ id: graceAccount.id }]);
    });
  });

  test("a referenced user's id can't be changed (ON UPDATE NO ACTION)", async () => {
    await withRollback(async (tx) => {
      const user = await insertUser(tx);
      await insertSession(tx, user.id);
      await expectPgError(
        tx,
        { code: "23503", constraint: "sessions_user_id_fkey" },
        (sp) =>
          sp
            .update(users)
            .set({ id: randomUUID() })
            .where(eq(users.id, user.id)),
      );
    });
  });

  test("deleting a session or an account leaves the user", async () => {
    await withRollback(async (tx) => {
      const user = await insertUser(tx);
      const session = await insertSession(tx, user.id);
      const account = await insertAccount(tx, user.id);
      await tx.delete(sessions).where(eq(sessions.id, session.id));
      await tx.delete(accounts).where(eq(accounts.id, account.id));
      const found = await tx.select().from(users).where(eq(users.id, user.id));
      expect(found).toHaveLength(1);
    });
  });
});

describe("the password CHECK (23514)", () => {
  test.each([
    ["a password hash", "$argon2id$v=19$m=65536,t=3,p=4$fake"],
    ["an empty string", ""],
  ])("rejects %s on insert", async (_, password) => {
    await withRollback(async (tx) => {
      const user = await insertUser(tx);
      await expectPgError(
        tx,
        { code: "23514", constraint: "accounts_password_null_check" },
        (sp) =>
          sp.insert(accounts).values({
            userId: user.id,
            providerId: "credential",
            accountId: user.id,
            password,
          }),
      );
    });
  });

  test("rejects setting a password on an existing account", async () => {
    await withRollback(async (tx) => {
      const user = await insertUser(tx);
      const account = await insertAccount(tx, user.id);
      await expectPgError(
        tx,
        { code: "23514", constraint: "accounts_password_null_check" },
        (sp) =>
          sp
            .update(accounts)
            .set({ password: "x" })
            .where(eq(accounts.id, account.id)),
      );
    });
  });
});

describe("NOT NULL (23502)", () => {
  test.each([
    ["users.email", sql`insert into users (name) values ('x')`, "email"],
    [
      "users.name",
      sql`insert into users (email) values ('x@example.com')`,
      "name",
    ],
    [
      "verifications.value",
      sql`insert into verifications (identifier, expires_at) values ('x', now())`,
      "value",
    ],
    [
      "verifications.expires_at",
      sql`insert into verifications (identifier, value) values ('x', 'y')`,
      "expires_at",
    ],
  ])("rejects a missing %s", async (_, statement, column) => {
    await withRollback(async (tx) => {
      const error = await expectPgError(tx, { code: "23502" }, (sp) =>
        sp.execute(statement),
      );
      expect(error.column).toBe(column);
    });
  });

  test.each(["token", "expires_at", "user_id"])(
    "rejects a session without %s",
    async (column) => {
      await withRollback(async (tx) => {
        const user = await insertUser(tx);
        const values = {
          token: sql`${unique("t")}`,
          expires_at: sql`now() + interval '1 day'`,
          user_id: sql`${user.id}::uuid`,
        };
        const columns = Object.keys(values).filter((c) => c !== column);
        const error = await expectPgError(tx, { code: "23502" }, (sp) =>
          sp.execute(
            sql`insert into sessions (${sql.raw(columns.join(", "))}) values (${sql.join(
              columns.map((c) => values[c as keyof typeof values]),
              sql`, `,
            )})`,
          ),
        );
        expect(error.column).toBe(column);
      });
    },
  );

  test.each(["account_id", "provider_id", "user_id"])(
    "rejects an account without %s",
    async (column) => {
      await withRollback(async (tx) => {
        const user = await insertUser(tx);
        const values = {
          account_id: sql`${unique("a")}`,
          provider_id: sql`'github'`,
          user_id: sql`${user.id}::uuid`,
        };
        const columns = Object.keys(values).filter((c) => c !== column);
        const error = await expectPgError(tx, { code: "23502" }, (sp) =>
          sp.execute(
            sql`insert into accounts (${sql.raw(columns.join(", "))}) values (${sql.join(
              columns.map((c) => values[c as keyof typeof values]),
              sql`, `,
            )})`,
          ),
        );
        expect(error.column).toBe(column);
      });
    },
  );
});

// Privileges on all six tables are checked in schema.integration.test.ts.
describe("the auth tables in the catalog (read-only)", () => {
  test("no row-level security, triggers, or rules on them", async () => {
    await withRollback(async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(sql`
        select c.relname::text as name, c.relrowsecurity as rls,
               (select count(*)::int from pg_trigger as t
                where t.tgrelid = c.oid and not t.tgisinternal) as triggers,
               (select count(*)::int from pg_rewrite as r
                where r.ev_class = c.oid) as rules
        from pg_class as c join pg_namespace as n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('accounts', 'sessions', 'users', 'verifications')
        order by c.relname::text collate "C"`);
      expect(result.rows).toEqual(
        ["accounts", "sessions", "users", "verifications"].map((name) => ({
          name,
          rls: false,
          triggers: 0,
          rules: 0,
        })),
      );
    });
  });
});
