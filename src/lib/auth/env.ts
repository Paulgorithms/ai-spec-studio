// Authentication environment validation: pure functions over an env record
// the caller passes in (usually process.env). Like src/lib/db/env.ts, they
// never read process.env, never connect, and never throw.
//
// Error messages name the variable and the rule, never the value: the
// secret and the OAuth client secrets must never reach logs.
//
// Better Auth also reads some variables from process.env by itself, outside
// the options this app passes in. Those are validated (or refused) here, so
// nothing reaches Better Auth unchecked:
// - BETTER_AUTH_SECRETS replaces the configured secret entirely: refused.
// - BETTER_AUTH_TRUSTED_ORIGINS is appended to trustedOrigins on every
//   request: validated as exact origins.
// - BETTER_AUTH_TELEMETRY turns telemetry on even when the options turn it
//   off: refused, along with BETTER_AUTH_TELEMETRY_ENDPOINT.
// - TEST puts Better Auth in test mode (no origin or secret checks, every
//   client IP read as localhost): refused when NODE_ENV is production.

import type { EnvParseResult } from "../db/env";

export type AuthEnv = Readonly<Record<string, string | undefined>>;

export type OAuthClientConfig = { clientId: string; clientSecret: string };

// Holds secrets: never log or serialize it.
export type AuthConfig = {
  secret: string;
  // An origin (scheme, host, and port), with no path or trailing slash.
  baseURL: string;
  // Exact origins: baseURL first, then BETTER_AUTH_TRUSTED_ORIGINS.
  trustedOrigins: string[];
  // True whenever baseURL is HTTPS, which production always requires.
  secureCookies: boolean;
  github: OAuthClientConfig;
  google: OAuthClientConfig;
};

export const MIN_SECRET_LENGTH = 32;
export const MAX_SECRET_LENGTH = 1024;
// Bits, estimated as length × log2(distinct characters). Better Auth uses
// the same estimate but only warns, below 120 bits.
export const MIN_SECRET_ENTROPY_BITS = 128;

// Better Auth's built-in fallback, used when no secret is configured.
const BETTER_AUTH_DEFAULT_SECRET = "better-auth-secret-12345678901234567890";

const GOOGLE_CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

const REFUSED_VARIABLES = [
  {
    name: "BETTER_AUTH_SECRETS",
    reason:
      "It would replace BETTER_AUTH_SECRET, and secret rotation isn't configured.",
  },
  {
    name: "BETTER_AUTH_TELEMETRY",
    reason: "Telemetry is configured in code and stays off.",
  },
  {
    name: "BETTER_AUTH_TELEMETRY_ENDPOINT",
    reason: "Telemetry is configured in code and stays off.",
  },
] as const;

export function parseAuthEnv(env: AuthEnv): EnvParseResult<AuthConfig> {
  const isProduction = env.NODE_ENV === "production";
  const errors: string[] = [];

  for (const { name, reason } of REFUSED_VARIABLES) {
    if (env[name]?.trim()) errors.push(`${name} must not be set. ${reason}`);
  }
  if (isProduction && env.TEST?.trim()) {
    errors.push(
      "TEST must not be set when NODE_ENV is production. Better Auth treats it as test mode.",
    );
  }
  errors.push(...checkPublicSecrets(env));

  const secret = parseSecret(env.BETTER_AUTH_SECRET);
  const baseURL = parseOrigin("BETTER_AUTH_URL", env.BETTER_AUTH_URL, {
    isProduction,
  });
  const extraOrigins = parseTrustedOrigins(env.BETTER_AUTH_TRUSTED_ORIGINS, {
    isProduction,
  });
  const github = parseOAuthClient(env, "GITHUB");
  const google = parseOAuthClient(env, "GOOGLE");
  if (google.ok && !google.value.clientId.endsWith(GOOGLE_CLIENT_ID_SUFFIX)) {
    errors.push(
      `GOOGLE_CLIENT_ID must be a web client ID ending in ${GOOGLE_CLIENT_ID_SUFFIX}.`,
    );
  }

  for (const result of [secret, baseURL, extraOrigins, github, google]) {
    if (!result.ok) errors.push(...result.errors);
  }
  if (
    errors.length > 0 ||
    !secret.ok ||
    !baseURL.ok ||
    !extraOrigins.ok ||
    !github.ok ||
    !google.ok
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      secret: secret.value,
      baseURL: baseURL.value,
      trustedOrigins: [...new Set([baseURL.value, ...extraOrigins.value])],
      secureCookies: baseURL.value.startsWith("https://"),
      github: github.value,
      google: google.value,
    },
  };
}

// An exact origin: http(s), a host, an optional port, and nothing else.
// HTTPS is required, except http:// on a loopback host outside production
// (local development).
export function parseOrigin(
  name: string,
  raw: string | undefined,
  { isProduction }: { isProduction: boolean },
): EnvParseResult<string> {
  if (raw === undefined || !raw.trim()) return fail(`${name} is not set.`);
  if (raw !== raw.trim() || /\s/.test(raw) || hasControlCharacter(raw)) {
    return fail(`${name} must not contain spaces or control characters.`);
  }
  if (raw.includes("*")) {
    return fail(`${name} must be an exact origin. Wildcards aren't allowed.`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`${name} is not a valid URL.`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return fail(
      `${name} must start with https:// (or http:// for local development).`,
    );
  }
  const errors: string[] = [];
  if (url.username || url.password) {
    errors.push(`${name} must not include a user name or password.`);
  }
  if (url.pathname !== "/" || raw.endsWith("/")) {
    errors.push(
      `${name} must be an origin only (scheme, host, and optional port), with no path or trailing slash.`,
    );
  }
  if (url.search || raw.includes("?")) {
    errors.push(`${name} must not include query parameters.`);
  }
  if (url.hash || raw.includes("#")) {
    errors.push(`${name} must not include a #fragment.`);
  }
  if (url.protocol === "http:") {
    if (isProduction) {
      errors.push(`${name} must use https:// when NODE_ENV is production.`);
    } else if (!isLoopbackHostname(url.hostname)) {
      errors.push(
        `${name} must use https://. http:// is allowed only for localhost, 127.0.0.1, or [::1] in local development.`,
      );
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: url.origin };
}

// Optional, comma-separated, with no spaces (Better Auth splits the raw
// value on commas itself, so it must be exactly what was validated).
function parseTrustedOrigins(
  raw: string | undefined,
  options: { isProduction: boolean },
): EnvParseResult<string[]> {
  const name = "BETTER_AUTH_TRUSTED_ORIGINS";
  if (raw === undefined || raw === "") return { ok: true, value: [] };

  const entries = raw.split(",");
  const errors: string[] = [];
  const origins: string[] = [];
  entries.forEach((entry, index) => {
    const label = `${name} entry ${index + 1}`;
    if (entry === "") {
      errors.push(`${label} is empty. Separate origins with single commas.`);
      return;
    }
    const origin = parseOrigin(label, entry, options);
    if (!origin.ok) errors.push(...origin.errors);
    // url.origin lowercases the host and drops default ports; Better Auth
    // compares the raw entry, so it must already be in that form.
    else if (origin.value !== entry) {
      errors.push(
        `${label} must be written in canonical form (lowercase host, no default port).`,
      );
    } else origins.push(origin.value);
  });

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: origins };
}

function parseSecret(raw: string | undefined): EnvParseResult<string> {
  const name = "BETTER_AUTH_SECRET";
  if (raw === undefined || !raw.trim()) return fail(`${name} is not set.`);
  if (/\s/.test(raw) || hasControlCharacter(raw)) {
    return fail(`${name} must not contain spaces or control characters.`);
  }
  if (raw === BETTER_AUTH_DEFAULT_SECRET) {
    return fail(`${name} must not be Better Auth's built-in default secret.`);
  }
  if (raw.length < MIN_SECRET_LENGTH) {
    return fail(
      `${name} must be at least ${MIN_SECRET_LENGTH} characters. Generate one with: openssl rand -base64 32`,
    );
  }
  if (raw.length > MAX_SECRET_LENGTH) {
    return fail(`${name} must be at most ${MAX_SECRET_LENGTH} characters.`);
  }
  if (estimateEntropyBits(raw) < MIN_SECRET_ENTROPY_BITS) {
    return fail(
      `${name} is too predictable. Use a randomly generated value, such as: openssl rand -base64 32`,
    );
  }
  return { ok: true, value: raw };
}

// length × log2(distinct characters): an upper bound, which rejects short
// alphabets and repetition but can't prove randomness. Generated secrets
// (openssl rand -base64 32 or -hex 32) clear it easily.
export function estimateEntropyBits(value: string): number {
  const characters = [...value];
  const distinct = new Set(characters).size;
  return distinct <= 1 ? 0 : characters.length * Math.log2(distinct);
}

function parseOAuthClient(
  env: AuthEnv,
  provider: "GITHUB" | "GOOGLE",
): EnvParseResult<OAuthClientConfig> {
  const errors: string[] = [];
  const values: string[] = [];
  for (const part of ["CLIENT_ID", "CLIENT_SECRET"] as const) {
    const name = `${provider}_${part}`;
    const value = env[name];
    if (value === undefined || !value.trim()) {
      errors.push(`${name} is not set.`);
    } else if (/\s/.test(value) || hasControlCharacter(value)) {
      errors.push(`${name} must not contain spaces or control characters.`);
    } else {
      values.push(value);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const [clientId = "", clientSecret = ""] = values;
  return { ok: true, value: { clientId, clientSecret } };
}

// Next.js inlines NEXT_PUBLIC_ variables into browser bundles, so a secret
// must never carry that prefix. Names are safe to report; values aren't.
function checkPublicSecrets(env: AuthEnv): string[] {
  return Object.keys(env)
    .filter(
      (name) =>
        name.startsWith("NEXT_PUBLIC_") &&
        /SECRET/i.test(name) &&
        env[name]?.trim(),
    )
    .sort()
    .map(
      (name) =>
        `${name} must not be set. Secrets must never use the NEXT_PUBLIC_ prefix, which exposes them to the browser.`,
    );
}

// URL.hostname keeps the brackets of an IPv6 address.
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function fail(message: string): { ok: false; errors: string[] } {
  return { ok: false, errors: [message] };
}
