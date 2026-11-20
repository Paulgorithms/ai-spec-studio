// Disposable credentials for the CI test database, built in memory only.
//
// - generatePassword: 32 bytes from crypto.randomBytes, as 64 lowercase hex
//   characters (nothing to URL-encode, so the masked value is the only form
//   the password ever takes).
// - buildTestDatabaseUrl: ai_spec_studio_test@127.0.0.1:5432/
//   ai_spec_studio_test, checked by the project's own validators before it's
//   returned.
// - scramSha256Verifier: the PostgreSQL SCRAM-SHA-256 secret
//   (SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>, RFC 5802 and
//   RFC 7677), so the server only ever receives the verifier, never the
//   password.
// - githubMaskCommand, githubEnvEntry: the exact text for the runner's
//   ::add-mask:: command and a GITHUB_ENV line. They return strings; nothing
//   here prints, writes a file, or reads the environment.
//
// Errors are CiCredentialError with a fixed code and description. They never
// carry a password, URL, verifier, random bytes, or the original error.
//
// The random source can be injected so tests are deterministic; its output
// is checked (type, exact length, not a constant fill) whichever source is
// used, and the length, salt size, and iteration floor are fixed.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { parseTestDatabaseEnv } from "../../../src/lib/db/env";
import {
  TEST_DATABASE_TARGET,
  checkTestDatabaseConfiguration,
} from "./test-database-target";

export const CI_PASSWORD_BYTES = 32;
export const SCRAM_SALT_BYTES = 16;
// PostgreSQL's default (scram_iterations) and RFC 7677's minimum.
export const SCRAM_MIN_ITERATIONS = 4096;
// node-postgres refuses servers that ask for more (scramMaxIterations).
export const SCRAM_MAX_ITERATIONS = 100_000;
// The loopback address the CI database listens on: IPv4, never a name that
// could resolve somewhere else.
export const CI_DATABASE_HOST = "127.0.0.1";
// The only variable CI may hand to later steps through GITHUB_ENV.
export const CI_ENV_VARIABLES = ["TEST_DATABASE_URL"] as const;

export const CI_CREDENTIAL_ERRORS = {
  RANDOM_SOURCE_FAILED: "the random source failed",
  RANDOM_SOURCE_INVALID:
    "the random source returned something other than the requested number of random bytes",
  PASSWORD_INVALID: "the password is not 64 lowercase hexadecimal characters",
  SCRAM_PASSWORD_INVALID:
    "the SCRAM password is not 1 to 1024 printable ASCII characters",
  SALT_INVALID: `the salt is not ${SCRAM_SALT_BYTES} random bytes`,
  ITERATIONS_INVALID: `the iteration count is not an integer from ${SCRAM_MIN_ITERATIONS} to ${SCRAM_MAX_ITERATIONS}`,
  TEST_URL_REJECTED:
    "the test database URL failed the project's test database validators",
  MASK_VALUE_INVALID:
    "the value to mask is not 8 to 4096 printable ASCII characters without spaces or %",
  ENV_NAME_NOT_ALLOWED: "the variable is not one CI may set through GITHUB_ENV",
  ENV_VALUE_INVALID: "the value is not an approved CI test database URL",
} as const;

export type CiCredentialErrorCode = keyof typeof CI_CREDENTIAL_ERRORS;

export class CiCredentialError extends Error {
  override name = "CiCredentialError";
  constructor(readonly code: CiCredentialErrorCode) {
    super(`${code}: ${CI_CREDENTIAL_ERRORS[code]}`);
  }
}

// Returns `size` bytes. Production uses crypto.randomBytes.
export type RandomSource = (size: number) => Uint8Array;

const secureRandom: RandomSource = (size) => randomBytes(size);

const CI_PASSWORD = /^[0-9a-f]{64}$/;
const SCRAM_PASSWORD = /^[\x20-\x7e]{1,1024}$/;
const MASKABLE = /^[\x21-\x24\x26-\x7e]{8,4096}$/;
const BASE64_16 = "[A-Za-z0-9+/]{22}==";
const BASE64_32 = "[A-Za-z0-9+/]{43}=";
const SCRAM_VERIFIER = new RegExp(
  `^SCRAM-SHA-256\\$([1-9][0-9]{3,5}):(${BASE64_16})\\$(${BASE64_32}):(${BASE64_32})$`,
);

// A constant fill (all zeros, all 0xff, ...) means a broken or stubbed
// source; from a real one it has a probability of at most 2^-120.
function isConstantFill(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === bytes[0]);
}

function isRandomBytes(value: unknown, size: number): value is Uint8Array {
  return (
    value instanceof Uint8Array &&
    value.length === size &&
    !isConstantFill(value)
  );
}

function draw(random: RandomSource, size: number): Buffer {
  let bytes: unknown;
  try {
    bytes = random(size);
  } catch {
    // The original error is dropped: its message could quote anything.
    throw new CiCredentialError("RANDOM_SOURCE_FAILED");
  }
  if (!isRandomBytes(bytes, size)) {
    throw new CiCredentialError("RANDOM_SOURCE_INVALID");
  }
  // A copy, so a source that reuses its buffer can't change it later.
  return Buffer.from(bytes);
}

export function isCiPassword(value: unknown): value is string {
  return typeof value === "string" && CI_PASSWORD.test(value);
}

export function generatePassword(random: RandomSource = secureRandom): string {
  const bytes = draw(random, CI_PASSWORD_BYTES);
  const password = bytes.toString("hex");
  bytes.fill(0);
  return password;
}

// The approved test target, with the password in the one place the parser
// reads it. Returned only if the project's validators accept it as exactly
// that target.
export function buildTestDatabaseUrl(password: string): string {
  if (!isCiPassword(password)) throw new CiCredentialError("PASSWORD_INVALID");
  const { user, database, port } = TEST_DATABASE_TARGET;
  const url = `postgresql://${user}:${password}@${CI_DATABASE_HOST}:${port}/${database}`;
  if (!isApprovedTestDatabaseUrl(url, password)) {
    throw new CiCredentialError("TEST_URL_REJECTED");
  }
  return url;
}

function isApprovedTestDatabaseUrl(url: string, password?: string): boolean {
  const env = { TEST_DATABASE_URL: url };
  const parsed = parseTestDatabaseEnv(env);
  if (!parsed.ok) return false;
  const connection = parsed.value.connection;
  let allPassed = true;
  const checked = checkTestDatabaseConfiguration(env, (pass) => {
    if (!pass) allPassed = false;
  });
  return (
    allPassed &&
    checked !== undefined &&
    connection.host === CI_DATABASE_HOST &&
    connection.port === TEST_DATABASE_TARGET.port &&
    connection.user === TEST_DATABASE_TARGET.user &&
    connection.database === TEST_DATABASE_TARGET.database &&
    connection.ssl === false &&
    isCiPassword(connection.password) &&
    (password === undefined || connection.password === password)
  );
}

export type ScramOptions = {
  // Defaults to SCRAM_MIN_ITERATIONS.
  iterations?: number;
  // Exactly SCRAM_SALT_BYTES; drawn from `random` when omitted.
  salt?: Uint8Array;
  random?: RandomSource;
};

// PostgreSQL applies SASLprep to the password before hashing. Printable
// ASCII is unchanged by SASLprep, so restricting the input to it means this
// needs no SASLprep and can't disagree with the server.
export function scramSha256Verifier(
  password: string,
  options: ScramOptions = {},
): string {
  const {
    iterations = SCRAM_MIN_ITERATIONS,
    salt: givenSalt,
    random = secureRandom,
  } = options;
  if (typeof password !== "string" || !SCRAM_PASSWORD.test(password)) {
    throw new CiCredentialError("SCRAM_PASSWORD_INVALID");
  }
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < SCRAM_MIN_ITERATIONS ||
    iterations > SCRAM_MAX_ITERATIONS
  ) {
    throw new CiCredentialError("ITERATIONS_INVALID");
  }
  let salt: Buffer;
  if (givenSalt === undefined) {
    salt = draw(random, SCRAM_SALT_BYTES);
  } else if (isRandomBytes(givenSalt, SCRAM_SALT_BYTES)) {
    salt = Buffer.from(givenSalt);
  } else {
    throw new CiCredentialError("SALT_INVALID");
  }

  const saltedPassword = pbkdf2Sync(
    Buffer.from(password, "utf8"),
    salt,
    iterations,
    32,
    "sha256",
  );
  const clientKey = createHmac("sha256", saltedPassword)
    .update("Client Key")
    .digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword)
    .update("Server Key")
    .digest();
  saltedPassword.fill(0);
  clientKey.fill(0);

  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

// The verifier's shape as this module writes it: 16-byte salt, 32-byte keys,
// an iteration count in range. Says nothing about which password it's for.
export function isScramVerifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = SCRAM_VERIFIER.exec(value);
  if (!match) return false;
  const iterations = Number(match[1]);
  return (
    iterations >= SCRAM_MIN_ITERATIONS && iterations <= SCRAM_MAX_ITERATIONS
  );
}

// The runner's ::add-mask:: command for one value. Values are limited to
// printable ASCII without spaces or "%": the runner un-escapes %25, %0D, and
// %0A in command data, which would mask a different string than the one used.
export function githubMaskCommand(value: string): string {
  if (typeof value !== "string" || !MASKABLE.test(value)) {
    throw new CiCredentialError("MASK_VALUE_INVALID");
  }
  return `::add-mask::${value}\n`;
}

// One NAME=value line for GITHUB_ENV. Only TEST_DATABASE_URL, and only a URL
// for the approved CI test target, so the line can't set anything else or
// smuggle a second line.
export function githubEnvEntry(
  name: (typeof CI_ENV_VARIABLES)[number],
  value: string,
): string {
  if (!(CI_ENV_VARIABLES as readonly string[]).includes(name)) {
    throw new CiCredentialError("ENV_NAME_NOT_ALLOWED");
  }
  if (
    typeof value !== "string" ||
    !/^[\x21-\x7e]{1,4096}$/.test(value) ||
    !isApprovedTestDatabaseUrl(value)
  ) {
    throw new CiCredentialError("ENV_VALUE_INVALID");
  }
  return `${name}=${value}\n`;
}

const REDACTED = "[CiCredentials: redacted]";

// One run's credentials. The values are readable only through the getters;
// printing, interpolating, or serializing the object shows REDACTED.
export class CiCredentials {
  readonly #password: string;
  readonly #testDatabaseUrl: string;
  readonly #verifier: string;

  private constructor(password: string, url: string, verifier: string) {
    this.#password = password;
    this.#testDatabaseUrl = url;
    this.#verifier = verifier;
  }

  static create(
    options: { random?: RandomSource; iterations?: number } = {},
  ): CiCredentials {
    const random = options.random ?? secureRandom;
    const password = generatePassword(random);
    const url = buildTestDatabaseUrl(password);
    const verifier = scramSha256Verifier(password, {
      random,
      iterations: options.iterations,
    });
    return new CiCredentials(password, url, verifier);
  }

  get password(): string {
    return this.#password;
  }

  get testDatabaseUrl(): string {
    return this.#testDatabaseUrl;
  }

  get verifier(): string {
    return this.#verifier;
  }

  // The mask commands to print before anything else: the password (which
  // also covers the URL containing it) and the verifier.
  maskCommands(): string[] {
    return [this.#password, this.#verifier].map(githubMaskCommand);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
