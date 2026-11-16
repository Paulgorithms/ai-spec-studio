// Database environment validation: pure functions over an env record the
// caller passes in (usually process.env). They never read process.env, never
// connect, and never throw, so they behave the same in Next.js server code,
// standalone scripts, drizzle.config.ts, and unit tests.
//
// Keep this module free of `import "server-only"` and the @/* alias: Drizzle
// Kit and tsx load it outside Next.js.
//
// Error messages name the variable and the rule, never the value: database
// URLs can carry passwords.

export type DatabaseEnv = Readonly<Record<string, string | undefined>>;

export const DATABASE_SSL_MODES = ["verify-full", "disable"] as const;
export type DatabaseSslMode = (typeof DATABASE_SSL_MODES)[number];

export const DEFAULT_POOL_MAX = 10;
export const MAX_POOL_MAX = 100;

// PostgreSQL truncates database and role names longer than this many bytes,
// which could silently drop a "_test" suffix.
const MAX_IDENTIFIER_BYTES = 63;

// node-postgres `ssl` option: false (no TLS, loopback hosts only) or full
// verification of the certificate chain and host name, optionally against a
// provider CA bundle instead of Node's built-in roots.
//
// Deferred to Step 3: pass this object form to Drizzle Kit too. Drizzle Kit
// 0.31 turns the strings "require", "prefer", and "allow" into
// { rejectUnauthorized: false }, and treats a missing `ssl` as {}.
export type DatabaseTls = false | { rejectUnauthorized: true; ca?: string };

// Where a connection goes, without the password. Safe to log.
export type DatabaseTarget = {
  host: string;
  port: number;
  database: string;
  user: string;
};

// Settings for node-postgres and Drizzle Kit, built from the validated parts
// instead of handing the raw URL to another parser, so the connection goes
// exactly where validation looked. `password` is an ordinary property, so it
// survives object spreads (Drizzle Kit spreads its credentials). That means
// this object must never be logged or serialized: log
// describeDatabaseTarget(connection) instead.
//
// The password is always present and nonempty: node-postgres falls back to
// PGPASSWORD and ~/.pgpass only when the password is missing, so requiring
// it in the URL keeps the credential source explicit.
export type DatabaseConnection = DatabaseTarget & {
  password: string;
  ssl: DatabaseTls;
};

export type RuntimeDatabaseConfig = {
  connection: DatabaseConnection;
  poolMax: number;
};

export type MigrationDatabaseConfig = { connection: DatabaseConnection };

export type TestDatabaseConfig = { connection: DatabaseConnection };

export type EnvParseResult<T> =
  { ok: true; value: T } | { ok: false; errors: string[] };

type ParsedUrl = { target: DatabaseTarget; password: string };

// Runtime connection: DATABASE_URL (application role), the shared TLS
// settings, and the pool size.
export function parseRuntimeDatabaseEnv(
  env: DatabaseEnv,
): EnvParseResult<RuntimeDatabaseConfig> {
  const connection = parseServerConnection(env, "DATABASE_URL");
  const poolMax = parsePoolMax(env.DATABASE_POOL_MAX);
  if (!connection.ok || !poolMax.ok) {
    return {
      ok: false,
      errors: [...errorsOf(connection), ...errorsOf(poolMax)],
    };
  }
  return {
    ok: true,
    value: { connection: connection.value, poolMax: poolMax.value },
  };
}

// Migration connection: DATABASE_MIGRATION_URL (migration role, direct
// connection), with the same TLS settings as the runtime connection.
export function parseMigrationDatabaseEnv(
  env: DatabaseEnv,
): EnvParseResult<MigrationDatabaseConfig> {
  const connection = parseServerConnection(env, "DATABASE_MIGRATION_URL");
  return connection.ok
    ? { ok: true, value: { connection: connection.value } }
    : connection;
}

// Test connection: TEST_DATABASE_URL, with the static safeguards that run
// before any test helper connects. The test database is always on a loopback
// host, so it never uses TLS and ignores DATABASE_SSL_MODE. These checks are
// one layer of several: helpers that delete data must also confirm the
// server's own environment label once connected.
export function parseTestDatabaseEnv(
  env: DatabaseEnv,
): EnvParseResult<TestDatabaseConfig> {
  const errors = checkSessionOptions(env);
  if (env.NODE_ENV === "production") {
    errors.push("Test database access is refused when NODE_ENV is production.");
  }

  const parsed = parseDatabaseUrl("TEST_DATABASE_URL", env.TEST_DATABASE_URL);
  if (!parsed.ok) return { ok: false, errors: [...errors, ...parsed.errors] };
  const { target, password } = parsed.value;

  if (!target.database.endsWith("_test")) {
    errors.push("TEST_DATABASE_URL must name a database ending in _test.");
  }
  if (!isLoopbackHost(target.host)) {
    errors.push(
      "TEST_DATABASE_URL must point to a loopback host (localhost, 127.0.0.1, or ::1).",
    );
  }
  for (const name of ["DATABASE_URL", "DATABASE_MIGRATION_URL"] as const) {
    if (!env[name]?.trim()) continue;
    const other = parseDatabaseUrl(name, env[name]);
    if (!other.ok) {
      // Fail closed: an unreadable URL can't be proven to be a different
      // database.
      errors.push(
        `${name} is set but invalid, so TEST_DATABASE_URL can't be confirmed to be a different database. Fix or unset ${name}.`,
      );
    } else if (isSameDatabase(target, other.value.target)) {
      errors.push(
        `TEST_DATABASE_URL must not point to the same database as ${name}.`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { connection: createConnection(target, password, false) },
  };
}

// "user@host:port/database", never the password.
export function describeDatabaseTarget(target: DatabaseTarget): string {
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `${target.user}@${host}:${target.port}/${target.database}`;
}

// localhost, 127.0.0.0/8, or ::1 (with or without brackets). 0.0.0.0 means
// "every interface", not loopback.
export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function parseServerConnection(
  env: DatabaseEnv,
  name: "DATABASE_URL" | "DATABASE_MIGRATION_URL",
): EnvParseResult<DatabaseConnection> {
  const sessionErrors = checkSessionOptions(env);
  const parsed = parseDatabaseUrl(name, env[name]);
  if (!parsed.ok) {
    return { ok: false, errors: [...sessionErrors, ...parsed.errors] };
  }
  const tls = resolveTls(env, name, parsed.value.target);
  if (!tls.ok || sessionErrors.length > 0) {
    return { ok: false, errors: [...sessionErrors, ...errorsOf(tls)] };
  }
  return {
    ok: true,
    value: createConnection(
      parsed.value.target,
      parsed.value.password,
      tls.value,
    ),
  };
}

function parseDatabaseUrl(
  name: string,
  raw: string | undefined,
): EnvParseResult<ParsedUrl> {
  const value = raw?.trim();
  if (!value) return fail(`${name} is not set.`);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The parser's own error includes the input, which may hold a password.
    return fail(`${name} is not a valid URL.`);
  }

  const errors: string[] = [];
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    errors.push(`${name} must start with postgresql:// or postgres://.`);
  }
  if (url.search) {
    errors.push(
      `${name} must not include query parameters (found: ${describeQueryParameters(url)}). TLS and session settings are configured in code, not in the URL.`,
    );
  }
  if (url.hash) errors.push(`${name} must not include a #fragment.`);

  const host = normalizeHost(url.hostname);
  if (!host) {
    errors.push(
      `${name} must include a host name. Unix socket connections aren't supported.`,
    );
  } else if (/[%\s]/.test(host) || hasControlCharacter(host)) {
    errors.push(
      `${name} has a malformed host name (percent-encoding, spaces, and control characters aren't allowed).`,
    );
  }

  const port = Number(url.port);
  if (!url.port) {
    errors.push(`${name} must include an explicit port, such as :5432.`);
  } else if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    errors.push(`${name} must use a port between 1 and 65535.`);
  }

  const user = decodePart(url.username);
  if (user === undefined) {
    errors.push(`${name} has invalid percent-encoding in its user name.`);
  } else if (!user) {
    errors.push(`${name} must include a user name (the database role).`);
  } else if (hasControlCharacter(user)) {
    errors.push(`${name} has control characters in its user name.`);
  } else if (byteLength(user) > MAX_IDENTIFIER_BYTES) {
    errors.push(
      `${name} has a user name longer than ${MAX_IDENTIFIER_BYTES} bytes.`,
    );
  }

  const password = decodePart(url.password);
  if (password === undefined) {
    errors.push(`${name} has invalid percent-encoding in its password.`);
  } else if (!password) {
    errors.push(
      `${name} must include a password (postgresql://<role>:<password>@…). Empty passwords and PGPASSWORD or ~/.pgpass fallbacks aren't supported.`,
    );
  }

  const path = url.pathname.replace(/^\//, "");
  const database = decodePart(path);
  if (database === undefined) {
    errors.push(`${name} has invalid percent-encoding in its database name.`);
  } else if (!database || path.includes("/")) {
    errors.push(
      `${name} must name exactly one database, such as /ai_spec_studio_dev.`,
    );
  } else if (hasControlCharacter(database)) {
    errors.push(`${name} has control characters in its database name.`);
  } else if (byteLength(database) > MAX_IDENTIFIER_BYTES) {
    errors.push(
      `${name} has a database name longer than ${MAX_IDENTIFIER_BYTES} bytes.`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      target: { host, port, user: user ?? "", database: database ?? "" },
      password: password ?? "",
    },
  };
}

function resolveTls(
  env: DatabaseEnv,
  urlName: string,
  target: DatabaseTarget,
): EnvParseResult<DatabaseTls> {
  const mode = env.DATABASE_SSL_MODE?.trim() || "verify-full";
  if (!isSslMode(mode)) {
    return fail(
      `DATABASE_SSL_MODE must be verify-full or disable. Modes such as require, prefer, verify-ca, and no-verify aren't accepted because they don't always verify the server's certificate.`,
    );
  }

  const rawCa = env.DATABASE_SSL_CA?.trim();
  if (mode === "disable") {
    const errors: string[] = [];
    if (!isLoopbackHost(target.host)) {
      errors.push(
        `DATABASE_SSL_MODE=disable is only allowed for loopback hosts, and ${urlName} points to a remote host. Use verify-full.`,
      );
    }
    if (rawCa) {
      errors.push(
        "DATABASE_SSL_CA is set, but DATABASE_SSL_MODE is disable. Unset DATABASE_SSL_CA or use verify-full.",
      );
    }
    return errors.length > 0
      ? { ok: false, errors }
      : { ok: true, value: false };
  }

  if (!rawCa) return { ok: true, value: { rejectUnauthorized: true } };
  const ca = parseCaBundle(rawCa);
  return ca.ok
    ? { ok: true, value: { rejectUnauthorized: true, ca: ca.value } }
    : ca;
}

// PEM certificates only. Escaped "\n" sequences become newlines, for
// platforms that store environment variables on one line.
//
// This only checks the PEM markers. Deferred to Step 3: parse each
// certificate (node:crypto X509Certificate) when the pool is created, so a
// corrupt bundle fails at startup. This module stays free of imports.
function parseCaBundle(raw: string): EnvParseResult<string> {
  const pem = raw.replace(/\\n/g, "\n").trim();
  if (/PRIVATE KEY/.test(pem)) {
    return fail(
      "DATABASE_SSL_CA must contain certificates only, never a private key.",
    );
  }
  const begins = pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;
  const ends = pem.match(/-----END CERTIFICATE-----/g)?.length ?? 0;
  if (begins === 0 || begins !== ends) {
    return fail(
      "DATABASE_SSL_CA must be one or more PEM certificates (-----BEGIN CERTIFICATE----- … -----END CERTIFICATE-----).",
    );
  }
  return { ok: true, value: pem };
}

function parsePoolMax(raw: string | undefined): EnvParseResult<number> {
  const value = raw?.trim();
  if (!value) return { ok: true, value: DEFAULT_POOL_MAX };
  const poolMax = Number(value);
  if (!/^\d+$/.test(value) || poolMax < 1 || poolMax > MAX_POOL_MAX) {
    return fail(
      `DATABASE_POOL_MAX must be a whole number from 1 to ${MAX_POOL_MAX}.`,
    );
  }
  return { ok: true, value: poolMax };
}

// node-postgres sends PGOPTIONS as session settings when the config doesn't
// set `options`. Session settings come only from code, because they could
// override the server's environment label.
function checkSessionOptions(env: DatabaseEnv): string[] {
  return env.PGOPTIONS?.trim()
    ? [
        "PGOPTIONS must not be set. Database session settings are configured in code.",
      ]
    : [];
}

function createConnection(
  target: DatabaseTarget,
  password: string,
  ssl: DatabaseTls,
): DatabaseConnection {
  return { ...target, password, ssl };
}

// Query parameter names come from the URL, so only well-known connection
// parameters are named in errors; anything else could be a pasted secret.
const KNOWN_QUERY_PARAMETERS = new Set([
  "application_name",
  "client_encoding",
  "connect_timeout",
  "dbname",
  "encoding",
  "host",
  "hostaddr",
  "options",
  "password",
  "port",
  "ssl",
  "sslcert",
  "sslkey",
  "sslmode",
  "sslrootcert",
  "target_session_attrs",
  "user",
  "uselibpqcompat",
]);

function describeQueryParameters(url: URL): string {
  const keys = [...new Set(url.searchParams.keys())];
  const known = keys.filter((key) => KNOWN_QUERY_PARAMETERS.has(key));
  const others = keys.length - known.length;
  const parts = [...known];
  if (others > 0) {
    parts.push(`${others} other ${others === 1 ? "parameter" : "parameters"}`);
  }
  return parts.join(", ") || "an empty query";
}

// C0 controls, DEL, and C1 controls: these could break log lines or hide
// part of a name.
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

// Same database when the name and port match and the hosts are the same, or
// are both loopback addresses (localhost and 127.0.0.1 reach the same server).
function isSameDatabase(a: DatabaseTarget, b: DatabaseTarget): boolean {
  if (a.database !== b.database || a.port !== b.port) return false;
  return (
    a.host === b.host || (isLoopbackHost(a.host) && isLoopbackHost(b.host))
  );
}

// URL.hostname keeps the case and brackets of non-web schemes such as
// postgres:, so normalize both here.
function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

function decodePart(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isSslMode(mode: string): mode is DatabaseSslMode {
  return (DATABASE_SSL_MODES as readonly string[]).includes(mode);
}

function errorsOf<T>(result: EnvParseResult<T>): string[] {
  return result.ok ? [] : result.errors;
}

function fail(message: string): { ok: false; errors: string[] } {
  return { ok: false, errors: [message] };
}
