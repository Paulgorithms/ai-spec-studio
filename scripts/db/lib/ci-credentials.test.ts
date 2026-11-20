import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { inspect } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { parseTestDatabaseEnv } from "../../../src/lib/db/env";
import {
  CI_CREDENTIAL_ERRORS,
  CI_DATABASE_HOST,
  CiCredentialError,
  CiCredentials,
  SCRAM_MAX_ITERATIONS,
  SCRAM_MIN_ITERATIONS,
  buildTestDatabaseUrl,
  generatePassword,
  githubEnvEntry,
  githubMaskCommand,
  isCiPassword,
  isScramVerifier,
  scramSha256Verifier,
  type CiCredentialErrorCode,
  type RandomSource,
} from "./ci-credentials";
import {
  TEST_DATABASE_TARGET,
  checkTestDatabaseConfiguration,
} from "./test-database-target";

// Fixtures are synthetic. The "secret" strings exist only to prove errors
// never quote their input.
const SECRET = "FakeSecret:p@ss/word";
const HEX_PASSWORD = "0123456789abcdef".repeat(4);

// Bytes 1..n: deterministic, and not a constant fill.
function counting(size: number, start = 1): Buffer {
  return Buffer.from(Array.from({ length: size }, (_, i) => (start + i) % 256));
}

// Hands out each buffer in turn, recording the sizes asked for.
function sequence(...buffers: Uint8Array[]) {
  const sizes: number[] = [];
  const random: RandomSource = (size) => {
    sizes.push(size);
    const next = buffers.shift();
    if (!next) throw new Error("no more fixture bytes");
    return next;
  };
  return { random, sizes };
}

function expectCode(run: () => unknown, code: CiCredentialErrorCode): Error {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CiCredentialError);
  const error = caught as CiCredentialError;
  expect(error.code).toBe(code);
  expect(error.message).toBe(`${code}: ${CI_CREDENTIAL_ERRORS[code]}`);
  expect(error.cause).toBeUndefined();
  return error;
}

function parts(verifier: string) {
  const match =
    /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):([^:]+)$/.exec(verifier) ?? [];
  return {
    iterations: Number(match[1]),
    salt: Buffer.from(match[2] ?? "", "base64"),
    storedKey: Buffer.from(match[3] ?? "", "base64"),
    serverKey: Buffer.from(match[4] ?? "", "base64"),
  };
}

const hmac = (key: Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();
const xor = (a: Buffer, b: Buffer) =>
  Buffer.from(a.map((byte, i) => byte ^ b[i]));

// What a PostgreSQL server does with a client's proof (RFC 5802 §3): recover
// ClientKey from the proof and check that it hashes to StoredKey.
function serverAcceptsProof(
  storedKey: Buffer,
  authMessage: string,
  proof: Buffer,
): boolean {
  const clientKey = xor(proof, hmac(storedKey, authMessage));
  return createHash("sha256").update(clientKey).digest().equals(storedKey);
}

describe("generatePassword", () => {
  test("returns 64 lowercase hex characters from crypto.randomBytes by default", () => {
    const password = generatePassword();
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(isCiPassword(password)).toBe(true);
  });

  test("never repeats across calls", () => {
    const passwords = new Set(
      Array.from({ length: 200 }, () => generatePassword()),
    );
    expect(passwords.size).toBe(200);
  });

  test("asks for exactly 32 bytes and hex-encodes them", () => {
    const { random, sizes } = sequence(counting(32));
    expect(generatePassword(random)).toBe(counting(32).toString("hex"));
    expect(sizes).toEqual([32]);
  });

  test("accepts a plain Uint8Array and copies it", () => {
    const bytes = new Uint8Array(counting(32));
    const password = generatePassword(() => bytes);
    bytes.fill(7);
    expect(password).toBe(counting(32).toString("hex"));
  });

  test.each([
    ["31 bytes", () => counting(31)],
    ["33 bytes", () => counting(33)],
    ["no bytes", () => Buffer.alloc(0)],
    ["all zeros", () => Buffer.alloc(32)],
    ["all 0xff", () => Buffer.alloc(32, 0xff)],
    ["a hex string", () => counting(32).toString("hex")],
    ["a number array", () => [...counting(32)]],
    ["a Uint16Array", () => new Uint16Array(32).fill(1)],
    ["an ArrayBuffer", () => counting(32).buffer],
    ["undefined", () => undefined],
    ["null", () => null],
  ])("fails closed on %s", (_name, output) => {
    expectCode(
      () => generatePassword(output as unknown as RandomSource),
      "RANDOM_SOURCE_INVALID",
    );
  });

  test("fails closed, without the original error, when the source throws", () => {
    const error = expectCode(
      () =>
        generatePassword(() => {
          throw new Error(`entropy unavailable ${SECRET}`);
        }),
      "RANDOM_SOURCE_FAILED",
    );
    expect(String(error.stack)).not.toContain(SECRET);
  });
});

describe("isCiPassword", () => {
  test.each([
    HEX_PASSWORD.toUpperCase(),
    HEX_PASSWORD.slice(1),
    `${HEX_PASSWORD}0`,
    `${HEX_PASSWORD.slice(1)}g`,
    ` ${HEX_PASSWORD.slice(1)}`,
    `${HEX_PASSWORD.slice(1)}\n`,
    "",
    SECRET,
    undefined,
    64,
  ])("rejects %j", (value) => {
    expect(isCiPassword(value)).toBe(false);
  });
});

describe("buildTestDatabaseUrl", () => {
  test("builds the approved target on 127.0.0.1", () => {
    expect(buildTestDatabaseUrl(HEX_PASSWORD)).toBe(
      `postgresql://ai_spec_studio_test:${HEX_PASSWORD}@127.0.0.1:5432/ai_spec_studio_test`,
    );
  });

  test("passes the project validator as exactly the test target", () => {
    const url = buildTestDatabaseUrl(HEX_PASSWORD);
    const parsed = parseTestDatabaseEnv({ TEST_DATABASE_URL: url });
    expect(parsed).toEqual({
      ok: true,
      value: {
        connection: {
          host: CI_DATABASE_HOST,
          port: TEST_DATABASE_TARGET.port,
          user: TEST_DATABASE_TARGET.user,
          database: TEST_DATABASE_TARGET.database,
          password: HEX_PASSWORD,
          ssl: false,
        },
      },
    });
  });

  test("passes every checkTestDatabaseConfiguration check", () => {
    const url = buildTestDatabaseUrl(HEX_PASSWORD);
    const results: Array<{ pass: boolean; label: string }> = [];
    const connection = checkTestDatabaseConfiguration(
      { TEST_DATABASE_URL: url },
      (pass, label) => results.push({ pass, label }),
    );
    expect(connection).toBeDefined();
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((result) => !result.pass)).toEqual([]);
  });

  test("works with a freshly generated password", () => {
    const password = generatePassword();
    expect(buildTestDatabaseUrl(password)).toContain(`:${password}@`);
  });

  test.each([
    HEX_PASSWORD.toUpperCase(),
    HEX_PASSWORD.slice(2),
    `${HEX_PASSWORD.slice(1)}@`,
    `${HEX_PASSWORD.slice(1)}/`,
    `${HEX_PASSWORD.slice(1)}:`,
    `${HEX_PASSWORD.slice(1)}%`,
    `${HEX_PASSWORD.slice(1)}?`,
    SECRET,
    "",
  ])("refuses the password %j without quoting it", (password) => {
    const error = expectCode(
      () => buildTestDatabaseUrl(password),
      "PASSWORD_INVALID",
    );
    if (password) expect(error.message).not.toContain(password);
  });

  test("refuses a non-string password", () => {
    expectCode(
      () => buildTestDatabaseUrl(undefined as unknown as string),
      "PASSWORD_INVALID",
    );
  });
});

describe("scramSha256Verifier: independent test vectors", () => {
  // RFC 7677 §3: user "user", password "pencil".
  const RFC = {
    salt: Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"),
    clientNonce: "rOprNGfwEbeRWgbNEkqO",
    serverNonce: "rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0",
    clientProof: "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
    serverSignature: "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
  };
  const rfcAuthMessage =
    `n=user,r=${RFC.clientNonce},` +
    `r=${RFC.serverNonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,` +
    `c=biws,r=${RFC.serverNonce}`;

  test("RFC 7677: the server accepts the RFC's ClientProof", () => {
    const { storedKey } = parts(
      scramSha256Verifier("pencil", { salt: RFC.salt }),
    );
    expect(
      serverAcceptsProof(
        storedKey,
        rfcAuthMessage,
        Buffer.from(RFC.clientProof, "base64"),
      ),
    ).toBe(true);
  });

  test("RFC 7677: ServerKey produces the RFC's ServerSignature", () => {
    const { serverKey } = parts(
      scramSha256Verifier("pencil", { salt: RFC.salt }),
    );
    expect(hmac(serverKey, rfcAuthMessage).toString("base64")).toBe(
      RFC.serverSignature,
    );
  });

  test("RFC 7677: the full verifier", () => {
    // Computed independently with Python's hashlib and hmac, which also
    // reproduce the RFC's ClientProof and ServerSignature.
    expect(scramSha256Verifier("pencil", { salt: RFC.salt })).toBe(
      "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=",
    );
  });

  test("RFC 7677: a different password is refused by the server", () => {
    const { storedKey } = parts(
      scramSha256Verifier("pencil2", { salt: RFC.salt }),
    );
    expect(
      serverAcceptsProof(
        storedKey,
        rfcAuthMessage,
        Buffer.from(RFC.clientProof, "base64"),
      ),
    ).toBe(false);
  });

  // Computed independently with Python's hashlib.pbkdf2_hmac and hmac.
  test.each([
    [
      4096,
      counting(16),
      "SCRAM-SHA-256$4096:AQIDBAUGBwgJCgsMDQ4PEA==$y4XxY/znpvDP+WkJoPXFiQaG/KsJlTqLo8hZGlCuoO8=:g5lYDnJ4WoMr46iWhyqYncaDdRco7Mzv1FygHOyoh/E=",
    ],
    [
      10000,
      Buffer.from("a1b2c3d4e5f60718293a4b5c6d7e8f90", "hex"),
      "SCRAM-SHA-256$10000:obLD1OX2BxgpOktcbX6PkA==$ZImRUkHu8vNwm1QVuVNBCUBuW+YHp6bXp9RNDYOrhOs=:6zQK/CEZLt/PUD/1Wq88SJCY+jS0dfEEn8PmOyMp684=",
    ],
  ])(
    "a hex CI password at %i iterations matches the Python reference",
    (iterations, salt, expected) => {
      expect(scramSha256Verifier(HEX_PASSWORD, { iterations, salt })).toBe(
        expected,
      );
    },
  );

  // node-postgres's own SCRAM client (WebCrypto, with its SASLprep) logs in
  // against the verifier, exactly as it would against PostgreSQL.
  type PgSession = {
    clientNonce: string;
    response: string;
  };
  const sasl = createRequire(import.meta.url)("pg/lib/crypto/sasl") as {
    startSession: (mechanisms: string[]) => PgSession;
    continueSession: (
      session: PgSession,
      password: string,
      serverData: string,
    ) => Promise<void>;
    finalizeSession: (session: PgSession, serverData: string) => void;
  };

  async function pgLogin(verifier: string, password: string) {
    const { iterations, salt, storedKey, serverKey } = parts(verifier);
    const session = sasl.startSession(["SCRAM-SHA-256"]);
    const nonce = `${session.clientNonce}c2VydmVyLW5vbmNl`;
    const serverFirst = `r=${nonce},s=${salt.toString("base64")},i=${iterations}`;
    await sasl.continueSession(session, password, serverFirst);
    const final = /^c=biws,r=([^,]+),p=([A-Za-z0-9+/=]+)$/.exec(
      session.response,
    );
    expect(final?.[1]).toBe(nonce);
    const authMessage = `n=*,r=${session.clientNonce},${serverFirst},c=biws,r=${nonce}`;
    const accepted = serverAcceptsProof(
      storedKey,
      authMessage,
      Buffer.from(final?.[2] ?? "", "base64"),
    );
    return {
      accepted,
      finalize: () =>
        sasl.finalizeSession(
          session,
          `v=${hmac(serverKey, authMessage).toString("base64")}`,
        ),
    };
  }

  test("node-postgres logs in with the generated password", async () => {
    const credentials = CiCredentials.create();
    const login = await pgLogin(credentials.verifier, credentials.password);
    expect(login.accepted).toBe(true);
    // Throws if the server signature doesn't match what the client derived.
    expect(login.finalize).not.toThrow();
  });

  test("node-postgres logs in at a higher iteration count", async () => {
    const verifier = scramSha256Verifier(HEX_PASSWORD, { iterations: 20000 });
    expect((await pgLogin(verifier, HEX_PASSWORD)).accepted).toBe(true);
  });

  test("node-postgres is refused with the wrong password", async () => {
    const verifier = scramSha256Verifier(HEX_PASSWORD);
    const login = await pgLogin(verifier, "f".repeat(64));
    expect(login.accepted).toBe(false);
    expect(login.finalize).toThrow();
  });
});

describe("scramSha256Verifier: inputs", () => {
  test("defaults to 4096 iterations and a 16-byte salt from crypto.randomBytes", () => {
    const verifier = scramSha256Verifier(HEX_PASSWORD);
    const { iterations, salt, storedKey, serverKey } = parts(verifier);
    expect(iterations).toBe(SCRAM_MIN_ITERATIONS);
    expect(salt).toHaveLength(16);
    expect(storedKey).toHaveLength(32);
    expect(serverKey).toHaveLength(32);
    expect(isScramVerifier(verifier)).toBe(true);
  });

  test("a new salt every time: the same password gives different verifiers", () => {
    const verifiers = new Set(
      Array.from({ length: 20 }, () => scramSha256Verifier(HEX_PASSWORD)),
    );
    expect(verifiers.size).toBe(20);
  });

  test("draws the salt from the injected source, 16 bytes", () => {
    const { random, sizes } = sequence(counting(16));
    expect(parts(scramSha256Verifier(HEX_PASSWORD, { random })).salt).toEqual(
      counting(16),
    );
    expect(sizes).toEqual([16]);
  });

  test("a given salt is used instead of the random source", () => {
    const random = vi.fn<RandomSource>();
    scramSha256Verifier(HEX_PASSWORD, { salt: counting(16), random });
    expect(random).not.toHaveBeenCalled();
  });

  test.each([SCRAM_MIN_ITERATIONS, 8192, SCRAM_MAX_ITERATIONS])(
    "accepts %i iterations",
    (iterations) => {
      const verifier = scramSha256Verifier("pencil", {
        iterations,
        salt: counting(16),
      });
      expect(parts(verifier).iterations).toBe(iterations);
      expect(isScramVerifier(verifier)).toBe(true);
    },
  );

  test.each([
    0,
    1,
    -4096,
    SCRAM_MIN_ITERATIONS - 1,
    SCRAM_MAX_ITERATIONS + 1,
    4096.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "4096",
    null,
  ])("refuses %j iterations", (iterations) => {
    expectCode(
      () =>
        scramSha256Verifier(HEX_PASSWORD, {
          iterations: iterations as number,
          salt: counting(16),
        }),
      "ITERATIONS_INVALID",
    );
  });

  test.each([
    ["15 bytes", counting(15)],
    ["17 bytes", counting(17)],
    ["no bytes", Buffer.alloc(0)],
    ["all zeros", Buffer.alloc(16)],
    ["a string", "AQIDBAUGBwgJCgsMDQ4PEA=="],
    ["a number array", [...counting(16)]],
    ["null", null],
  ])("refuses a salt of %s", (_name, salt) => {
    expectCode(
      () =>
        scramSha256Verifier(HEX_PASSWORD, {
          salt: salt as unknown as Uint8Array,
        }),
      "SALT_INVALID",
    );
  });

  test.each([
    ["a short random salt", () => counting(15)],
    ["a constant salt", () => Buffer.alloc(16, 9)],
  ])("refuses %s from the random source", (_name, random) => {
    expectCode(
      () => scramSha256Verifier(HEX_PASSWORD, { random }),
      "RANDOM_SOURCE_INVALID",
    );
  });

  test.each([
    ["empty", ""],
    ["non-ASCII", "pässword"],
    ["a non-ASCII space", "pass word"],
    ["a zero-width character", "pass​word"],
    ["a newline", "pass\nword"],
    ["a tab", "pass\tword"],
    ["a NUL byte", "pass\0word"],
    ["over 1024 characters", "a".repeat(1025)],
  ])("refuses a password that is %s, without quoting it", (_name, password) => {
    const error = expectCode(
      () => scramSha256Verifier(password, { salt: counting(16) }),
      "SCRAM_PASSWORD_INVALID",
    );
    if (password) expect(error.message).not.toContain(password);
  });

  test("refuses a non-string password", () => {
    expectCode(
      () => scramSha256Verifier(42 as unknown as string),
      "SCRAM_PASSWORD_INVALID",
    );
  });

  test("checks the password and iterations before drawing a salt", () => {
    const random = vi.fn<RandomSource>(() => counting(16));
    expect(() => scramSha256Verifier("", { random })).toThrow();
    expect(() =>
      scramSha256Verifier(HEX_PASSWORD, { random, iterations: 1 }),
    ).toThrow();
    expect(random).not.toHaveBeenCalled();
  });
});

describe("isScramVerifier", () => {
  const valid = scramSha256Verifier(HEX_PASSWORD, { salt: counting(16) });

  test.each([
    ["SCRAM-SHA-1", valid.replace("SCRAM-SHA-256", "SCRAM-SHA-1")],
    ["1000 iterations", valid.replace("$4096:", "$1000:")],
    ["leading zero iterations", valid.replace("$4096:", "$04096:")],
    ["too many iterations", valid.replace("$4096:", "$100001:")],
    [
      "a short salt",
      valid.replace("AQIDBAUGBwgJCgsMDQ4PEA==", "AQIDBAUGBwgJCgsMDQ4P"),
    ],
    ["a missing ServerKey", valid.slice(0, valid.lastIndexOf(":"))],
    ["a trailing newline", `${valid}\n`],
    ["leading space", ` ${valid}`],
    ["an MD5 hash", `md5${"0".repeat(32)}`],
    ["a password", HEX_PASSWORD],
    ["a non-string", 42],
  ])("rejects %s", (_name, value) => {
    expect(isScramVerifier(value)).toBe(false);
  });
});

describe("githubMaskCommand", () => {
  test("returns one ::add-mask:: line for the password, verifier, and URL", () => {
    const verifier = scramSha256Verifier(HEX_PASSWORD);
    const url = buildTestDatabaseUrl(HEX_PASSWORD);
    for (const value of [HEX_PASSWORD, verifier, url]) {
      expect(githubMaskCommand(value)).toBe(`::add-mask::${value}\n`);
    }
  });

  test.each([
    ["empty", ""],
    ["shorter than 8 characters", "abc1234"],
    ["over 4096 characters", "a".repeat(4097)],
    ["a newline", `${HEX_PASSWORD}\nx`],
    ["a carriage return", `${HEX_PASSWORD}\rx`],
    ["an escaped newline", `${HEX_PASSWORD}%0A::set-env`],
    ["a percent sign", `${HEX_PASSWORD}%`],
    ["a space", `${HEX_PASSWORD} x`],
    ["non-ASCII", `${HEX_PASSWORD}é`],
    ["a NUL byte", `${HEX_PASSWORD}\0`],
  ])("refuses a value that is %s, without quoting it", (_name, value) => {
    const error = expectCode(
      () => githubMaskCommand(value),
      "MASK_VALUE_INVALID",
    );
    if (value) expect(error.message).not.toContain(HEX_PASSWORD);
  });

  test("refuses a non-string", () => {
    expectCode(
      () => githubMaskCommand(undefined as unknown as string),
      "MASK_VALUE_INVALID",
    );
  });
});

describe("githubEnvEntry", () => {
  const url = buildTestDatabaseUrl(HEX_PASSWORD);

  test("returns one TEST_DATABASE_URL line", () => {
    expect(githubEnvEntry("TEST_DATABASE_URL", url)).toBe(
      `TEST_DATABASE_URL=${url}\n`,
    );
  });

  test.each([
    "DATABASE_URL",
    "DATABASE_MIGRATION_URL",
    "test_database_url",
    "TEST_DATABASE_URL\n",
    "TEST_DATABASE_URL=x",
    "NODE_OPTIONS",
    "PATH",
    "",
  ])("refuses the variable %j", (name) => {
    expectCode(
      () => githubEnvEntry(name as unknown as "TEST_DATABASE_URL", url),
      "ENV_NAME_NOT_ALLOWED",
    );
  });

  const base = `postgresql://ai_spec_studio_test:${HEX_PASSWORD}@127.0.0.1:5432/ai_spec_studio_test`;
  test.each([
    ["a second line", `${url}\nNODE_OPTIONS=--require=x`],
    ["a heredoc delimiter", `${url}<<EOF`],
    ["a trailing space", `${url} `],
    ["another database", base.replace(/test$/, "dev")],
    [
      "another role",
      base.replace("ai_spec_studio_test:", "ai_spec_studio_app:"),
    ],
    ["another host", base.replace("127.0.0.1", "db.example.com")],
    ["localhost instead of 127.0.0.1", base.replace("127.0.0.1", "localhost")],
    ["another port", base.replace(":5432/", ":5433/")],
    ["query parameters", `${base}?sslmode=disable`],
    ["a non-hex password", base.replace(HEX_PASSWORD, SECRET)],
    [
      "an uppercase password",
      base.replace(HEX_PASSWORD, HEX_PASSWORD.toUpperCase()),
    ],
    ["no password", base.replace(`:${HEX_PASSWORD}`, "")],
    ["not a URL", HEX_PASSWORD],
    ["empty", ""],
  ])("refuses a value with %s, without quoting it", (_name, value) => {
    const error = expectCode(
      () => githubEnvEntry("TEST_DATABASE_URL", value),
      "ENV_VALUE_INVALID",
    );
    expect(error.message).not.toContain(HEX_PASSWORD);
    expect(error.message).not.toContain("postgresql://");
  });
});

describe("CiCredentials", () => {
  test("holds a password, its URL, and its verifier", async () => {
    const credentials = CiCredentials.create();
    expect(isCiPassword(credentials.password)).toBe(true);
    expect(credentials.testDatabaseUrl).toBe(
      buildTestDatabaseUrl(credentials.password),
    );
    expect(isScramVerifier(credentials.verifier)).toBe(true);
    expect(credentials.maskCommands()).toEqual([
      `::add-mask::${credentials.password}\n`,
      `::add-mask::${credentials.verifier}\n`,
    ]);
  });

  test("draws the password (32 bytes) then the salt (16 bytes) from one source", () => {
    const { random, sizes } = sequence(counting(32), counting(16, 100));
    const credentials = CiCredentials.create({ random });
    expect(sizes).toEqual([32, 16]);
    expect(credentials.password).toBe(counting(32).toString("hex"));
    expect(credentials.verifier).toBe(
      scramSha256Verifier(counting(32).toString("hex"), {
        salt: counting(16, 100),
      }),
    );
  });

  test("passes the iteration count through, and enforces its floor", () => {
    expect(
      parts(CiCredentials.create({ iterations: 8192 }).verifier).iterations,
    ).toBe(8192);
    expectCode(
      () => CiCredentials.create({ iterations: 1000 }),
      "ITERATIONS_INVALID",
    );
  });

  test.each([
    ["the password draw fails", sequence().random, "RANDOM_SOURCE_FAILED"],
    [
      "the salt draw is invalid",
      sequence(counting(32), Buffer.alloc(16)).random,
      "RANDOM_SOURCE_INVALID",
    ],
  ] as const)("fails closed when %s", (_name, random, code) => {
    expectCode(() => CiCredentials.create({ random }), code);
  });

  test("redacts itself when printed, interpolated, or serialized", () => {
    const credentials = CiCredentials.create();
    const outputs = [
      String(credentials),
      `${credentials}`,
      JSON.stringify(credentials),
      JSON.stringify({ credentials }),
      inspect(credentials),
      inspect({ nested: credentials }, { depth: 5, showHidden: true }),
      Object.keys(credentials).join(","),
    ];
    for (const output of outputs) {
      expect(output).not.toContain(credentials.password);
      expect(output).not.toContain(credentials.verifier);
      expect(output).not.toContain("postgresql://");
    }
  });
});

describe("the module", () => {
  test("prints nothing", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    try {
      const credentials = CiCredentials.create();
      credentials.maskCommands();
      githubEnvEntry("TEST_DATABASE_URL", credentials.testDatabaseUrl);
      expect(() => generatePassword(() => Buffer.alloc(32))).toThrow();
      for (const spy of [...spies, stdout, stderr]) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of [...spies, stdout, stderr]) spy.mockRestore();
    }
  });

  test("imports no file-system, process, or network module", () => {
    const source = readFileSync(
      new URL("./ci-credentials.ts", import.meta.url),
      "utf8",
    );
    const imports = [...source.matchAll(/^import[^;]*from "([^"]+)";/gm)].map(
      (match) => match[1],
    );
    expect(imports.sort()).toEqual([
      "../../../src/lib/db/env",
      "./test-database-target",
      "node:crypto",
      "node:util",
    ]);
    expect(source).not.toMatch(/process\.env|writeFile|appendFile|openSync/);
  });
});
