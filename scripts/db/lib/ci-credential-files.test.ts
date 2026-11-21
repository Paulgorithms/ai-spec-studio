import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseTestDatabaseEnv } from "../../../src/lib/db/env";
import {
  CI_CREDENTIAL_DIRECTORY,
  CI_CREDENTIAL_FILES,
  CI_CREDENTIAL_STEP_CODES,
  nodeCredentialFileSystem,
  runCiCredentialStep,
  writeCiCredentialFiles,
  type CiCredentialStepOptions,
  type CredentialFileSystem,
} from "./ci-credential-files";
import {
  isScramVerifier,
  scramSha256Verifier,
  type RandomSource,
} from "./ci-credentials";
import { checkTestDatabaseConfiguration } from "./test-database-target";

// These tests start real processes (bash, tsx, stubs) many times over. In
// the full suite, with every file running in parallel, they take several
// times longer than alone, close to Vitest's 5-second default, so this file
// gets 30 seconds per test. vi.setConfig applies to this file only: Vitest
// resets it after each file.
vi.setConfig({ testTimeout: 30_000 });

// Real directories under the OS temp directory, laid out like a
// GitHub-hosted runner's (see ci-runner.test.ts). The base is resolved first
// so macOS's /var -> /private/var link doesn't look like an attack.
const UID = process.getuid?.() ?? 0;
const SECRET = "FakeSecret:p@ss/word";
const ENV_FILE = "set_env_0d6a3c51-2f7e-4b8a-9c1d-5e6f7a8b9c0d";

let base: string;
let runnerTemp: string;
let directory: string;
let urlFile: string;
let verifierFile: string;
let urlPartial: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ci-credential-files-")));
  runnerTemp = `${base}/_temp`;
  const fileCommands = `${runnerTemp}/_runner_file_commands`;
  mkdirSync(fileCommands, { recursive: true, mode: 0o755 });
  chmodSync(runnerTemp, 0o755);
  chmodSync(fileCommands, 0o755);
  writeFileSync(`${fileCommands}/${ENV_FILE}`, "", { mode: 0o644 });
  chmodSync(`${fileCommands}/${ENV_FILE}`, 0o644);
  directory = `${runnerTemp}/${CI_CREDENTIAL_DIRECTORY}`;
  urlFile = `${directory}/${CI_CREDENTIAL_FILES.testDatabaseUrl}`;
  verifierFile = `${directory}/${CI_CREDENTIAL_FILES.testRoleVerifier}`;
  urlPartial = `${directory}/.${CI_CREDENTIAL_FILES.testDatabaseUrl}.partial`;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function runnerEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    GITHUB_ACTIONS: "true",
    CI: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    RUNNER_TEMP: runnerTemp,
    GITHUB_ENV: `${runnerTemp}/_runner_file_commands/${ENV_FILE}`,
    PATH: "/usr/bin:/bin",
    ...overrides,
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  return env;
}

type Run = {
  code: number;
  output: string[];
  events: string[];
  random: ReturnType<typeof vi.fn<RandomSource>>;
};

// Runs the step with real files, a recorded stdout, and optional
// file-system overrides. `events` records the order of output and
// file-system writes.
function run(
  options: {
    env?: Record<string, string | undefined>;
    fs?: Partial<CredentialFileSystem>;
    random?: RandomSource;
    write?: (text: string) => void;
    uid?: number | undefined;
  } = {},
): Run {
  const output: string[] = [];
  const events: string[] = [];
  const real = nodeCredentialFileSystem;
  const overrides = options.fs ?? {};
  const fs: CredentialFileSystem = {
    ...real,
    ...overrides,
    mkdir: (path, mode) => {
      events.push("mkdir");
      (overrides.mkdir ?? real.mkdir)(path, mode);
    },
    open: (path, flags, mode) => {
      events.push("open");
      return (overrides.open ?? real.open)(path, flags, mode);
    },
    link: (existing, path) => {
      events.push("link");
      (overrides.link ?? real.link)(existing, path);
    },
  };
  const random = vi.fn<RandomSource>(
    options.random ?? ((size) => realRandom(size)),
  );
  const stepOptions: CiCredentialStepOptions = {
    env: options.env ?? runnerEnv(),
    platform: "linux",
    uid: "uid" in options ? options.uid : UID,
    fs,
    random,
    write: (text) => {
      events.push("write");
      (options.write ?? ((t: string) => output.push(t)))(text);
    },
  };
  return { code: runCiCredentialStep(stepOptions), output, events, random };
}

function realRandom(size: number): Buffer {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(size)));
}

function maskedValues(output: string[]): string[] {
  const first = output[0] ?? "";
  if (!first.startsWith("::add-mask::")) return [];
  return first
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^::add-mask::/, ""));
}

function expectFailure(
  result: Run,
  code: keyof typeof CI_CREDENTIAL_STEP_CODES,
) {
  expect(result.code).toBe(1);
  const last = result.output.at(-1) ?? "";
  expect(last).toContain(`FAIL  ${code}: ${CI_CREDENTIAL_STEP_CODES[code]}`);
  return last;
}

function cleanupOf(result: Run): string | undefined {
  return /cleanup: (\S+)/.exec(result.output.at(-1) ?? "")?.[1];
}

const enoent = () =>
  Object.assign(new Error(`ENOENT ${SECRET}`), { code: "ENOENT" });
const errno = (code: string) =>
  Object.assign(new Error(`${code}: ${SECRET} ${base}`), { code });

describe("runCiCredentialStep: success", () => {
  test("writes exactly two 0600 files in a new 0700 directory", () => {
    const result = run();
    expect(result.code).toBe(0);
    const dir = lstatSync(directory);
    expect(dir.isDirectory()).toBe(true);
    expect(dir.mode & 0o7777).toBe(0o700);
    expect(dir.uid).toBe(UID);
    expect(readdirSync(directory).sort()).toEqual(
      [
        CI_CREDENTIAL_FILES.testDatabaseUrl,
        CI_CREDENTIAL_FILES.testRoleVerifier,
      ].sort(),
    );
    for (const file of [urlFile, verifierFile]) {
      const entry = lstatSync(file);
      expect(entry.isFile()).toBe(true);
      expect(entry.isSymbolicLink()).toBe(false);
      expect(entry.mode & 0o7777).toBe(0o600);
      expect(entry.uid).toBe(UID);
      expect(entry.nlink).toBe(1);
    }
  });

  test("the URL file passes the project's test database validators", () => {
    expect(run().code).toBe(0);
    const url = readFileSync(urlFile, "utf8");
    expect(url).not.toMatch(/\s/);
    const env = { TEST_DATABASE_URL: url };
    expect(parseTestDatabaseEnv(env).ok).toBe(true);
    const failed: string[] = [];
    expect(
      checkTestDatabaseConfiguration(env, (pass, label) => {
        if (!pass) failed.push(label);
      }),
    ).toBeDefined();
    expect(failed).toEqual([]);
  });

  test("the verifier file is the verifier for the URL's password", () => {
    expect(run().code).toBe(0);
    const verifier = readFileSync(verifierFile, "utf8");
    expect(isScramVerifier(verifier)).toBe(true);
    const parsed = parseTestDatabaseEnv({
      TEST_DATABASE_URL: readFileSync(urlFile, "utf8"),
    });
    if (!parsed.ok) throw new Error("URL file invalid");
    const [, iterations, salt] =
      /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(verifier) ?? [];
    expect(
      scramSha256Verifier(parsed.value.connection.password, {
        iterations: Number(iterations),
        salt: Buffer.from(salt ?? "", "base64"),
      }),
    ).toBe(verifier);
  });

  test("prints the masks first, then one PASS line, and nothing else", () => {
    const result = run();
    expect(result.output).toHaveLength(2);
    const masks = result.output[0]?.split("\n").filter(Boolean) ?? [];
    expect(masks).toHaveLength(2);
    expect(masks.every((line) => line.startsWith("::add-mask::"))).toBe(true);
    const [password, verifier] = maskedValues(result.output);
    expect(readFileSync(urlFile, "utf8")).toContain(`:${password}@`);
    expect(readFileSync(verifierFile, "utf8")).toBe(verifier);
    expect(result.output[1]).toMatch(
      /^PASS {2}CI test database credentials written/,
    );
  });

  test("masks the credentials before creating any file", () => {
    const { events } = run();
    expect(events[0]).toBe("write");
    expect(events.indexOf("write")).toBeLessThan(events.indexOf("mkdir"));
    expect(events.indexOf("mkdir")).toBeLessThan(events.indexOf("open"));
  });

  test("leaves no temporary files", () => {
    expect(run().code).toBe(0);
    expect(
      readdirSync(directory).filter((name) => name.endsWith(".partial")),
    ).toEqual([]);
  });

  test("handles short writes, a few bytes at a time", () => {
    const result = run({
      fs: {
        write: (fd, buffer, offset, length) =>
          nodeCredentialFileSystem.write(
            fd,
            buffer,
            offset,
            Math.min(length, 5),
          ),
      },
    });
    expect(result.code).toBe(0);
    expect(
      parseTestDatabaseEnv({ TEST_DATABASE_URL: readFileSync(urlFile, "utf8") })
        .ok,
    ).toBe(true);
    expect(isScramVerifier(readFileSync(verifierFile, "utf8"))).toBe(true);
  });

  test("never changes the environment or GITHUB_ENV", () => {
    const env = Object.freeze(runnerEnv());
    const processEnv = { ...process.env };
    const result = runCiCredentialStep({
      env,
      platform: "linux",
      uid: UID,
      write: () => {},
    });
    expect(result).toBe(0);
    expect(process.env).toEqual(processEnv);
    expect(readFileSync(env.GITHUB_ENV ?? "", "utf8")).toBe("");
  });
});

describe("runCiCredentialStep: refused before any credential exists", () => {
  test.each([
    [
      "no GitHub Actions",
      runnerEnv({ GITHUB_ACTIONS: undefined }),
      "NOT_GITHUB_ACTIONS",
    ],
    [
      "a self-hosted runner",
      runnerEnv({ RUNNER_ENVIRONMENT: "self-hosted" }),
      "NOT_GITHUB_HOSTED",
    ],
    [
      "a TEST_DATABASE_URL already set",
      runnerEnv({ TEST_DATABASE_URL: SECRET }),
      "DATABASE_VARIABLE_SET",
    ],
    [
      "a PGPASSWORD set",
      runnerEnv({ PGPASSWORD: SECRET }),
      "UNEXPECTED_VARIABLE_SET",
    ],
    [
      "an unsafe RUNNER_TEMP",
      runnerEnv({ RUNNER_TEMP: "/a/../b" }),
      "RUNNER_TEMP_INVALID",
    ],
  ])("%s", (_name, env, code) => {
    const result = run({ env });
    expect(result.code).toBe(1);
    expect(result.random).not.toHaveBeenCalled();
    expect(result.events).not.toContain("mkdir");
    expect(result.output).toHaveLength(1);
    expect(result.output[0]).toMatch(/^FAIL {2}CI credential step refused\n/);
    expect(result.output[0]).toContain(`${code}:`);
    expect(result.output[0]).not.toContain(SECRET);
    expect(existsSync(directory)).toBe(false);
  });

  test.each([
    "POSTGRES_PASSWORD",
    "POSTGRES_USER",
    "POSTGRES_DB",
    "POSTGRES_HOST_AUTH_METHOD",
    "POSTGRES_PASSWORD_FILE",
    "POSTGRES_INITDB_ARGS",
    "postgres_password",
  ])("a %s variable, even empty", (name) => {
    for (const value of [SECRET, ""]) {
      const result = run({ env: runnerEnv({ [name]: value }) });
      expect(result.code).toBe(1);
      expect(result.output).toHaveLength(1);
      expect(result.output[0]).toMatch(/^FAIL {2}CI credential step refused\n/);
      expect(result.output[0]).toContain(
        `POSTGRES_VARIABLE_SET: ${CI_CREDENTIAL_STEP_CODES.POSTGRES_VARIABLE_SET}`,
      );
      expect(result.random).not.toHaveBeenCalled();
      expect(result.output.join("")).not.toContain(SECRET);
      expect(existsSync(directory)).toBe(false);
    }
  });

  test("POSTGRES look-alikes are allowed", () => {
    expect(
      run({ env: runnerEnv({ MY_POSTGRES_PASSWORD: SECRET, POSTGRESQL: "x" }) })
        .code,
    ).toBe(0);
  });

  test("an unavailable user ID", () => {
    const result = run({ uid: undefined });
    expect(result.code).toBe(1);
    expect(result.output[0]).toContain("UID_UNAVAILABLE:");
    expect(result.random).not.toHaveBeenCalled();
  });

  test("every runner and POSTGRES_* failure is reported together", () => {
    const result = run({
      env: runnerEnv({ CI: undefined, POSTGRES_PASSWORD: SECRET }),
    });
    expect(result.output[0]).toContain("NOT_CI:");
    expect(result.output[0]).toContain("POSTGRES_VARIABLE_SET:");
  });
});

describe("runCiCredentialStep: credential and mask failures", () => {
  test("a failing random source: no masks, no files", () => {
    const result = run({
      random: () => {
        throw new Error(SECRET);
      },
    });
    const line = expectFailure(result, "CREDENTIALS_FAILED");
    expect(line).toContain("(RANDOM_SOURCE_FAILED)");
    expect(result.output).toHaveLength(1);
    expect(result.events).not.toContain("mkdir");
    expect(result.output.join("")).not.toContain(SECRET);
  });

  test("an invalid random source: no masks, no files", () => {
    const result = run({ random: (size) => Buffer.alloc(size) });
    expect(expectFailure(result, "CREDENTIALS_FAILED")).toContain(
      "(RANDOM_SOURCE_INVALID)",
    );
    expect(existsSync(directory)).toBe(false);
  });

  test("a failed mask write: no files", () => {
    let calls = 0;
    const output: string[] = [];
    const result = run({
      write: (text) => {
        calls += 1;
        if (calls === 1) throw errno("EPIPE");
        output.push(text);
      },
    });
    expect(result.code).toBe(1);
    expect(output.join("")).toContain("MASK_OUTPUT_FAILED:");
    expect(result.events).not.toContain("mkdir");
    expect(existsSync(directory)).toBe(false);
  });

  test("still exits 1 when even the failure line can't be written", () => {
    const result = run({
      write: () => {
        throw errno("EPIPE");
      },
    });
    expect(result.code).toBe(1);
    expect(existsSync(directory)).toBe(false);
  });
});

describe("runCiCredentialStep: existing entries are never reused or replaced", () => {
  test.each([
    ["a directory", () => mkdirSync(directory, { mode: 0o700 })],
    ["a file", () => writeFileSync(directory, SECRET)],
    [
      "a symbolic link to a directory",
      () => {
        mkdirSync(`${base}/elsewhere`, { mode: 0o700 });
        symlinkSync(`${base}/elsewhere`, directory);
      },
    ],
    ["a broken symbolic link", () => symlinkSync(`${base}/nowhere`, directory)],
  ])("the credential directory already exists as %s", (_name, plant) => {
    plant();
    const before = lstatSync(directory);
    const result = run();
    expectFailure(result, "DIRECTORY_EXISTS");
    expect(cleanupOf(result)).toBe("nothing-created");
    const after = lstatSync(directory);
    expect(after.ino).toBe(before.ino);
    if (after.isFile()) expect(readFileSync(directory, "utf8")).toBe(SECRET);
    expect(
      existsSync(`${base}/elsewhere/${CI_CREDENTIAL_FILES.testDatabaseUrl}`),
    ).toBe(false);
  });

  test("a second run leaves the first run's files untouched", () => {
    expect(run().code).toBe(0);
    const url = readFileSync(urlFile, "utf8");
    const verifier = readFileSync(verifierFile, "utf8");
    expectFailure(run(), "DIRECTORY_EXISTS");
    expect(readFileSync(urlFile, "utf8")).toBe(url);
    expect(readFileSync(verifierFile, "utf8")).toBe(verifier);
  });

  test.each([
    ["a file", () => writeFileSync(urlPartial, SECRET)],
    ["a symbolic link", () => symlinkSync(`${base}/target`, urlPartial)],
  ])(
    "a planted temporary file (%s) fails, and is left alone",
    (_name, plant) => {
      const result = run({
        fs: {
          mkdir: (path, mode) => {
            nodeCredentialFileSystem.mkdir(path, mode);
            plant();
          },
        },
      });
      expectFailure(result, "PARTIAL_EXISTS");
      expect(cleanupOf(result)).toBe("incomplete");
      expect(lstatSync(urlPartial)).toBeDefined();
      expect(existsSync(`${base}/target`)).toBe(false);
    },
  );

  test("a planted destination file fails without being replaced", () => {
    const result = run({
      fs: {
        link: (existing, path) => {
          writeFileSync(path, SECRET);
          nodeCredentialFileSystem.link(existing, path);
        },
      },
    });
    expectFailure(result, "DESTINATION_EXISTS");
    expect(readFileSync(urlFile, "utf8")).toBe(SECRET);
    // Its own temporary file was removed; the planted one stays.
    expect(existsSync(urlPartial)).toBe(false);
    expect(cleanupOf(result)).toBe("incomplete");
  });

  test("a planted destination symbolic link fails without writing through it", () => {
    const outside = `${base}/outside`;
    writeFileSync(outside, "original");
    const result = run({
      fs: {
        link: (existing, path) => {
          symlinkSync(outside, path);
          nodeCredentialFileSystem.link(existing, path);
        },
      },
    });
    expectFailure(result, "DESTINATION_EXISTS");
    expect(readFileSync(outside, "utf8")).toBe("original");
    expect(lstatSync(urlFile).isSymbolicLink()).toBe(true);
  });
});

describe("runCiCredentialStep: the directory", () => {
  test("a directory made with the wrong mode is refused and left alone", () => {
    const result = run({
      fs: { mkdir: (path) => nodeCredentialFileSystem.mkdir(path, 0o755) },
    });
    expectFailure(result, "DIRECTORY_UNSAFE");
    expect(cleanupOf(result)).toBe("incomplete");
    expect(existsSync(directory)).toBe(true);
  });

  test("a directory swapped for a symbolic link right after creation is refused", () => {
    const result = run({
      fs: {
        mkdir: (path, mode) => {
          nodeCredentialFileSystem.mkdir(`${base}/swapped`, mode);
          symlinkSync(`${base}/swapped`, path);
        },
      },
    });
    expectFailure(result, "DIRECTORY_UNSAFE");
    expect(readdirSync(`${base}/swapped`)).toEqual([]);
  });

  test("a directory replaced between files is detected, and the new one isn't touched", () => {
    // After the first file is published and closed: move the real
    // directory away and put a look-alike in its place.
    const swap = () => {
      renameSync(directory, `${base}/moved`);
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
      writeFileSync(urlFile, SECRET);
    };
    let closes = 0;
    let swapped = false;
    let opensAfterSwap = 0;
    const result = run({
      fs: {
        close: (fd) => {
          nodeCredentialFileSystem.close(fd);
          closes += 1;
          if (closes === 1) {
            swap();
            swapped = true;
          }
        },
        open: (path, flags, mode) => {
          if (swapped) opensAfterSwap += 1;
          return nodeCredentialFileSystem.open(path, flags, mode);
        },
      },
    });
    expectFailure(result, "DIRECTORY_REPLACED");
    // Detected before the second credential is written anywhere.
    expect(opensAfterSwap).toBe(0);
    // The look-alike and its file are left exactly as they were.
    expect(readFileSync(urlFile, "utf8")).toBe(SECRET);
    expect(readdirSync(directory)).toEqual([
      CI_CREDENTIAL_FILES.testDatabaseUrl,
    ]);
    expect(cleanupOf(result)).toBe("incomplete");
  });

  test("a directory replaced mid-publish: the look-alike's entries aren't unlinked", () => {
    let links = 0;
    const result = run({
      fs: {
        link: (existing, path) => {
          nodeCredentialFileSystem.link(existing, path);
          links += 1;
          if (links === 1) {
            renameSync(directory, `${base}/moved`);
            mkdirSync(directory, { mode: 0o700 });
            chmodSync(directory, 0o700);
            writeFileSync(urlFile, SECRET);
            writeFileSync(urlPartial, SECRET);
          }
        },
      },
    });
    expectFailure(result, "FILE_REPLACED");
    expect(readFileSync(urlFile, "utf8")).toBe(SECRET);
    expect(readFileSync(urlPartial, "utf8")).toBe(SECRET);
    expect(cleanupOf(result)).toBe("incomplete");
  });

  test("an unexpected extra entry is detected", () => {
    let links = 0;
    const result = run({
      fs: {
        link: (existing, path) => {
          nodeCredentialFileSystem.link(existing, path);
          links += 1;
          if (links === 2) writeFileSync(`${directory}/extra`, "x");
        },
      },
    });
    expectFailure(result, "DIRECTORY_CONTENTS_UNEXPECTED");
    // Its own files are removed; the extra entry (and so the directory) stay.
    expect(readdirSync(directory)).toEqual(["extra"]);
    expect(cleanupOf(result)).toBe("incomplete");
  });

  test("a failed directory sync fails closed and cleans up", () => {
    let fsyncs = 0;
    const result = run({
      fs: {
        fsync: (fd) => {
          fsyncs += 1;
          if (fsyncs === 3) throw errno("EIO");
          nodeCredentialFileSystem.fsync(fd);
        },
      },
    });
    expect(expectFailure(result, "DIRECTORY_SYNC_FAILED")).toContain("(EIO)");
    expect(cleanupOf(result)).toBe("complete");
    expect(existsSync(directory)).toBe(false);
  });

  test("a failed mkdir reports its code", () => {
    const result = run({
      fs: {
        mkdir: () => {
          throw errno("EACCES");
        },
      },
    });
    expect(expectFailure(result, "DIRECTORY_CREATE_FAILED")).toContain(
      "(EACCES)",
    );
    expect(cleanupOf(result)).toBe("nothing-created");
  });
});

describe("runCiCredentialStep: files, links, and writes", () => {
  test("an extra hard link made while writing is detected after publishing", () => {
    let writes = 0;
    const result = run({
      fs: {
        write: (fd, buffer, offset, length) => {
          writes += 1;
          if (writes === 1) linkSync(urlPartial, `${base}/stolen`);
          return nodeCredentialFileSystem.write(fd, buffer, offset, length);
        },
      },
    });
    expectFailure(result, "PUBLISH_VERIFY_FAILED");
    expect(existsSync(urlFile)).toBe(false);
    expect(existsSync(directory)).toBe(false);
    expect(cleanupOf(result)).toBe("complete");
  });

  test("a hard link that exists when the file is opened is refused", () => {
    const result = run({
      fs: {
        open: (path, flags, mode) => {
          const fd = nodeCredentialFileSystem.open(path, flags, mode);
          if (path === urlPartial) linkSync(path, `${base}/early`);
          return fd;
        },
      },
    });
    expectFailure(result, "FILE_UNSAFE");
    expect(cleanupOf(result)).toBe("complete");
  });

  test("a file opened with the wrong mode is refused and removed", () => {
    const result = run({
      fs: {
        open: (path, flags, mode) => {
          const fd = nodeCredentialFileSystem.open(path, flags, mode);
          chmodSync(path, 0o644);
          return fd;
        },
      },
    });
    expectFailure(result, "FILE_UNSAFE");
    expect(cleanupOf(result)).toBe("complete");
    expect(existsSync(directory)).toBe(false);
  });

  test("a temporary file swapped for a symbolic link before publishing is refused", () => {
    const outside = `${base}/outside`;
    writeFileSync(outside, "original");
    let fsyncs = 0;
    const result = run({
      fs: {
        fsync: (fd) => {
          nodeCredentialFileSystem.fsync(fd);
          fsyncs += 1;
          if (fsyncs === 1) {
            unlinkSync(urlPartial);
            symlinkSync(outside, urlPartial);
          }
        },
      },
    });
    expectFailure(result, "FILE_REPLACED");
    expect(existsSync(urlFile)).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("original");
    // The link isn't what was created, so it's left.
    expect(lstatSync(urlPartial).isSymbolicLink()).toBe(true);
    expect(cleanupOf(result)).toBe("incomplete");
  });

  test.each([
    ["no progress", () => 0],
    ["a negative count", () => -1],
    ["a fractional count", () => 1.5],
    [
      "more than asked",
      (_fd: number, _b: Buffer, _o: number, length: number) => length + 1,
    ],
  ])("a write reporting %s fails closed", (_name, write) => {
    const result = run({ fs: { write } });
    expectFailure(result, "WRITE_FAILED");
    expect(cleanupOf(result)).toBe("complete");
    expect(existsSync(directory)).toBe(false);
  });

  test("a write that claims success without writing is caught by the size check", () => {
    const result = run({
      fs: { write: (_fd, _buffer, _offset, length) => length },
    });
    expectFailure(result, "WRITE_INCOMPLETE");
    expect(cleanupOf(result)).toBe("complete");
  });

  test.each([
    ["write", "WRITE_FAILED", "ENOSPC"],
    ["fsync", "FSYNC_FAILED", "EIO"],
    ["link", "PUBLISH_FAILED", "EXDEV"],
    ["open", "FILE_CREATE_FAILED", "EACCES"],
  ] as const)(
    "a failing %s reports %s (%s) and cleans up",
    (method, code, errorCode) => {
      const result = run({
        fs: {
          [method]: () => {
            throw errno(errorCode);
          },
        },
      });
      expect(expectFailure(result, code)).toContain(`(${errorCode})`);
      expect(["complete", "nothing-created"]).toContain(cleanupOf(result));
      expect(existsSync(directory)).toBe(false);
    },
  );

  test("a failure on the second file removes the first one too", () => {
    let opens = 0;
    const result = run({
      fs: {
        open: (path, flags, mode) => {
          opens += 1;
          if (opens === 2) throw errno("EMFILE");
          return nodeCredentialFileSystem.open(path, flags, mode);
        },
      },
    });
    expectFailure(result, "FILE_CREATE_FAILED");
    expect(cleanupOf(result)).toBe("complete");
    expect(existsSync(directory)).toBe(false);
  });

  test("a failure removing the temporary name cleans up both names", () => {
    let unlinks = 0;
    const result = run({
      fs: {
        unlink: (path) => {
          unlinks += 1;
          if (unlinks === 1) throw errno("EBUSY");
          nodeCredentialFileSystem.unlink(path);
        },
      },
    });
    expectFailure(result, "PUBLISH_FAILED");
    expect(cleanupOf(result)).toBe("complete");
    expect(existsSync(directory)).toBe(false);
  });

  test("a failing close reports CLOSE_FAILED", () => {
    let closes = 0;
    const result = run({
      fs: {
        close: (fd) => {
          nodeCredentialFileSystem.close(fd);
          closes += 1;
          if (closes === 1) throw errno("EIO");
        },
      },
    });
    expectFailure(result, "CLOSE_FAILED");
    expect(cleanupOf(result)).toBe("complete");
  });
});

describe("runCiCredentialStep: cleanup", () => {
  test("a cleanup failure is reported as incomplete", () => {
    const result = run({
      fs: {
        write: () => {
          throw errno("ENOSPC");
        },
        unlink: () => {
          throw errno("EPERM");
        },
      },
    });
    expectFailure(result, "WRITE_FAILED");
    expect(cleanupOf(result)).toBe("incomplete");
    // Nothing was removed recursively: the temporary file and the directory
    // are both still there.
    expect(existsSync(urlPartial)).toBe(true);
  });

  test("an entry that disappeared on its own doesn't make cleanup incomplete", () => {
    const result = run({
      fs: {
        write: () => {
          unlinkSync(urlPartial);
          throw errno("EIO");
        },
      },
    });
    expectFailure(result, "WRITE_FAILED");
    expect(cleanupOf(result)).toBe("complete");
  });

  test("an unreadable entry during cleanup is left and reported", () => {
    let failing = false;
    const result = run({
      fs: {
        write: () => {
          failing = true;
          throw errno("EIO");
        },
        lstat: (path) => {
          if (failing && path === urlPartial) throw errno("EACCES");
          return nodeCredentialFileSystem.lstat(path);
        },
      },
    });
    expectFailure(result, "WRITE_FAILED");
    expect(cleanupOf(result)).toBe("incomplete");
  });

  test("writeCiCredentialFiles never removes a directory it didn't create", () => {
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(`${directory}/keep`, "x");
    const result = writeCiCredentialFiles(
      runnerTemp,
      [{ name: "a", content: "b" }],
      UID,
    );
    expect(result).toEqual({
      ok: false,
      code: "DIRECTORY_EXISTS",
      detail: "EEXIST",
      cleanup: "nothing-created",
    });
    expect(readFileSync(`${directory}/keep`, "utf8")).toBe("x");
  });
});

describe("runCiCredentialStep: no secret leaks", () => {
  const scenarios: Array<[string, Parameters<typeof run>[0]]> = [
    ["success", {}],
    [
      "write failure",
      {
        fs: {
          write: () => {
            throw errno("ENOSPC");
          },
        },
      },
    ],
    [
      "link failure",
      {
        fs: {
          link: () => {
            throw errno("EXDEV");
          },
        },
      },
    ],
    [
      "mkdir failure",
      {
        fs: {
          mkdir: () => {
            throw errno("EACCES");
          },
        },
      },
    ],
    [
      "cleanup failure",
      {
        fs: {
          write: () => {
            throw errno("EIO");
          },
          unlink: () => {
            throw enoent();
          },
        },
      },
    ],
    ["runner refused", { env: runnerEnv({ PGPASSWORD: SECRET }) }],
    ["POSTGRES_* refused", { env: runnerEnv({ POSTGRES_PASSWORD: SECRET }) }],
  ];

  test.each(scenarios)(
    "%s: credentials appear only in the leading mask lines",
    (_name, options) => {
      const result = run(options);
      const [password, verifier] = maskedValues(result.output);
      const rest = result.output.slice(password ? 1 : 0).join("");
      if (password) {
        expect(password).toMatch(/^[0-9a-f]{64}$/);
        expect(isScramVerifier(verifier)).toBe(true);
        expect(rest).not.toContain(password);
        expect(rest).not.toContain(verifier ?? "");
        expect(rest).not.toContain("::add-mask::");
      }
      const all = result.output.join("");
      expect(all).not.toContain("FakeSecret");
      expect(all).not.toContain(base);
      expect(all).not.toMatch(/postgres(ql)?:\/\//);
    },
  );

  test("the modules run no shell or child process and never touch GITHUB_ENV or process.env", () => {
    for (const file of ["./ci-credential-files.ts", "../ci-credentials.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /child_process|execSync|spawn|process\.env\s*\[|process\.env\.\w+\s*=/,
      );
      expect(source).not.toMatch(/GITHUB_ENV(?!\s+or)/);
    }
  });
});

describe("the entry script", () => {
  const tsx = join(process.cwd(), "node_modules/.bin/tsx");
  const script = join(process.cwd(), "scripts/db/ci-credentials.ts");
  // A plain environment: no GitHub runner variables, so it must refuse.
  const plainEnv = (): NodeJS.ProcessEnv => ({
    NODE_ENV: "test",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: base,
  });

  test("refuses outside a GitHub-hosted runner and creates nothing", () => {
    const result = spawnSync(tsx, [script], {
      cwd: base,
      env: plainEnv(),
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^FAIL {2}CI credential step refused\n/);
    expect(result.stdout).toContain("NOT_GITHUB_ACTIONS:");
    expect(result.stdout).not.toContain("::add-mask::");
    expect(result.stderr).toBe("");
    expect(readdirSync(base)).toEqual(["_temp"]);
  });

  test("rejects arguments with exit code 2", () => {
    const result = spawnSync(tsx, [script, "extra"], {
      cwd: base,
      env: plainEnv(),
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("Usage: tsx scripts/db/ci-credentials.ts\n");
  });
});

test("runs every test with this file's 30-second timeout", ({ task }) => {
  expect(task.timeout).toBe(30_000);
});
