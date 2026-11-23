// Server-side authentication: Better Auth with GitHub and Google OAuth,
// sessions stored in PostgreSQL through the app's shared Drizzle client.
//
// Nothing happens at import time. getAuth() validates the environment and
// builds the instance on first use (the first request to /api/auth), so
// `next build` never needs auth variables, a database connection, or the
// auth tables. Creating the instance doesn't connect either: the adapter
// queries (and Better Auth's schema check) run per request.
//
// Never log the options or the instance: they hold the secret and the
// OAuth client secrets. Errors from this module name settings, never values.
//
// Before any production deployment, the client-IP header, a shared
// rate-limit store, and secret rotation need their own reviewed changes: see
// "Authentication" in README.md.
import "server-only";

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { getDb, type Database } from "@/lib/db/client";
import { accounts, sessions, users, verifications } from "@/lib/db/schema";
import { siteConfig } from "@/lib/site";
import { parseAuthEnv, type AuthConfig, type AuthEnv } from "./env";

// Rolling sessions: a session expires after 7 days without use, and its
// expiry moves forward at most once a day. Sessions live only in
// PostgreSQL (no cookie cache), so signing out or deleting a session row
// takes effect on the next request.
export const SESSION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;
// How recent a sign-in must be for sensitive actions.
export const SESSION_FRESH_AGE_SECONDS = 60 * 60;

export const AUTH_BASE_PATH = "/api/auth";

// Better Auth endpoints that hand a signed-in browser its decrypted GitHub or
// Google tokens (or refresh them). The app never calls the providers' APIs,
// so these are switched off: a request gets 404 before any handler runs.
// Sign-in, callbacks, sessions, sign-out, and the encrypted tokens stored
// in accounts are unaffected; server code can still use auth.api directly.
export const DISABLED_AUTH_PATHS = [
  "/get-access-token",
  "/refresh-token",
  "/account-info",
];

// Better Auth's singular model names, mapped to the plural tables. Better
// Auth's schema check compares this object's keys and each table's property
// names, nullability, and defaults.
export const AUTH_SCHEMA = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
};

// Client IP addresses are never stored: Better Auth puts the request's IP
// into every new session, and this replaces it with NULL before the insert
// (create.before hooks run, and their data is merged, before the adapter
// writes). IP tracking itself stays on, because the rate limiter keys on
// it: disableIpTracking would turn rate limiting off entirely.
export async function omitSessionIpAddress() {
  return { data: { ipAddress: null } };
}

// Thrown when authentication can't be set up. Its message is safe to log.
export class AuthConfigurationError extends Error {
  override name = "AuthConfigurationError";
}

// The Better Auth options for a validated configuration. Pure: it neither
// reads the environment nor connects.
export function createAuthOptions(config: AuthConfig, db: Database) {
  return {
    appName: siteConfig.name,
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    // Callback and redirect URLs (callbackURL, errorCallbackURL,
    // newUserCallbackURL) must be relative or on one of these origins.
    trustedOrigins: config.trustedOrigins,
    disabledPaths: [...DISABLED_AUTH_PATHS],

    // Until the migration creating these tables is applied, auth queries
    // fail; nothing falls back or bypasses.
    database: drizzleAdapter(db, { provider: "pg", schema: AUTH_SCHEMA }),
    databaseHooks: {
      session: { create: { before: omitSessionIpAddress } },
    },

    emailAndPassword: { enabled: false },
    socialProviders: {
      github: {
        clientId: config.github.clientId,
        clientSecret: config.github.clientSecret,
      },
      google: {
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
      },
    },

    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      freshAge: SESSION_FRESH_AGE_SECONDS,
      cookieCache: { enabled: false },
    },

    account: {
      // No linking at all yet: a sign-in whose email matches an existing
      // user from another provider is refused ("account not linked"), never
      // merged into that user.
      accountLinking: {
        enabled: false,
        disableImplicitLinking: true,
        trustedProviders: [],
        allowDifferentEmails: false,
      },
      // Provider access and refresh tokens are encrypted at rest with the
      // secret.
      encryptOAuthTokens: true,
      // OAuth state lives in the verification table, not in a cookie.
      storeStateStrategy: "database",
      storeAccountCookie: false,
      skipStateCookieCheck: false,
    },

    advanced: {
      useSecureCookies: config.secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      // Both default to off, except that Better Auth skips the origin check
      // in test mode; set them explicitly so no environment weakens them.
      disableCSRFCheck: false,
      disableOriginCheck: false,
      database: {
        // UUID v4 primary keys, like the app's other tables.
        generateId: "uuid",
      },
    },

    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
}

function createAuth(env: AuthEnv) {
  const parsed = parseAuthEnv(env);
  if (!parsed.ok) {
    throw new AuthConfigurationError(
      `The authentication configuration is invalid:\n- ${parsed.errors.join("\n- ")}`,
    );
  }
  return betterAuth(createAuthOptions(parsed.value, getDb()));
}

export type Auth = ReturnType<typeof createAuth>;

// Cached on globalThis, so `next dev` hot reloads reuse the instance.
const AUTH_KEY: unique symbol = Symbol.for("ai-spec-studio.auth");
type AuthCache = typeof globalThis & { [AUTH_KEY]?: Auth };
const cache = globalThis as AuthCache;

// The shared Better Auth instance, created on first use. Throws
// AuthConfigurationError (and DatabaseConfigurationError from getDb) when
// the environment is invalid, and caches nothing in that case.
export function getAuth(): Auth {
  cache[AUTH_KEY] ??= createAuth(process.env);
  return cache[AUTH_KEY];
}
