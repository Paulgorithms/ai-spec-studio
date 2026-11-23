import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BetterAuthOptions } from "better-auth/minimal";

// The database client is replaced by a fake whose every property access is
// recorded, and fetch is stubbed to fail: these tests prove that building
// the auth instance never queries PostgreSQL or calls the network.
const mocks = vi.hoisted(() => {
  const accessed: string[] = [];
  const db = new Proxy(
    {},
    {
      get(_target, property) {
        accessed.push(String(property));
        return undefined;
      },
    },
  );
  const getDb = vi.fn(() => db);
  return { accessed, db, getDb };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ getDb: mocks.getDb }));

// Fictional values made only for these tests.
const SECRET = "FakeAuthSecretForUnitTestsOnly+0123456789/xyzQ=";
const GITHUB_SECRET = "fake0github0client0secret0value0for0tests";
const GOOGLE_SECRET = "GOCSPX-FakeGoogleClientSecretForTests";

const ENV = {
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: "https://studio.example.com",
  BETTER_AUTH_TRUSTED_ORIGINS: "",
  GITHUB_CLIENT_ID: "Ov23liFakeGithubClientId",
  GITHUB_CLIENT_SECRET: GITHUB_SECRET,
  GOOGLE_CLIENT_ID: "1234567890-fakeclientid.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
  BETTER_AUTH_SECRETS: "",
  BETTER_AUTH_TELEMETRY: "",
  BETTER_AUTH_TELEMETRY_ENDPOINT: "",
};

const AUTH_KEY = Symbol.for("ai-spec-studio.auth");

function stubAuthEnv(overrides: Record<string, string> = {}) {
  for (const [name, value] of Object.entries({ ...ENV, ...overrides })) {
    vi.stubEnv(name, value);
  }
}

async function loadServer() {
  return import("@/lib/auth/server");
}

const fetchMock = vi.fn(() => {
  throw new Error("fetch must not be called in unit tests.");
});

beforeEach(() => {
  vi.resetModules();
  mocks.accessed.length = 0;
  mocks.getDb.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  delete (globalThis as Record<symbol, unknown>)[AUTH_KEY];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete (globalThis as Record<symbol, unknown>)[AUTH_KEY];
});

describe("importing the module", () => {
  test("reads no environment, creates no instance, and touches no database", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    await loadServer();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.accessed).toEqual([]);
    expect((globalThis as Record<symbol, unknown>)[AUTH_KEY]).toBeUndefined();
  });
});

describe("getAuth", () => {
  test("fails closed with a safe message when the environment is invalid", async () => {
    stubAuthEnv({
      BETTER_AUTH_SECRET: "too-short",
      BETTER_AUTH_URL: "http://studio.example.com",
      GITHUB_CLIENT_SECRET: "",
    });
    const { getAuth, AuthConfigurationError } = await loadServer();

    let thrown: unknown;
    try {
      getAuth();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AuthConfigurationError);
    const message = (thrown as Error).message;
    expect(message).toContain("BETTER_AUTH_SECRET must be at least 32");
    expect(message).toContain("BETTER_AUTH_URL must use https://");
    expect(message).toContain("GITHUB_CLIENT_SECRET is not set.");
    for (const secret of ["too-short", GOOGLE_SECRET]) {
      expect(message).not.toContain(secret);
    }
    // Nothing is cached and the database is never reached.
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect((globalThis as Record<symbol, unknown>)[AUTH_KEY]).toBeUndefined();
  });

  test("builds one shared instance through the app's database client", async () => {
    stubAuthEnv();
    const { getAuth } = await loadServer();
    const auth = getAuth();
    expect(getAuth()).toBe(auth);
    expect(mocks.getDb).toHaveBeenCalledTimes(1);
  });

  test("initializes without querying the database or calling the network", async () => {
    stubAuthEnv();
    const { getAuth } = await loadServer();
    await getAuth().$context;
    expect(mocks.accessed).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("passes Better Auth's schema check and serves requests without querying", async () => {
    stubAuthEnv();
    const { getAuth } = await loadServer();
    const auth = getAuth();
    // Rejects with a "Drizzle schema mismatch" error if the mapping is
    // incomplete.
    await expect(
      Promise.resolve((await auth.$context).explicitSchemaCheck?.()),
    ).resolves.toBeUndefined();
    for (const path of ["ok", "get-session"]) {
      const response = await auth.handler(
        new Request(`https://studio.example.com/api/auth/${path}`),
      );
      expect(response.status).toBe(200);
    }
    // No session cookie, so nothing reached the database.
    expect(mocks.accessed).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AUTH_SCHEMA", () => {
  test("maps Better Auth's singular models to the plural tables", async () => {
    const { AUTH_SCHEMA } = await loadServer();
    const schema = await import("@/lib/db/schema");
    expect(AUTH_SCHEMA).toEqual({
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    });
  });

  test("covers exactly the models Better Auth expects", async () => {
    stubAuthEnv();
    const { AUTH_SCHEMA, getAuth } = await loadServer();
    const ctx = await getAuth().$context;
    expect(Object.keys(AUTH_SCHEMA).sort()).toEqual(
      Object.keys(ctx.tables).sort(),
    );
  });

  test("an incomplete mapping fails the schema check", async () => {
    stubAuthEnv();
    const { createAuthOptions } = await loadServer();
    const { parseAuthEnv } = await import("@/lib/auth/env");
    const { drizzleAdapter } = await import("@better-auth/drizzle-adapter");
    const { betterAuth } = await import("better-auth/minimal");
    const schema = await import("@/lib/db/schema");
    const parsed = parseAuthEnv(process.env);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const auth = betterAuth({
      ...createAuthOptions(parsed.value, mocks.db as never),
      database: drizzleAdapter(mocks.db, {
        provider: "pg",
        schema: { user: schema.users, session: schema.sessions },
      }),
    });
    await expect(
      Promise.resolve((await auth.$context).explicitSchemaCheck?.()),
    ).rejects.toThrow(/schema mismatch[\s\S]*account, verification/i);
  });
});

describe("resolved Better Auth configuration", () => {
  async function resolvedContext(overrides: Record<string, string> = {}) {
    stubAuthEnv(overrides);
    const { getAuth } = await loadServer();
    return getAuth().$context;
  }

  test("uses the validated secret and origin", async () => {
    const ctx = await resolvedContext();
    expect(ctx.secret).toBe(SECRET);
    expect(ctx.baseURL).toBe("https://studio.example.com/api/auth");
    expect(ctx.options.baseURL).toBe("https://studio.example.com");
  });

  test("offers exactly GitHub and Google OAuth", async () => {
    const ctx = await resolvedContext();
    expect(ctx.socialProviders.map((provider) => provider.id).sort()).toEqual([
      "github",
      "google",
    ]);
  });

  test("disables email and password authentication", async () => {
    const ctx = await resolvedContext();
    expect(ctx.options.emailAndPassword?.enabled).toBe(false);
  });

  test("never links accounts automatically by email", async () => {
    const ctx = await resolvedContext();
    const linking = ctx.options.account?.accountLinking;
    expect(linking?.enabled).toBe(false);
    expect(linking?.disableImplicitLinking).toBe(true);
    expect(linking?.allowDifferentEmails).toBe(false);
    expect(ctx.trustedProviders).toEqual([]);
  });

  test("keeps sessions in the database with conservative lifetimes", async () => {
    const {
      SESSION_EXPIRES_IN_SECONDS,
      SESSION_FRESH_AGE_SECONDS,
      SESSION_UPDATE_AGE_SECONDS,
    } = await loadServer();
    expect(SESSION_EXPIRES_IN_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(24 * 60 * 60);
    expect(SESSION_FRESH_AGE_SECONDS).toBe(60 * 60);

    const ctx = await resolvedContext();
    expect(ctx.sessionConfig.expiresIn).toBe(SESSION_EXPIRES_IN_SECONDS);
    expect(ctx.sessionConfig.updateAge).toBe(SESSION_UPDATE_AGE_SECONDS);
    expect(ctx.sessionConfig.freshAge).toBe(SESSION_FRESH_AGE_SECONDS);
    expect(ctx.options.session?.cookieCache?.enabled).toBe(false);
    expect(ctx.oauthConfig.storeStateStrategy).toBe("database");
    expect(ctx.oauthConfig.skipStateCookieCheck).toBe(false);
    expect(ctx.options.account?.storeAccountCookie).toBe(false);
    expect(ctx.options.account?.encryptOAuthTokens).toBe(true);
    expect(ctx.adapter.id).toBe("drizzle");
  });

  test("uses Secure, HttpOnly, SameSite=Lax session cookies over HTTPS", async () => {
    const ctx = await resolvedContext();
    const { name, attributes } = ctx.authCookies.sessionToken;
    expect(name).toBe("__Secure-better-auth.session_token");
    expect(attributes).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
  });

  test("drops Secure only for loopback HTTP in local development", async () => {
    const ctx = await resolvedContext({
      NODE_ENV: "development",
      BETTER_AUTH_URL: "http://localhost:3000",
    });
    const { name, attributes } = ctx.authCookies.sessionToken;
    expect(name).toBe("better-auth.session_token");
    expect(attributes).toMatchObject({ secure: false, httpOnly: true });
  });

  test("checks origins and redirects even in test mode", async () => {
    // NODE_ENV is "test" here, where Better Auth would skip the origin
    // check by default.
    const ctx = await resolvedContext({
      BETTER_AUTH_TRUSTED_ORIGINS: "https://preview.example.com",
    });
    expect(ctx.skipOriginCheck).toBe(false);
    expect(ctx.skipCSRFCheck).toBe(false);

    expect(ctx.isTrustedOrigin("https://studio.example.com/projects")).toBe(
      true,
    );
    expect(ctx.isTrustedOrigin("https://preview.example.com/")).toBe(true);
    for (const url of [
      "https://evil.example/callback",
      "https://studio.example.com.evil.example/",
      "http://studio.example.com/",
      "https://sub.studio.example.com/",
      "javascript:alert(1)",
    ]) {
      expect(ctx.isTrustedOrigin(url)).toBe(false);
    }
    expect(ctx.isTrustedOrigin("/projects", { allowRelativePaths: true })).toBe(
      true,
    );
    expect(
      ctx.isTrustedOrigin("//evil.example/", { allowRelativePaths: true }),
    ).toBe(false);
  });

  test("turns telemetry off and adds no plugins", async () => {
    const ctx = await resolvedContext();
    expect(ctx.options.telemetry?.enabled).toBe(false);
    expect(ctx.hasPlugin("two-factor")).toBe(false);
    expect(ctx.hasPlugin("passkey")).toBe(false);
    expect(ctx.hasPlugin("organization")).toBe(false);
  });

  test("drops session IPs through a hook, keeping IP tracking for rate limits", async () => {
    const { omitSessionIpAddress } = await loadServer();
    const options: BetterAuthOptions = (await resolvedContext()).options;
    expect(options.databaseHooks?.session?.create?.before).toBe(
      omitSessionIpAddress,
    );
    expect(options.advanced?.ipAddress?.disableIpTracking).toBeUndefined();
    expect(options.rateLimit).toBeUndefined();
  });

  test("generates UUID primary keys", async () => {
    const ctx = await resolvedContext();
    expect(ctx.generateId({ model: "user" })).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("createAuthOptions", () => {
  test("declares no plugins and no bypasses", async () => {
    const { createAuthOptions } = await loadServer();
    const options = createAuthOptions(
      {
        secret: SECRET,
        baseURL: "https://studio.example.com",
        trustedOrigins: ["https://studio.example.com"],
        secureCookies: true,
        github: { clientId: "gh", clientSecret: GITHUB_SECRET },
        google: { clientId: "g", clientSecret: GOOGLE_SECRET },
      },
      mocks.db as never,
    );
    expect(options).not.toHaveProperty("plugins");
    expect(options.advanced.disableCSRFCheck).toBe(false);
    expect(options.advanced.disableOriginCheck).toBe(false);
    expect(options.advanced.useSecureCookies).toBe(true);
    expect(options.account.skipStateCookieCheck).toBe(false);
    expect(mocks.accessed).toEqual([]);
  });
});
