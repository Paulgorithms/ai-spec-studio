import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Sessions created by the real Better Auth internals, with only the database
// swapped for Better Auth's in-memory adapter: no PostgreSQL, no network.
// The rest of the configuration (hooks, cookies, secret) is the app's own.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({
  getDb: () => {
    throw new Error("These tests must not use the app's database client.");
  },
}));

import { memoryAdapter } from "better-auth/adapters/memory";
import { makeSignature } from "better-auth/crypto";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import type { AuthConfig } from "@/lib/auth/env";
import {
  SESSION_EXPIRES_IN_SECONDS,
  createAuthOptions,
  omitSessionIpAddress,
} from "@/lib/auth/server";
import { fakeProviderFetch, signInWith } from "@/lib/auth/testing/oauth-flow";

// Fictional values made only for these tests. 203.0.113.0/24 and
// 198.51.100.0/24 are documentation address ranges.
const CLIENT_IP = "203.0.113.7";
const OTHER_IP = "198.51.100.9";
const CONFIG: AuthConfig = {
  secret: "FakeAuthSecretForUnitTestsOnly+0123456789/xyzQ=",
  baseURL: "https://studio.example.com",
  trustedOrigins: ["https://studio.example.com"],
  secureCookies: true,
  github: { clientId: "gh-fake", clientSecret: "gh-fake-secret" },
  google: {
    clientId: "fake.apps.googleusercontent.com",
    clientSecret: "g-fake-secret",
  },
};

type MemoryStore = Record<string, Record<string, unknown>[]>;

function createTestAuth(overrides: Partial<BetterAuthOptions> = {}) {
  const store: MemoryStore = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  const options = {
    ...createAuthOptions(CONFIG, {} as never),
    database: memoryAdapter(store),
    ...overrides,
  };
  return { auth: betterAuth(options), store };
}

type TestAuth = ReturnType<typeof createTestAuth>["auth"];

// Signs in through Better Auth's real HTTP OAuth flow (sign-in, then the
// provider's redirect back), from CLIENT_IP, with fake GitHub endpoints. The
// session is created by the callback request, so Better Auth reads the
// client's IP and user agent from a real request.
async function signIn(auth: TestAuth) {
  vi.stubGlobal(
    "fetch",
    fakeProviderFetch({
      github: {
        id: 1234567,
        login: "ada",
        name: "Ada",
        email: "Ada@Example.com",
        accessToken: "gho_FakeSessionIpTestToken",
      },
    }).fetch,
  );
  const { finished } = await signInWith(auth, "github", {
    "x-forwarded-for": CLIENT_IP,
    "user-agent": "Vitest session test",
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

async function sessionCookie(auth: TestAuth, token: string) {
  const ctx = await auth.$context;
  const signature = await makeSignature(token, CONFIG.secret);
  const value = encodeURIComponent(`${token}.${signature}`);
  return `${ctx.authCookies.sessionToken.name}=${value}`;
}

const fetchMock = vi.fn(() => {
  throw new Error("fetch must not be called in unit tests.");
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session IP addresses", () => {
  test("the hook only replaces ipAddress, with null", async () => {
    await expect(omitSessionIpAddress()).resolves.toEqual({
      data: { ipAddress: null },
    });
  });

  test("a new session is persisted with a NULL IP address", async () => {
    const { auth, store } = createTestAuth();
    const { session } = await signIn(auth);

    expect(store.session).toHaveLength(1);
    expect(store.session[0]?.ipAddress).toBeNull();
    expect(session.ipAddress).toBeNull();
    // The rest of the session is Better Auth's own.
    expect(store.session[0]?.userAgent).toBe("Vitest session test");
    expect(JSON.stringify(store)).not.toContain(CLIENT_IP);
  });

  test("control: without the hook, the request IP would be stored", async () => {
    // Proves the request context really carried an IP, so the test above
    // checks the hook, not a missing header.
    const { auth, store } = createTestAuth({ databaseHooks: undefined });
    await signIn(auth);
    expect(store.session[0]?.ipAddress).toBe(CLIENT_IP);
  });
});

describe("session security with the hook", () => {
  test("keeps Better Auth's token, owner, and expiry", async () => {
    const { auth, store } = createTestAuth();
    const before = Date.now();
    const { user, session } = await signIn(auth);

    expect(session.userId).toBe(user.id);
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(store.session[0]?.token).toBe(session.token);
    const expiresAt = new Date(session.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + SESSION_EXPIRES_IN_SECONDS * 1000 - 1000,
    );
    expect(expiresAt).toBeLessThanOrEqual(
      Date.now() + SESSION_EXPIRES_IN_SECONDS * 1000 + 1000,
    );
  });

  test("a correctly signed session cookie validates", async () => {
    const { auth } = createTestAuth();
    const { user, session } = await signIn(auth);
    const result = await auth.api.getSession({
      headers: new Headers({
        cookie: await sessionCookie(auth, session.token),
      }),
    });
    expect(result?.user.id).toBe(user.id);
    expect(result?.user.email).toBe("ada@example.com");
    expect(result?.session.token).toBe(session.token);
  });

  test("a cookie with a forged signature is rejected", async () => {
    const { auth } = createTestAuth();
    const { ctx, session } = await signIn(auth);
    const forged = `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(
      `${session.token}.${await makeSignature(session.token, "a-different-secret-value-0123456789")}`,
    )}`;
    await expect(
      auth.api.getSession({ headers: new Headers({ cookie: forged }) }),
    ).resolves.toBeNull();
  });

  test("a revoked session stops validating immediately", async () => {
    const { auth } = createTestAuth();
    const { ctx, session } = await signIn(auth);
    const cookie = await sessionCookie(auth, session.token);
    await ctx.internalAdapter.deleteSession(session.token);
    await expect(
      auth.api.getSession({ headers: new Headers({ cookie }) }),
    ).resolves.toBeNull();
  });
});

describe("rate limiting", () => {
  test("the app leaves IP tracking and Better Auth's rate-limit default alone", () => {
    const options = createAuthOptions(CONFIG, {} as never);
    // Better Auth enables rate limiting when NODE_ENV is production; this
    // configuration overrides neither that nor IP tracking.
    expect(options).not.toHaveProperty("rateLimit");
    expect(options.advanced).not.toHaveProperty("ipAddress");
  });

  async function hitOk(auth: TestAuth, ip: string) {
    const response = await auth.handler(
      new Request("https://studio.example.com/api/auth/ok", {
        headers: { "x-forwarded-for": ip },
      }),
    );
    return response.status;
  }

  // Better Auth reads NODE_ENV once, at import, so a test can't switch it to
  // production; rateLimit.enabled is set here to run the real limiter with
  // the app's otherwise unchanged configuration.
  test("the limiter still keys on the client IP and returns 429", async () => {
    const { auth } = createTestAuth({
      rateLimit: { enabled: true, window: 60, max: 3 },
    });
    for (let i = 0; i < 3; i++) expect(await hitOk(auth, CLIENT_IP)).toBe(200);
    expect(await hitOk(auth, CLIENT_IP)).toBe(429);
    // Another client has its own budget.
    expect(await hitOk(auth, OTHER_IP)).toBe(200);
  });

  test("control: disableIpTracking would switch the limiter off", async () => {
    const { auth } = createTestAuth({
      rateLimit: { enabled: true, window: 60, max: 3 },
      advanced: {
        ...createAuthOptions(CONFIG, {} as never).advanced,
        ipAddress: { disableIpTracking: true },
      },
    });
    for (let i = 0; i < 6; i++) expect(await hitOk(auth, CLIENT_IP)).toBe(200);
  });
});
