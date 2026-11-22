// Test helpers for Better Auth's real OAuth redirect flow, with no network:
// the provider endpoints Better Auth calls server-side (the code exchange
// and the user profile) are answered by fakeProviderFetch, which a test
// installs as the global fetch. Everything else, including state, cookies,
// token encryption, and the database writes, is Better Auth's own code with
// the app's configuration.
//
// Used by unit tests (in-memory adapter) and by the PostgreSQL integration
// tests (Drizzle adapter on a rolled-back transaction). Never imported by
// application code. All values are fictional.
import type { AuthConfig } from "../env";

export const TEST_ORIGIN = "https://studio.example.com";

export const TEST_AUTH_CONFIG: AuthConfig = {
  secret: "FakeAuthSecretForTestsOnly+0123456789/abcdefXYZ=",
  baseURL: TEST_ORIGIN,
  trustedOrigins: [TEST_ORIGIN],
  secureCookies: true,
  github: { clientId: "gh-fake-client", clientSecret: "gh-fake-secret" },
  google: {
    clientId: "fake-client.apps.googleusercontent.com",
    clientSecret: "g-fake-secret",
  },
};

export type GitHubIdentity = {
  id: number;
  login: string;
  name: string;
  email: string;
  verified?: boolean;
  accessToken: string;
  refreshToken?: string;
};

export type GoogleIdentity = {
  sub: string;
  name: string;
  email: string;
  verified?: boolean;
  accessToken: string;
  refreshToken?: string;
};

export type FakeProviders = {
  github?: GitHubIdentity;
  google?: GoogleIdentity;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

// A structurally valid, unsigned ID token. Better Auth's redirect flow reads
// Google's ID token from the token response (received directly from Google
// over TLS) without verifying a signature, as OpenID Connect allows.
function fakeIdToken(identity: GoogleIdentity, audience: string): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64url({ alg: "RS256", kid: "fake-key", typ: "JWT" }),
    base64url({
      iss: "https://accounts.google.com",
      aud: audience,
      sub: identity.sub,
      email: identity.email,
      email_verified: identity.verified ?? true,
      name: identity.name,
      iat: now,
      exp: now + 3600,
    }),
    Buffer.from("fake-signature").toString("base64url"),
  ].join(".");
}

// The fetch Better Auth sees. Any URL other than the four provider
// endpoints fails the test, so nothing can reach the network.
export function fakeProviderFetch(providers: FakeProviders) {
  const calls: string[] = [];
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    calls.push(`${method} ${url.split("?")[0]}`);
    const { github, google } = providers;
    if (
      github &&
      method === "POST" &&
      url === "https://github.com/login/oauth/access_token"
    ) {
      return json({
        access_token: github.accessToken,
        token_type: "bearer",
        scope: "read:user,user:email",
        ...(github.refreshToken ? { refresh_token: github.refreshToken } : {}),
      });
    }
    if (github && method === "GET" && url === "https://api.github.com/user") {
      return json({
        id: github.id,
        login: github.login,
        name: github.name,
        email: github.email,
        avatar_url: null,
      });
    }
    if (
      github &&
      method === "GET" &&
      url === "https://api.github.com/user/emails"
    ) {
      return json([
        {
          email: github.email,
          primary: true,
          verified: github.verified ?? true,
          visibility: "public",
        },
      ]);
    }
    if (
      google &&
      method === "POST" &&
      url === "https://oauth2.googleapis.com/token"
    ) {
      return json({
        access_token: google.accessToken,
        expires_in: 3599,
        scope: "openid email profile",
        token_type: "Bearer",
        id_token: fakeIdToken(google, TEST_AUTH_CONFIG.google.clientId),
        ...(google.refreshToken ? { refresh_token: google.refreshToken } : {}),
      });
    }
    throw new Error(
      `Unexpected fetch in a test: ${method} ${url.split("?")[0]}`,
    );
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

// The Better Auth handler, as the route serves it.
export type AuthHandler = { handler: (request: Request) => Promise<Response> };

// "name=value; name2=value2" from a response's Set-Cookie headers, skipping
// cookies the response deletes (Max-Age=0).
export function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .filter((cookie) => !/;\s*max-age=0(;|$)/i.test(cookie))
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

export async function startSignIn(
  auth: AuthHandler,
  provider: "github" | "google",
  callbackURL = "/projects",
  // Extra request headers, as a browser behind the app's proxy would send
  // them (for example x-forwarded-for and user-agent).
  headers: Record<string, string> = {},
) {
  const response = await auth.handler(
    new Request(`${TEST_ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        origin: TEST_ORIGIN,
      },
      body: JSON.stringify({ provider, callbackURL }),
    }),
  );
  const body = (await response.json()) as { url?: string; redirect?: boolean };
  const authorizationURL = body.url ? new URL(body.url) : undefined;
  return {
    status: response.status,
    authorizationURL,
    state: authorizationURL?.searchParams.get("state") ?? "",
    cookie: cookiesFrom(response),
  };
}

export async function finishSignIn(
  auth: AuthHandler,
  provider: "github" | "google",
  {
    state,
    cookie,
    code = "fake-authorization-code",
    headers = {},
  }: {
    state: string;
    cookie: string;
    code?: string;
    headers?: Record<string, string>;
  },
) {
  const url = new URL(`${TEST_ORIGIN}/api/auth/callback/${provider}`);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  const response = await auth.handler(
    new Request(url, {
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
    }),
  );
  const location = response.headers.get("location") ?? "";
  const target = location ? new URL(location, TEST_ORIGIN) : undefined;
  return {
    status: response.status,
    location,
    error: target?.searchParams.get("error") ?? undefined,
    cookie: cookiesFrom(response),
  };
}

// The whole flow: sign-in, then the provider's redirect back. `headers` go
// on both requests; the session is created by the callback request.
export async function signInWith(
  auth: AuthHandler,
  provider: "github" | "google",
  headers: Record<string, string> = {},
) {
  const started = await startSignIn(auth, provider, "/projects", headers);
  const finished = await finishSignIn(auth, provider, {
    ...started,
    headers,
  });
  return { started, finished };
}
