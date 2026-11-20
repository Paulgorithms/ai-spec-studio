import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LOCAL_ENV_FILE, loadLocalEnv } from "./local-env";

// Fixtures are synthetic and live in a fresh temporary directory; the real
// .env.local is never read. Tests pass their own env object, except one that
// sets two uniquely named process.env variables and removes them afterwards.
const PASSWORD = "FakeSecret:p@ss/word";
const TEST_URL = `postgresql://ai_spec_studio_test_runner:${encodeURIComponent(PASSWORD)}@127.0.0.1:5432/ai_spec_studio_test`;
const BOM = "\uFEFF";

type Env = Record<string, string | undefined>;

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "local-env-test-"));
  file = join(dir, LOCAL_ENV_FILE);
});

afterEach(() => {
  try {
    chmodSync(file, 0o600);
  } catch {
    // No file in this test.
  }
  rmSync(dir, { recursive: true, force: true });
});

function codeError(code: string): Error {
  return Object.assign(new Error(`${code}: open '${TEST_URL}'`), { code });
}

function expectNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(encodeURIComponent(PASSWORD));
  expect(text).not.toContain("postgresql://");
}

// What process.loadEnvFile() does with a file, in a fresh Node process whose
// environment is exactly `preset`: every variable it ends up with that it
// didn't start with, plus the preset ones.
function nodeLoadEnvFile(path: string, preset: Env = {}): Env {
  const script = `
    const preset = JSON.parse(process.argv[2]);
    const before = new Set(Object.keys(process.env));
    process.loadEnvFile(process.argv[1]);
    const out = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!before.has(key) || key in preset) out[key] = value;
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const output = execFileSync(
    process.execPath,
    ["-e", script, path, JSON.stringify(preset)],
    { env: preset as NodeJS.ProcessEnv, encoding: "utf8" },
  );
  return JSON.parse(output) as Env;
}

describe("loadLocalEnv", () => {
  test("defaults to .env.local in the working directory", () => {
    expect(LOCAL_ENV_FILE).toBe(".env.local");
  });

  test("a missing file is accepted and leaves the environment alone", () => {
    const env: Env = { TEST_DATABASE_URL: TEST_URL };
    expect(loadLocalEnv({ path: file, env })).toEqual({
      ok: true,
      source: "none",
    });
    expect(env).toEqual({ TEST_DATABASE_URL: TEST_URL });
  });

  test("an existing valid file is loaded", () => {
    writeFileSync(
      file,
      [
        "# comment",
        "",
        `TEST_DATABASE_URL=${TEST_URL}`,
        "export DATABASE_SSL_MODE=disable",
        'QUOTED="a b"  # inline comment',
        "SINGLE='x'",
        "EMPTY=",
        "",
      ].join("\n"),
    );
    const env: Env = {};
    expect(loadLocalEnv({ path: file, env })).toEqual({
      ok: true,
      source: "file",
    });
    expect(env).toEqual({
      TEST_DATABASE_URL: TEST_URL,
      DATABASE_SSL_MODE: "disable",
      QUOTED: "a b",
      SINGLE: "x",
      EMPTY: "",
    });
  });

  test("variables already set win, even when empty (as loadEnvFile)", () => {
    writeFileSync(file, "A=file\nB=file\nC=file\n");
    const env: Env = { A: "shell", B: "" };
    expect(loadLocalEnv({ path: file, env }).ok).toBe(true);
    expect(env).toEqual({ A: "shell", B: "", C: "file" });
  });

  test("defaults to process.env, keeping what is already set", () => {
    const shell = "LOCAL_ENV_TEST_SHELL";
    const fromFile = "LOCAL_ENV_TEST_FILE";
    vi.stubEnv(shell, "shell");
    writeFileSync(file, `${shell}=file\n${fromFile}=file\n`);
    try {
      expect(loadLocalEnv({ path: file }).ok).toBe(true);
      expect(process.env[shell]).toBe("shell");
      expect(process.env[fromFile]).toBe("file");
    } finally {
      delete process.env[fromFile];
      vi.unstubAllEnvs();
    }
  });

  test.skipIf(process.getuid?.() === 0)(
    "an unreadable file is rejected as EACCES, not treated as missing",
    () => {
      writeFileSync(file, `TEST_DATABASE_URL=${TEST_URL}\n`);
      chmodSync(file, 0o000);
      const env: Env = {};
      expect(loadLocalEnv({ path: file, env })).toEqual({
        ok: false,
        reason: "EACCES",
      });
      expect(env).toEqual({});
    },
  );

  test.each(["EACCES", "EPERM", "EIO", "EMFILE"])(
    "%s from the read is rejected by code only",
    (code) => {
      const env: Env = {};
      const result = loadLocalEnv({
        path: file,
        env,
        readFile: () => {
          throw codeError(code);
        },
      });
      expect(result).toEqual({ ok: false, reason: code });
      expect(env).toEqual({});
      expectNoSecrets(result);
    },
  );

  test("a directory in place of the file is rejected", () => {
    mkdirSync(file);
    const result = loadLocalEnv({ path: file, env: {} });
    expect(result).toEqual({ ok: false, reason: "EISDIR" });
  });

  test("errors without a recognizable code are rejected without their message", () => {
    for (const thrown of [
      new Error(TEST_URL),
      Object.assign(new Error(TEST_URL), { code: TEST_URL }),
      TEST_URL,
      null,
    ]) {
      const result = loadLocalEnv({
        path: file,
        env: {},
        readFile: () => {
          throw thrown;
        },
      });
      expect(result).toEqual({ ok: false, reason: "unknown error" });
    }
  });

  describe("symbolic links", () => {
    test("a link whose target is missing is rejected, not treated as missing", () => {
      symlinkSync(join(dir, "does-not-exist"), file);
      const env: Env = {};
      expect(loadLocalEnv({ path: file, env })).toEqual({
        ok: false,
        reason: "broken symbolic link",
      });
      expect(env).toEqual({});
    });

    test("a link into a missing directory is rejected too", () => {
      symlinkSync(join(dir, "gone", "env"), file);
      expect(loadLocalEnv({ path: file, env: {} })).toEqual({
        ok: false,
        reason: "broken symbolic link",
      });
    });

    test("a link to a real file is followed", () => {
      const target = join(dir, "target.env");
      writeFileSync(target, "A=1\n");
      symlinkSync(target, file);
      const env: Env = {};
      expect(loadLocalEnv({ path: file, env })).toEqual({
        ok: true,
        source: "file",
      });
      expect(env).toEqual({ A: "1" });
    });

    test("ENOENT with an entry that isn't a link (it appeared since) is rejected", () => {
      const result = loadLocalEnv({
        path: file,
        env: {},
        readFile: () => {
          throw codeError("ENOENT");
        },
        lstat: () => ({ isSymbolicLink: () => false }),
      });
      expect(result).toEqual({ ok: false, reason: "ENOENT" });
    });

    test("an lstat error other than ENOENT is rejected by code only", () => {
      const result = loadLocalEnv({
        path: file,
        env: {},
        readFile: () => {
          throw codeError("ENOENT");
        },
        lstat: () => {
          throw codeError("EACCES");
        },
      });
      expect(result).toEqual({ ok: false, reason: "EACCES" });
      expectNoSecrets(result);
    });
  });

  test("a NUL byte is rejected without applying anything", () => {
    writeFileSync(file, `A=1\nTEST_DATABASE_URL=${TEST_URL}\0\n`);
    const env: Env = {};
    const result = loadLocalEnv({ path: file, env });
    expect(result).toEqual({ ok: false, reason: "NUL byte" });
    expect(env).toEqual({});
    expectNoSecrets(result);
  });

  test("invalid UTF-8 is rejected without applying anything", () => {
    writeFileSync(
      file,
      Buffer.concat([
        Buffer.from(`A=1\nTEST_DATABASE_URL=${TEST_URL}`),
        Buffer.from([0xff, 0xfe, 0x0a]),
      ]),
    );
    const env: Env = {};
    const result = loadLocalEnv({ path: file, env });
    expect(result).toEqual({ ok: false, reason: "invalid UTF-8" });
    expect(env).toEqual({});
    expectNoSecrets(result);
  });

  test("never writes to the console", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      writeFileSync(file, `TEST_DATABASE_URL=${TEST_URL}\n`);
      loadLocalEnv({ path: file, env: {} });
      writeFileSync(file, `TEST_DATABASE_URL=${TEST_URL}\0\n`);
      loadLocalEnv({ path: file, env: {} });
      loadLocalEnv({ path: join(dir, "missing"), env: {} });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// Each fixture goes through process.loadEnvFile() in a fresh Node process and
// through loadLocalEnv(); the variables they produce must be identical.
describe("matches process.loadEnvFile()", () => {
  const PEM = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
  const cases: Array<[string, string]> = [
    ["a plain assignment", "A=1\n"],
    ["spaces around =", "A = 1\n"],
    ["export", "export A=1\n"],
    ["an inline comment", "A=1 # comment\n"],
    ["# without a space", "A=1#comment\n"],
    ["comment and blank lines only", "# one\n\n   \n\t# two\n"],
    ["an empty file", ""],
    ["empty values", "A=\nB=\"\"\nC=''\n"],
    ["trailing whitespace", "A=1   \n"],
    ["indentation", "\tA=1\n  B=2\n"],
    ["repeated names (last wins)", "A=1\nA=2\n"],
    ["double-quote escapes", 'A="x\\ny\\t\\"q\\""\n'],
    ["single quotes stay literal", "A='x\\ny'\n"],
    ["backticks", "A=`x 'y' \"z\"`\n"],
    ["a multiline double-quoted value", 'A="line1\nline2"\nB=2\n'],
    ["a multiline single-quoted value", "A='line1\nline2'\nB=2\n"],
    ["a multiline backtick value", "A=`line1\nline2`\nB=2\n"],
    ["a multiline PEM", `DATABASE_SSL_CA="${PEM}"\nB=2\n`],
    ["an escaped PEM", `DATABASE_SSL_CA="${PEM.replaceAll("\n", "\\n")}"\n`],
    ["an unterminated double quote", 'A="abc\nB=2\n'],
    ["an unterminated single quote", "A='abc\nB=2\n"],
    ["a quote inside a value", 'A=ab"c\n'],
    ["text after a closing quote", 'A="x" y\n'],
    ["a backslash before the closing quote", 'A="abc\\"\nB=2\n'],
    ["a dot in a name", "A.B=1\n"],
    ["a dash in a name", "A-B=1\n"],
    ["a lowercase name", "a_b=1\n"],
    ["a name starting with a digit", "1A=1\n"],
    ["a line without =", "JUNK\nA=1\n"],
    ["export without a value", "export A\nB=1\n"],
    ["an empty name", "=1\nA=1\n"],
    ["a ; line", "; comment\nA=1\n"],
    ["CRLF line endings", "A=1\r\nB=2\r\n"],
    ["lone CR line endings", "A=1\rB=2\r"],
    ["a byte order mark", `${BOM}A=1\nB=2\n`],
    ["= inside a value", "A=postgresql://u:p@h:5432/d?x=1\n"],
    ["non-ASCII text", "A=héllo\n"],
  ];

  test.each(cases)("%s", (_, text) => {
    writeFileSync(file, text);
    const env: Env = {};
    expect(loadLocalEnv({ path: file, env })).toEqual({
      ok: true,
      source: "file",
    });
    expect(env).toEqual(nodeLoadEnvFile(file));
  });

  test("precedence: set variables win, even when empty", () => {
    writeFileSync(file, "A=file\nB=file\nC=file\n");
    const preset: Env = { A: "", B: "shell" };
    const env: Env = { ...preset };
    loadLocalEnv({ path: file, env });
    expect(env).toEqual(nodeLoadEnvFile(file, preset));
    expect(env).toEqual({ A: "", B: "shell", C: "file" });
  });

  test("a byte order mark stays part of the first name, as in Node", () => {
    writeFileSync(file, `${BOM}A=1\n`);
    const env: Env = {};
    loadLocalEnv({ path: file, env });
    expect(env).toEqual({ [`${BOM}A`]: "1" });
  });
});
