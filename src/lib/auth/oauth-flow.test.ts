import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Better Auth's real OAuth redirect flow with the app's configuration, on the
// in-memory adapter: no PostgreSQL and no network (the provider endpoints
// are answered by fakeProviderFetch). The integration tests run the same
// flow on PostgreSQL (auth.integration.test.ts).
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({
  getDb: () => {
    throw new Error("These tests must not use the app's database client.");
  },
}));

import { memoryAdapter } from "better-auth/adapters/memory";
import { betterAuth } from "better-auth/minimal";
import {
  DISABLED_AUTH_PATHS,
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

type Store = Record<string, Record<string, unknown>[]>;

const ADA_GITHUB = {
  id: 4242,
  login: "ada",
  name: "Ada Lovelace",
  email: "Ada@Example.com",
  accessToken: "gho_FakeAccessTokenForTests0123456789",
  refreshToken: "ghr_FakeRefreshTokenForTests0123456789",
};
const ADA_GOOGLE = {
  sub: "109876543210987654321",
  name: "Ada Lovelace",
  email: "ada@example.com",
  accessToken: "ya29.FakeGoogleAccessToken0123456789",
};

function setup(providers: FakeProviders = { github: ADA_GITHUB }) {
  const store: Store = { user: [], session: [], account: [], verification: [] };
  const provider = fakeProviderFetch(providers);
  vi.stubGlobal("fetch", provider.fetch);
  const auth = betterAuth({
    ...createAuthOptions(TEST_AUTH_CONFIG, {} as never),
    database: memoryAdapter(store),
  });
  return { auth, store, calls: provider.calls };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signing in with GitHub", () => {
  test("stores the OAuth state as a verification row and a signed cookie", async () => {
    const { auth, store } = setup();
    const started = await startSignIn(auth, "github");
    expect(started.status).toBe(200);
    expect(started.authorizationURL?.origin).toBe("https://github.com");
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(started.cookie).toContain("__Secure-better-auth.state=");
    expect(store.verification).toHaveLength(1);
    // The row holds the state data, not the provider's tokens.
    expect(String(store.verification[0]?.value)).toContain("codeVerifier");
  });

  test("the callback consumes the state and creates the user, account, and session", async () => {
    const { auth, store, calls } = setup();
    const { finished } = await signInWith(auth, "github");
    expect(finished.status).toBe(302);
    expect(finished.error).toBeUndefined();
    expect(new URL(finished.location, "https://x.test").pathname).toBe(
      "/projects",
    );
    expect(finished.cookie).toContain("__Secure-better-auth.session_token=");

    expect(store.verification).toHaveLength(0);
    expect(store.user).toHaveLength(1);
    expect(store.user[0]).toMatchObject({
      email: "ada@example.com",
      name: "Ada Lovelace",
      emailVerified: true,
    });
    expect(store.account).toHaveLength(1);
    expect(store.account[0]).toMatchObject({
      providerId: "github",
      accountId: "4242",
      userId: store.user[0]?.id,
    });
    // No password is ever set (the column must stay NULL in PostgreSQL).
    expect(store.account[0]?.password ?? null).toBeNull();
    expect(store.session).toHaveLength(1);
    expect(store.session[0]?.ipAddress).toBeNull();

    // Only the provider's endpoints were called.
    expect(calls).toEqual([
      "POST https://github.com/login/oauth/access_token",
      "GET https://api.github.com/user",
      "GET https://api.github.com/user/emails",
    ]);
  });

  test("provider tokens are stored encrypted and read back decrypted", async () => {
    const { auth, store } = setup();
    const { finished } = await signInWith(auth, "github");
    const account = store.account[0]!;
    for (const field of ["accessToken", "refreshToken"] as const) {
      expect(typeof account[field]).toBe("string");
      expect(account[field]).not.toContain(ADA_GITHUB[field]);
    }
    expect(JSON.stringify(store)).not.toContain(ADA_GITHUB.accessToken);
    expect(JSON.stringify(store)).not.toContain(ADA_GITHUB.refreshToken);

    const token = await auth.api.getAccessToken({
      body: { accountId: String(account.id) },
      headers: new Headers({ cookie: finished.cookie }),
    });
    expect(token.accessToken).toBe(ADA_GITHUB.accessToken);
  });

  test("the session cookie from the callback validates", async () => {
    const { auth, store } = setup();
    const { finished } = await signInWith(auth, "github");
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: finished.cookie }),
    });
    expect(session?.user.id).toBe(store.user[0]?.id);
    expect(session?.session.token).toBe(store.session[0]?.token);
  });

  test("replaying the callback is refused and creates no second session", async () => {
    const { auth, store } = setup();
    const { started } = await signInWith(auth, "github");
    const replay = await finishSignIn(auth, "github", started);
    expect(replay.status).toBe(302);
    expect(replay.error).toBe("state_mismatch");
    expect(replay.cookie).not.toContain("session_token=");
    expect(store.session).toHaveLength(1);
    expect(store.account).toHaveLength(1);
  });

  test("a callback without the state cookie is refused and creates nothing", async () => {
    const { auth, store } = setup();
    const started = await startSignIn(auth, "github");
    const finished = await finishSignIn(auth, "github", {
      state: started.state,
      cookie: "",
    });
    expect(finished.error).toBe("state_mismatch");
    expect(store.user).toHaveLength(0);
    expect(store.session).toHaveLength(0);
  });

  test("an unknown state is refused", async () => {
    const { auth, store } = setup();
    const started = await startSignIn(auth, "github");
    const finished = await finishSignIn(auth, "github", {
      state: "x".repeat(32),
      cookie: started.cookie,
    });
    expect(finished.error).toBe("state_mismatch");
    expect(store.user).toHaveLength(0);
  });

  test("a state older than its 10 minutes is refused, and no session is created", async () => {
    const { auth, store } = setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const started = await startSignIn(auth, "github");
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      const finished = await finishSignIn(auth, "github", started);
      expect(finished.error).toBe("state_mismatch");
      expect(store.user).toHaveLength(0);
      expect(store.session).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("signing in again with the same GitHub identity reuses the user and account", async () => {
    const { auth, store } = setup();
    await signInWith(auth, "github");
    const again = await signInWith(auth, "github");
    expect(again.finished.error).toBeUndefined();
    expect(store.user).toHaveLength(1);
    expect(store.account).toHaveLength(1);
    expect(store.session).toHaveLength(2);
  });
});

describe("after signing in", () => {
  test("signing out (POST with the origin) deletes the session", async () => {
    const { auth, store } = setup();
    const { finished } = await signInWith(auth, "github");
    const response = await auth.handler(
      new Request(`${TEST_ORIGIN}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          cookie: finished.cookie,
          origin: TEST_ORIGIN,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    expect(store.session).toHaveLength(0);
    await expect(
      auth.api.getSession({
        headers: new Headers({ cookie: finished.cookie }),
      }),
    ).resolves.toBeNull();
  });

  test("signing out from another origin is refused", async () => {
    const { auth, store } = setup();
    const { finished } = await signInWith(auth, "github");
    const response = await auth.handler(
      new Request(`${TEST_ORIGIN}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          cookie: finished.cookie,
          origin: "https://evil.example.net",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
    expect(store.session).toHaveLength(1);
  });

  test("a session older than a day is refreshed to a new 7-day expiry before the call returns", async () => {
    const { auth, store } = setup();
    const { finished } = await signInWith(auth, "github");
    store.session[0]!.expiresAt = new Date(
      Date.now() +
        (SESSION_EXPIRES_IN_SECONDS - SESSION_UPDATE_AGE_SECONDS - 60) * 1000,
    );
    const before = Date.now();
    await auth.api.getSession({
      headers: new Headers({ cookie: finished.cookie }),
    });
    expect(
      new Date(store.session[0]!.expiresAt as Date).getTime(),
    ).toBeGreaterThanOrEqual(before + SESSION_EXPIRES_IN_SECONDS * 1000 - 1000);
  });
});

describe("provider-token endpoints are switched off", () => {
  async function signedIn() {
    const context = setup();
    const { finished } = await signInWith(context.auth, "github");
    const accountId = String(context.store.account[0]?.id);
    return { ...context, cookie: finished.cookie, accountId };
  }

  const call = (
    auth: ReturnType<typeof setup>["auth"],
    path: string,
    method: "GET" | "POST",
    cookie: string,
    accountId: string,
  ) =>
    auth.handler(
      new Request(`${TEST_ORIGIN}/api/auth${path}`, {
        method,
        headers: {
          cookie,
          origin: TEST_ORIGIN,
          "content-type": "application/json",
        },
        ...(method === "POST" ? { body: JSON.stringify({ accountId }) } : {}),
      }),
    );

  test("the configuration disables exactly the three token endpoints", () => {
    expect(DISABLED_AUTH_PATHS).toEqual([
      "/get-access-token",
      "/refresh-token",
      "/account-info",
    ]);
    expect(
      createAuthOptions(TEST_AUTH_CONFIG, {} as never).disabledPaths,
    ).toEqual(DISABLED_AUTH_PATHS);
  });

  test.each([
    ["/get-access-token", "POST"],
    ["/refresh-token", "POST"],
    ["/account-info", "GET"],
    ["/account-info?accountId=x", "GET"],
  ] as const)(
    "%s returns 404 to a signed-in browser, before any handler runs",
    async (path, method) => {
      const { auth, cookie, accountId } = await signedIn();
      const response = await call(auth, path, method, cookie, accountId);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(ADA_GITHUB.accessToken);
    },
  );

  // Path spellings that might slip past an exact match. None may reach an
  // endpoint that returns the token.
  test.each([
    ["/get-access-token/", "POST"],
    ["//get-access-token", "POST"],
    ["/./get-access-token", "POST"],
    ["/x/../get-access-token", "POST"],
    ["/GET-ACCESS-TOKEN", "POST"],
    ["/get%2Daccess%2Dtoken", "POST"],
    ["/get-access-token%2F", "POST"],
    ["/refresh-token/", "POST"],
    ["/account-info/", "GET"],
    ["/Account-Info", "GET"],
  ] as const)(
    "the variant %s never returns the token",
    async (path, method) => {
      const { auth, cookie, accountId } = await signedIn();
      const response = await call(auth, path, method, cookie, accountId);
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain(ADA_GITHUB.accessToken);
    },
  );

  test("sign-in, sessions, encrypted storage, and sign-out still work", async () => {
    const { auth, store, cookie } = await signedIn();
    expect(store.account[0]?.accessToken).not.toContain(ADA_GITHUB.accessToken);
    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(session?.user.email).toBe("ada@example.com");
    const accounts = await auth.handler(
      new Request(`${TEST_ORIGIN}/api/auth/list-accounts`, {
        headers: { cookie },
      }),
    );
    expect(accounts.status).toBe(200);
    expect(await accounts.text()).not.toContain(ADA_GITHUB.accessToken);
    const out = await auth.handler(
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
    expect(out.status).toBe(200);
    expect(store.session).toHaveLength(0);
  });
});

describe("no automatic account linking", () => {
  test("Google with the same verified email as a GitHub user is refused", async () => {
    const { auth, store, calls } = setup({
      github: ADA_GITHUB,
      google: ADA_GOOGLE,
    });
    await signInWith(auth, "github");
    const google = await signInWith(auth, "google");
    expect(google.finished.error).toBe("account_not_linked");
    expect(google.finished.cookie).not.toContain("session_token=");
    expect(store.user).toHaveLength(1);
    expect(store.account.map((a) => a.providerId)).toEqual(["github"]);
    expect(store.session).toHaveLength(1);
    expect(calls).toContain("POST https://oauth2.googleapis.com/token");
  });

  test("a different email with Google creates a separate user", async () => {
    const { auth, store } = setup({
      github: ADA_GITHUB,
      google: { ...ADA_GOOGLE, email: "grace@example.com", name: "Grace" },
    });
    await signInWith(auth, "github");
    const google = await signInWith(auth, "google");
    expect(google.finished.error).toBeUndefined();
    expect(store.user).toHaveLength(2);
    expect(store.account.map((a) => a.providerId).sort()).toEqual([
      "github",
      "google",
    ]);
  });
});

describe("the fake provider", () => {
  test("refuses any other URL, so tests can't reach the network", async () => {
    const { fetch } = fakeProviderFetch({ github: ADA_GITHUB });
    await expect(fetch("https://example.com/")).rejects.toThrow(
      "Unexpected fetch in a test",
    );
    await expect(
      fetch("https://oauth2.googleapis.com/token", { method: "POST" }),
    ).rejects.toThrow("Unexpected fetch in a test");
  });
});
