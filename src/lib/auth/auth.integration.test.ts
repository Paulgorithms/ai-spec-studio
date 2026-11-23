// Better Auth against the test database (npm run test:integration only),
// with the app's own configuration: createAuthOptions builds the Drizzle
// adapter exactly as the app does, bound here to a withRollback transaction
// instead of the app's pool, so every write is rolled back. No network: the
// provider endpoints are answered by fakeProviderFetch, and any other fetch
// fails the test.
//
// Better Auth's follow-up work (session refresh, cleanup of expired rows)
// runs inline and is awaited before each call returns, because the app sets
// no advanced.backgroundTasks handler (asserted below). So nothing Better
// Auth started is still running when withRollback rolls back.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({
  getDb: () => {
    throw new Error(
      "Integration tests must not use the app's database client.",
    );
  },
}));

import { eq, sql } from "drizzle-orm";
import { makeSignature } from "better-auth/crypto";
import { betterAuth } from "better-auth/minimal";
import {
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  createAuthOptions,
} from "@/lib/auth/server";
import {
  TEST_AUTH_CONFIG,
  TEST_ORIGIN,
  fakeProviderFetch,
  finishSignIn,
  signInWith,
  startSignIn,
  type FakeProviders,
} from "@/lib/auth/testing/oauth-flow";
import { recordInserts } from "@/lib/auth/testing/record-inserts";
import { accounts, sessions, users, verifications } from "@/lib/db/schema";
import { withRollback, type TestTransaction } from "@/lib/db/testing";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLIENT_IP = "203.0.113.7"; // a documentation address

// Better Auth with the app's options on one transaction. The recorder shows
// which columns Better Auth sent on each insert.
function authOn(tx: TestTransaction) {
  const recorder = recordInserts(tx);
  const options = createAuthOptions(TEST_AUTH_CONFIG, recorder.db as never);
  if ("backgroundTasks" in options.advanced) {
    throw new Error(
      "A background-task handler would let work outlive the transaction.",
    );
  }
  return { auth: betterAuth(options), inserts: recorder.inserts };
}

type Auth = ReturnType<typeof authOn>["auth"];

// Fictional identities, unique per test.
let counter = 0;
function identities(): Required<FakeProviders> {
  counter += 1;
  const n = `${Date.now().toString(36)}${counter}`;
  return {
    github: {
      id: 1_000_000 + counter,
      login: `ada-${n}`,
      name: "Ada Lovelace",
      email: `Ada-${n}@Example.com`,
      accessToken: `gho_FakeAccess${n}`,
      refreshToken: `ghr_FakeRefresh${n}`,
    },
    google: {
      sub: `10${n}`,
      name: "Ada Lovelace",
      email: `ada-${n}@example.com`,
      accessToken: `ya29.FakeAccess${n}`,
    },
  };
}

function installFakeProviders(providers: FakeProviders) {
  const fake = fakeProviderFetch(providers);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

// Signs a user in through Better Auth's real HTTP OAuth flow, from
// CLIENT_IP, with a fake GitHub identity for `email` (no network). The
// session is created by the callback request, so Better Auth reads the IP
// and user agent from a real request.
let githubIds = 0;
async function createSessionFor(auth: Auth, email: string) {
  githubIds += 1;
  installFakeProviders({
    github: {
      id: 2_000_000 + githubIds,
      login: `grace-${githubIds}`,
      name: "Grace Hopper",
      email,
      accessToken: `gho_FakeIntegration${githubIds}`,
    },
  });
  const { finished } = await signInWith(auth, "github", {
    "x-forwarded-for": CLIENT_IP,
    "user-agent": "Vitest integration",
  });
  if (finished.error) throw new Error(`sign-in failed: ${finished.error}`);
  const ctx = await auth.$context;
  const name = ctx.authCookies.sessionToken.name;
  const cookie = finished.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`));
  const token = decodeURIComponent(cookie?.slice(name.length + 1) ?? "").split(
    ".",
  )[0];
  const found = token ? await ctx.internalAdapter.findSession(token) : null;
  if (!found) throw new Error("no session after sign-in");
  return { ctx, user: found.user, session: found.session };
}

async function cookieFor(
  auth: Auth,
  token: string,
  secret = TEST_AUTH_CONFIG.secret,
) {
  const ctx = await auth.$context;
  const signature = await makeSignature(token, secret);
  return `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
}

const getSession = (auth: Auth, cookie: string) =>
  auth.api.getSession({ headers: new Headers({ cookie }) });

beforeEach(() => {
  // Any fetch outside a test's fake providers fails.
  installFakeProviders({});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Better Auth's schema against PostgreSQL", () => {
  test("the app's options set no background-task handler, so Better Auth awaits its own work", () => {
    const options = createAuthOptions(TEST_AUTH_CONFIG, {} as never);
    expect(options.advanced).not.toHaveProperty("backgroundTasks");
  });

  test("the schema check accepts the real tables, and requests run real queries", async () => {
    await withRollback(async (tx) => {
      const { auth } = authOn(tx);
      const ok = await auth.handler(new Request(`${TEST_ORIGIN}/api/auth/ok`));
      expect(ok.status).toBe(200);
      const none = await auth.handler(
        new Request(`${TEST_ORIGIN}/api/auth/get-session`),
      );
      expect(none.status).toBe(200);
      expect(await none.json()).toBeNull();
      const ctx = await auth.$context;
      await expect(
        ctx.internalAdapter.findUserByEmail("nobody@example.com"),
      ).resolves.toBeNull();
    });
  });
});

describe("users and sessions", () => {
  test("are stored with database-generated UUIDs; Better Auth sends no id", async () => {
    await withRollback(async (tx) => {
      const { auth, inserts } = authOn(tx);
      const email = `grace-${Date.now()}@example.com`;
      const { user, session } = await createSessionFor(auth, email);

      expect(user.id).toMatch(UUID_V4);
      expect(session.id).toMatch(UUID_V4);
      // The OAuth flow writes the state (verification), then the user, the
      // account, and the session.
      expect(inserts.map((i) => i.table).sort()).toEqual([
        "accounts",
        "sessions",
        "users",
        "verifications",
      ]);
      for (const insert of inserts) {
        expect(insert.keys, insert.table).not.toContain("id");
      }

      const [userRow] = await tx
        .select()
        .from(users)
        .where(eq(users.id, user.id));
      expect(userRow).toMatchObject({ email, emailVerified: true });
      const [accountRow] = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.userId, user.id));
      expect(accountRow?.id).toMatch(UUID_V4);
      expect(accountRow?.password).toBeNull();
    });
  });

  test("a session row holds no IP address, the user agent, and a 7-day expiry at millisecond precision", async () => {
    await withRollback(async (tx) => {
      const { auth } = authOn(tx);
      const before = Date.now();
      const { session } = await createSessionFor(
        auth,
        `s-${Date.now()}@example.com`,
      );
      const [row] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, session.id));
      expect(row?.ipAddress).toBeNull();
      expect(row?.userAgent).toBe("Vitest integration");
      expect(row?.token).toBe(session.token);
      const expires = row!.expiresAt.getTime();
      expect(expires).toBeGreaterThanOrEqual(
        before + SESSION_EXPIRES_IN_SECONDS * 1000 - 1000,
      );
      expect(expires).toBeLessThanOrEqual(
        Date.now() + SESSION_EXPIRES_IN_SECONDS * 1000 + 1000,
      );
      const all = await tx.execute<{ ip: number }>(
        sql`select count(*)::int as ip from sessions where ip_address is not null`,
      );
      expect(all.rows[0]?.ip).toBe(0);
    });
  });

  test("a correctly signed cookie validates; a forged or unknown one doesn't", async () => {
    await withRollback(async (tx) => {
      const { auth } = authOn(tx);
      const { user, session } = await createSessionFor(
        auth,
        `c-${Date.now()}@example.com`,
      );
      const valid = await getSession(
        auth,
        await cookieFor(auth, session.token),
      );
      expect(valid?.user.id).toBe(user.id);
      expect(valid?.session.id).toBe(session.id);
      await expect(
        getSession(
          auth,
          await cookieFor(
            auth,
            session.token,
            "a-different-secret-value-0123456789",
          ),
        ),
      ).resolves.toBeNull();
      await expect(
        getSession(auth, await cookieFor(auth, "x".repeat(32))),
      ).resolves.toBeNull();
    });
  });

  test("an expired session doesn't validate, and its row is deleted before the call returns", async () => {
    await withRollback(async (tx) => {
      const { auth } = authOn(tx);
      const { session } = await createSessionFor(
        auth,
        `e-${Date.now()}@example.com`,
      );
      await tx
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(sessions.id, session.id));
      await expect(
        getSession(auth, await cookieFor(auth, session.token)),
      ).resolves.toBeNull();
      const left = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, session.id));
      expect(left).toEqual([]);
    });
  });

  test("a session older than a day is refreshed to a new 7-day expiry, written before the call returns", async () => {
    await withRollback(async (tx) => {
      const { auth } = authOn(tx);
      const { session } = await createSessionFor(
        auth,
        `r-${Date.now()}@example.com`,
      );
      const aged = new Date(
        Date.now() +
          (SESSION_EXPIRES_IN_SECONDS - SESSION_UPDATE_AGE_SECONDS - 60) * 1000,
      );
      await tx
        .update(sessions)
        .set({ expiresAt: aged })
        .where(eq(sessions.id, session.id));
      const before = Date.now();
      const refreshed = await getSession(
        auth,
        await cookieFor(auth, session.token),
      );
      expect(refreshed?.session.id).toBe(session.id);
      const [row] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, session.id));
      expect(row!.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + SESSION_EXPIRES_IN_SECONDS * 1000 - 1000,
      );
    });
  });

  test("signing out revokes the session immediately", async () => {
    await withRollback(async (tx) => {
      const { auth } = authOn(tx);
      const { session } = await createSessionFor(
        auth,
        `o-${Date.now()}@example.com`,
      );
      const cookie = await cookieFor(auth, session.token);
      const response = await auth.handler(
        new Request(`${TEST_ORIGIN}/api/auth/sign-out`, {
          method: "POST",
          headers: {
            cookie,
            origin: TEST_ORIGIN,
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      expect(response.status).toBe(200);
      expect(
        await tx.select().from(sessions).where(eq(sessions.id, session.id)),
      ).toEqual([]);
      await expect(getSession(auth, cookie)).resolves.toBeNull();
    });
  });

  test("deleting a user revokes every session (cascade)", async () => {
    await withRollback(async (tx) => {
      const { auth } = authOn(tx);
      const { user, session } = await createSessionFor(
        auth,
        `d-${Date.now()}@example.com`,
      );
      const cookie = await cookieFor(auth, session.token);
      await tx.delete(users).where(eq(users.id, user.id));
      await expect(getSession(auth, cookie)).resolves.toBeNull();
    });
  });
});

describe("the OAuth flow on PostgreSQL (fake GitHub and Google, no network)", () => {
  test("the state is stored as a verification row and consumed by the callback", async () => {
    const ids = identities();
    installFakeProviders({ github: ids.github });
    await withRollback(async (tx) => {
      const { auth } = authOn(tx);
      const started = await startSignIn(auth, "github");
      expect(started.status).toBe(200);
      const pending = await tx.select().from(verifications);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toMatch(UUID_V4);
      expect(pending[0]?.value).toContain("codeVerifier");

      const finished = await finishSignIn(auth, "github", started);
      expect(finished.status).toBe(302);
      expect(finished.error).toBeUndefined();
      expect(await tx.select().from(verifications)).toEqual([]);
    });
  });

  test("the callback creates the user, account, and session, with encrypted provider tokens", async () => {
    const ids = identities();
    const provider = installFakeProviders({ github: ids.github });
    await withRollback(async (tx) => {
      const { auth } = authOn(tx);
      const { finished } = await signInWith(auth, "github");
      expect(finished.error).toBeUndefined();
      expect(finished.cookie).toContain("__Secure-better-auth.session_token=");

      const email = ids.github.email.toLowerCase();
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.email, email));
      expect(user).toMatchObject({ name: "Ada Lovelace", emailVerified: true });
      const accountRows = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.userId, user!.id));
      expect(accountRows).toHaveLength(1);
      const account = accountRows[0]!;
      expect(account).toMatchObject({
        providerId: "github",
        accountId: String(ids.github.id),
        password: null,
      });
      for (const [stored, plain] of [
        [account.accessToken, ids.github.accessToken],
        [account.refreshToken, ids.github.refreshToken!],
      ] as const) {
        expect(typeof stored).toBe("string");
        expect(stored).not.toContain(plain);
      }
      const leaks = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from accounts
        where access_token like ${`%${ids.github.accessToken}%`}
           or refresh_token like ${`%${ids.github.refreshToken}%`}`);
      expect(leaks.rows[0]?.n).toBe(0);

      const sessionRows = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.userId, user!.id));
      expect(sessionRows).toHaveLength(1);
      expect(sessionRows[0]?.ipAddress).toBeNull();

      // Better Auth decrypts the token for the signed-in user.
      const token = await auth.api.getAccessToken({
        body: { accountId: account.id },
        headers: new Headers({ cookie: finished.cookie }),
      });
      expect(token.accessToken).toBe(ids.github.accessToken);
      const session = await getSession(auth, finished.cookie);
      expect(session?.user.id).toBe(user!.id);
      expect(provider.calls).toEqual([
        "POST https://github.com/login/oauth/access_token",
        "GET https://api.github.com/user",
        "GET https://api.github.com/user/emails",
      ]);
    });
  });

  test("replaying a consumed state is refused and creates no second session", async () => {
    const ids = identities();
    installFakeProviders({ github: ids.github });
    await withRollback(async (tx) => {
      const { auth } = authOn(tx);
      const { started } = await signInWith(auth, "github");
      const replay = await finishSignIn(auth, "github", started);
      expect(replay.error).toBe("state_mismatch");
      expect(replay.cookie).not.toContain("session_token=");
      const count = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from sessions`,
      );
      expect(count.rows[0]?.n).toBe(1);
    });
  });

  test("a state past its 10 minutes is refused", async () => {
    const ids = identities();
    installFakeProviders({ github: ids.github });
    await withRollback(async (tx) => {
      const { auth } = authOn(tx);
      vi.useFakeTimers({ toFake: ["Date"] });
      const started = await startSignIn(auth, "github");
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      const finished = await finishSignIn(auth, "github", started);
      vi.useRealTimers();
      expect(finished.error).toBe("state_mismatch");
      expect(await tx.select().from(users)).toEqual([]);
      expect(await tx.select().from(sessions)).toEqual([]);
    });
  });

  test("no automatic linking: Google with the same email as a GitHub user is refused", async () => {
    const ids = identities();
    installFakeProviders(ids);
    await withRollback(async (tx) => {
      const { auth } = authOn(tx);
      await signInWith(auth, "github");
      const google = await signInWith(auth, "google");
      expect(google.finished.error).toBe("account_not_linked");
      expect(google.finished.cookie).not.toContain("session_token=");
      const rows = await tx.execute<{ provider_id: string }>(
        sql`select provider_id from accounts order by provider_id`,
      );
      expect(rows.rows).toEqual([{ provider_id: "github" }]);
      const counts = await tx.execute<{ users: number; sessions: number }>(sql`
        select (select count(*)::int from users) as users,
               (select count(*)::int from sessions) as sessions`);
      expect(counts.rows[0]).toEqual({ users: 1, sessions: 1 });
    });
  });
});

describe("rollback and cleanup", () => {
  test("nothing Better Auth wrote survives its transaction", async () => {
    const ids = identities();
    installFakeProviders({ github: ids.github });
    const email = ids.github.email.toLowerCase();
    const userId = await withRollback(async (tx) => {
      const { auth } = authOn(tx);
      const { finished } = await signInWith(auth, "github");
      expect(finished.error).toBeUndefined();
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.email, email));
      return user!.id;
    });
    await withRollback(async (tx) => {
      const counts = await tx.execute<Record<string, number>>(sql`
        select (select count(*)::int from users where email = ${email}) as users,
               (select count(*)::int from sessions where user_id = ${userId}::uuid) as sessions,
               (select count(*)::int from accounts where user_id = ${userId}::uuid) as accounts,
               (select count(*)::int from verifications) as verifications`);
      expect(counts.rows[0]).toEqual({
        users: 0,
        sessions: 0,
        accounts: 0,
        verifications: 0,
      });
    });
  });

  test("a failing Better Auth test is rolled back too", async () => {
    const email = `fail-${Date.now()}@example.com`;
    await expect(
      withRollback(async (tx) => {
        const { auth } = authOn(tx);
        await createSessionFor(auth, email);
        throw new Error("the test failed after writing");
      }),
    ).rejects.toThrow("the test failed after writing");
    await withRollback(async (tx) => {
      expect(
        await tx.select().from(users).where(eq(users.email, email)),
      ).toEqual([]);
    });
  });
});
