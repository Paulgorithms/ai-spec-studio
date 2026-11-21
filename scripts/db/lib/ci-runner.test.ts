import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DATABASE_VARIABLES } from "../../../src/lib/db/testing/integration-run";
import {
  CI_RUNNER_CODES,
  checkCiRunner,
  describeCiRunnerCodes,
  type CiRunnerCode,
  type CiRunnerOptions,
  type CiRunnerResult,
} from "./ci-runner";

// The fixtures are real directories under the OS temp directory, laid out
// like a GitHub-hosted runner's:
//   <base>/_temp/_runner_file_commands/set_env_<id>
// The base is resolved first, so a temp directory reached through a symbolic
// link (macOS's /var -> /private/var) doesn't look like an attack.
const UID = process.getuid?.() ?? 0;
const SECRET = "FakeSecret:p@ss/word";
const ENV_FILE = "set_env_0d6a3c51-2f7e-4b8a-9c1d-5e6f7a8b9c0d";

let base: string;
let runnerTemp: string;
let fileCommands: string;
let githubEnv: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ci-runner-")));
  runnerTemp = `${base}/_temp`;
  fileCommands = `${runnerTemp}/_runner_file_commands`;
  githubEnv = `${fileCommands}/${ENV_FILE}`;
  mkdirSync(fileCommands, { recursive: true, mode: 0o755 });
  chmodSync(runnerTemp, 0o755);
  chmodSync(fileCommands, 0o755);
  writeFileSync(githubEnv, "", { mode: 0o644 });
  chmodSync(githubEnv, 0o644);
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
    GITHUB_ENV: githubEnv,
    PATH: "/usr/bin:/bin",
    HOME: "/home/runner",
    ...overrides,
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  return env;
}

const LINUX: CiRunnerOptions = { platform: "linux", uid: UID };

function check(
  env: Record<string, string | undefined>,
  options: CiRunnerOptions = {},
): CiRunnerResult {
  return checkCiRunner(env, { ...LINUX, ...options });
}

function codesOf(result: CiRunnerResult): CiRunnerCode[] {
  return result.ok ? [] : result.codes;
}

describe("checkCiRunner: a GitHub-hosted Linux runner", () => {
  test("passes and returns the checked paths", () => {
    expect(check(runnerEnv())).toEqual({
      ok: true,
      runnerTemp,
      githubEnv,
    });
  });

  test("passes with GITHUB_ENV directly inside RUNNER_TEMP", () => {
    const direct = `${runnerTemp}/${ENV_FILE}`;
    writeFileSync(direct, "", { mode: 0o600 });
    expect(check(runnerEnv({ GITHUB_ENV: direct }))).toEqual({
      ok: true,
      runnerTemp,
      githubEnv: direct,
    });
  });

  test.each([undefined, "test", "development", ""])(
    "passes with NODE_ENV %j",
    (nodeEnv) => {
      expect(check(runnerEnv({ NODE_ENV: nodeEnv })).ok).toBe(true);
    },
  );

  test("ignores unrelated variables, including look-alike names", () => {
    const env = runnerEnv({
      GITHUB_SHA: "0123456789abcdef",
      MY_DATABASE_URL: SECRET,
      DATABASE_URL_BACKUP: SECRET,
      XPGHOST: "elsewhere",
      pghost: "elsewhere",
    });
    expect(check(env).ok).toBe(true);
  });

  test("passes with a private (0700) RUNNER_TEMP and a 0600 GITHUB_ENV", () => {
    chmodSync(runnerTemp, 0o700);
    chmodSync(githubEnv, 0o600);
    expect(check(runnerEnv()).ok).toBe(true);
  });

  test("never changes the environment it checks", () => {
    const env = Object.freeze(runnerEnv());
    const before = { ...env };
    check(env);
    expect(env).toEqual(before);
  });

  test("uses the real process user ID by default", () => {
    expect(checkCiRunner(runnerEnv(), { platform: "linux" }).ok).toBe(true);
  });
});

describe("checkCiRunner: runner identity (exact values only)", () => {
  test.each([
    ["GITHUB_ACTIONS", "NOT_GITHUB_ACTIONS"],
    ["CI", "NOT_CI"],
    ["RUNNER_ENVIRONMENT", "NOT_GITHUB_HOSTED"],
    ["RUNNER_OS", "NOT_LINUX_RUNNER"],
  ] as const)("%s unset fails with %s", (name, code) => {
    expect(codesOf(check(runnerEnv({ [name]: undefined })))).toEqual([code]);
  });

  test.each(["", "TRUE", "True", "true ", " true", "1", "yes", "false"])(
    "GITHUB_ACTIONS and CI %j fail",
    (value) => {
      expect(
        codesOf(check(runnerEnv({ GITHUB_ACTIONS: value, CI: value }))),
      ).toEqual(["NOT_GITHUB_ACTIONS", "NOT_CI"]);
    },
  );

  test.each(["self-hosted", "", "github-hosted ", "GitHub-hosted", "hosted"])(
    "RUNNER_ENVIRONMENT %j fails",
    (value) => {
      expect(codesOf(check(runnerEnv({ RUNNER_ENVIRONMENT: value })))).toEqual([
        "NOT_GITHUB_HOSTED",
      ]);
    },
  );

  test.each(["macOS", "Windows", "linux", "LINUX", "Linux ", ""])(
    "RUNNER_OS %j fails",
    (value) => {
      expect(codesOf(check(runnerEnv({ RUNNER_OS: value })))).toEqual([
        "NOT_LINUX_RUNNER",
      ]);
    },
  );

  test.each(["darwin", "win32", "freebsd"] as const)(
    "a %s process fails even when RUNNER_OS says Linux",
    (platform) => {
      expect(codesOf(check(runnerEnv(), { platform }))).toEqual([
        "NOT_LINUX_PLATFORM",
      ]);
    },
  );

  test.each([undefined, -1, 1.5, Number.NaN])(
    "an unavailable or invalid user ID (%j) fails without touching the file system",
    (uid) => {
      const lstat = vi.fn((file: string) => lstatSync(file));
      const realpath = vi.fn((file: string) => realpathSync(file));
      expect(codesOf(check(runnerEnv(), { uid, lstat, realpath }))).toContain(
        "UID_UNAVAILABLE",
      );
      if (uid === undefined) {
        expect(lstat).not.toHaveBeenCalled();
        expect(realpath).not.toHaveBeenCalled();
      }
    },
  );
});

describe("checkCiRunner: no database settings before the CI step", () => {
  test.each(DATABASE_VARIABLES)("%s set fails, even to empty", (name) => {
    expect(codesOf(check(runnerEnv({ [name]: SECRET })))).toEqual([
      "DATABASE_VARIABLE_SET",
    ]);
    expect(codesOf(check(runnerEnv({ [name]: "" })))).toEqual([
      "DATABASE_VARIABLE_SET",
    ]);
  });

  test("covers the three database URLs", () => {
    expect(DATABASE_VARIABLES).toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "DATABASE_MIGRATION_URL",
        "TEST_DATABASE_URL",
      ]),
    );
  });

  test.each([
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGPASSFILE",
    "PGSERVICE",
    "PGSSLMODE",
    "PGOPTIONS",
    "PGBINARY",
    "PG",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_EXTRA_CA_CERTS",
  ])("%s set fails, even to empty", (name) => {
    expect(codesOf(check(runnerEnv({ [name]: SECRET })))).toEqual([
      "UNEXPECTED_VARIABLE_SET",
    ]);
    expect(codesOf(check(runnerEnv({ [name]: "" })))).toEqual([
      "UNEXPECTED_VARIABLE_SET",
    ]);
  });

  test.each(["production", "PRODUCTION", " Production ", "production\n"])(
    "NODE_ENV %j fails",
    (value) => {
      expect(codesOf(check(runnerEnv({ NODE_ENV: value })))).toEqual([
        "NODE_ENV_PRODUCTION",
      ]);
    },
  );
});

const UNSAFE_PATHS = [
  ["relative", "runner/_temp"],
  ["dot-relative", "./_temp"],
  ["home-relative", "~/_temp"],
  ["the root", "/"],
  ["a doubled slash", "/home//runner"],
  ["a dot segment", "/home/./runner"],
  ["a traversal", "/home/runner/../runner"],
  ["a trailing traversal", "/home/runner/.."],
  ["a trailing slash", "/home/runner/"],
  ["a space", "/home/run ner"],
  ["a newline", "/home/runner\n/x"],
  ["a NUL byte", "/home/runner\0/x"],
  ["a backslash", "/home\\runner"],
  ["a quote", '/home/"runner"'],
  ["a shell variable", "/home/$USER"],
  ["a non-ASCII character", "/home/rünner"],
  ["a length over 4096", `/${"a".repeat(4096)}`],
] as const;

describe("checkCiRunner: RUNNER_TEMP", () => {
  test.each(["", undefined])("%j fails as missing", (value) => {
    expect(codesOf(check(runnerEnv({ RUNNER_TEMP: value })))).toEqual([
      "RUNNER_TEMP_MISSING",
    ]);
  });

  test.each(UNSAFE_PATHS)(
    "a path with %s fails without touching the file system",
    (_name, value) => {
      const lstat = vi.fn((file: string) => lstatSync(file));
      const realpath = vi.fn((file: string) => realpathSync(file));
      expect(
        codesOf(check(runnerEnv({ RUNNER_TEMP: value }), { lstat, realpath })),
      ).toEqual(["RUNNER_TEMP_INVALID"]);
      expect(lstat).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
    },
  );

  test("a directory that doesn't exist fails as unreadable", () => {
    rmSync(base, { recursive: true, force: true });
    expect(codesOf(check(runnerEnv()))).toEqual(["RUNNER_TEMP_UNREADABLE"]);
  });

  test("a regular file fails", () => {
    rmSync(runnerTemp, { recursive: true });
    writeFileSync(runnerTemp, "");
    expect(codesOf(check(runnerEnv()))).toContain("RUNNER_TEMP_UNSAFE");
  });

  test("a symbolic link to a real directory fails", () => {
    const link = `${base}/temp-link`;
    symlinkSync(runnerTemp, link);
    expect(
      codesOf(
        check(
          runnerEnv({
            RUNNER_TEMP: link,
            GITHUB_ENV: `${link}/_runner_file_commands/${ENV_FILE}`,
          }),
        ),
      ),
    ).toEqual(["RUNNER_TEMP_UNSAFE"]);
  });

  test("a path through a symbolic-link parent fails", () => {
    const linkedParent = `${base}/parent-link`;
    symlinkSync(base, linkedParent);
    expect(
      codesOf(
        check(
          runnerEnv({
            RUNNER_TEMP: `${linkedParent}/_temp`,
            GITHUB_ENV: `${linkedParent}/_temp/_runner_file_commands/${ENV_FILE}`,
          }),
        ),
      ),
    ).toEqual(["RUNNER_TEMP_UNSAFE"]);
  });

  test("a broken symbolic link fails", () => {
    const link = `${base}/dangling`;
    symlinkSync(`${base}/nowhere`, link);
    // GITHUB_ENV (under the real _temp) is also outside the link's path.
    expect(codesOf(check(runnerEnv({ RUNNER_TEMP: link })))).toEqual([
      "RUNNER_TEMP_UNREADABLE",
      "GITHUB_ENV_OUTSIDE_RUNNER_TEMP",
    ]);
  });

  test.each([0o777, 0o757, 0o1777])(
    "a directory other users can write (mode %o) fails",
    (mode) => {
      chmodSync(runnerTemp, mode);
      expect(codesOf(check(runnerEnv()))).toEqual(["RUNNER_TEMP_UNSAFE"]);
    },
  );

  test("a directory owned by another user fails", () => {
    expect(codesOf(check(runnerEnv(), { uid: UID + 1 }))).toEqual([
      "RUNNER_TEMP_UNSAFE",
    ]);
  });

  test("an inspection error fails closed with a code only", () => {
    const lstat = () => {
      throw Object.assign(new Error(`EACCES: ${SECRET} ${runnerTemp}`), {
        code: "EACCES",
      });
    };
    const result = check(runnerEnv(), { lstat });
    expect(codesOf(result)).toEqual(["RUNNER_TEMP_UNREADABLE"]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("a realpath error fails closed", () => {
    const realpath = () => {
      throw new Error("ELOOP");
    };
    expect(codesOf(check(runnerEnv(), { realpath }))).toEqual([
      "RUNNER_TEMP_UNREADABLE",
    ]);
  });
});

describe("checkCiRunner: GITHUB_ENV", () => {
  test.each(["", undefined])("%j fails as missing", (value) => {
    expect(codesOf(check(runnerEnv({ GITHUB_ENV: value })))).toEqual([
      "GITHUB_ENV_MISSING",
    ]);
  });

  test.each(UNSAFE_PATHS)("a path with %s fails", (_name, value) => {
    expect(codesOf(check(runnerEnv({ GITHUB_ENV: value })))).toEqual([
      "GITHUB_ENV_INVALID",
    ]);
  });

  test("a traversal that normalizes back inside RUNNER_TEMP fails", () => {
    expect(
      codesOf(
        check(
          runnerEnv({
            GITHUB_ENV: `${runnerTemp}/../_temp/_runner_file_commands/${ENV_FILE}`,
          }),
        ),
      ),
    ).toEqual(["GITHUB_ENV_INVALID"]);
  });

  test("a sibling directory sharing RUNNER_TEMP's prefix fails", () => {
    const sibling = `${runnerTemp}-evil`;
    mkdirSync(sibling, { mode: 0o755 });
    writeFileSync(`${sibling}/${ENV_FILE}`, "");
    expect(
      codesOf(check(runnerEnv({ GITHUB_ENV: `${sibling}/${ENV_FILE}` }))),
    ).toEqual(["GITHUB_ENV_OUTSIDE_RUNNER_TEMP"]);
  });

  test.each([
    ["RUNNER_TEMP itself", () => runnerTemp],
    ["RUNNER_TEMP's parent", () => base],
    ["an unrelated path", () => "/etc/environment"],
  ])("%s fails as outside RUNNER_TEMP", (_name, value) => {
    expect(codesOf(check(runnerEnv({ GITHUB_ENV: value() })))).toEqual([
      "GITHUB_ENV_OUTSIDE_RUNNER_TEMP",
    ]);
  });

  test("isn't inspected when RUNNER_TEMP is invalid", () => {
    const lstat = vi.fn((file: string) => lstatSync(file));
    const result = check(runnerEnv({ RUNNER_TEMP: "relative/_temp" }), {
      lstat,
    });
    expect(codesOf(result)).toEqual(["RUNNER_TEMP_INVALID"]);
    expect(lstat).not.toHaveBeenCalled();
  });

  test("isn't inspected when RUNNER_TEMP is unsafe", () => {
    chmodSync(runnerTemp, 0o777);
    const lstat = vi.fn((file: string) => lstatSync(file));
    expect(codesOf(check(runnerEnv(), { lstat }))).toEqual([
      "RUNNER_TEMP_UNSAFE",
    ]);
    expect(lstat).toHaveBeenCalledTimes(1);
  });

  test("a file that doesn't exist fails as unreadable", () => {
    rmSync(githubEnv);
    expect(codesOf(check(runnerEnv()))).toEqual(["GITHUB_ENV_UNREADABLE"]);
  });

  test("a directory fails", () => {
    rmSync(githubEnv);
    mkdirSync(githubEnv, { mode: 0o755 });
    expect(codesOf(check(runnerEnv()))).toEqual(["GITHUB_ENV_UNSAFE"]);
  });

  test("a symbolic link to a file inside RUNNER_TEMP fails", () => {
    const target = `${fileCommands}/real_env`;
    writeFileSync(target, "", { mode: 0o644 });
    rmSync(githubEnv);
    symlinkSync(target, githubEnv);
    expect(codesOf(check(runnerEnv()))).toEqual(["GITHUB_ENV_UNSAFE"]);
  });

  test("a symbolic link to a file outside RUNNER_TEMP fails", () => {
    const outside = `${base}/outside_env`;
    writeFileSync(outside, "", { mode: 0o644 });
    rmSync(githubEnv);
    symlinkSync(outside, githubEnv);
    expect(codesOf(check(runnerEnv()))).toEqual(["GITHUB_ENV_UNSAFE"]);
  });

  test("a broken symbolic link fails", () => {
    rmSync(githubEnv);
    symlinkSync(`${base}/nowhere`, githubEnv);
    // lstat sees the link; resolving it fails.
    expect(codesOf(check(runnerEnv()))).toEqual(["GITHUB_ENV_UNREADABLE"]);
  });

  test("a symbolic-link directory between RUNNER_TEMP and the file fails", () => {
    const realCommands = `${runnerTemp}/real_commands`;
    mkdirSync(realCommands, { mode: 0o755 });
    writeFileSync(`${realCommands}/${ENV_FILE}`, "", { mode: 0o644 });
    rmSync(fileCommands, { recursive: true });
    symlinkSync(realCommands, fileCommands);
    expect(codesOf(check(runnerEnv()))).toEqual(["GITHUB_ENV_UNSAFE"]);
  });

  test("a directory between them that other users can write fails", () => {
    chmodSync(fileCommands, 0o777);
    expect(codesOf(check(runnerEnv()))).toEqual(["GITHUB_ENV_UNSAFE"]);
  });

  test("a hard-linked file fails", () => {
    linkSync(githubEnv, `${base}/second_link`);
    expect(codesOf(check(runnerEnv()))).toEqual(["GITHUB_ENV_UNSAFE"]);
  });

  test.each([0o666, 0o646])(
    "a file other users can write (mode %o) fails",
    (mode) => {
      chmodSync(githubEnv, mode);
      expect(codesOf(check(runnerEnv()))).toEqual(["GITHUB_ENV_UNSAFE"]);
    },
  );

  test("a file or directory owned by another user fails", () => {
    const realLstat = (file: string) => lstatSync(file);
    const otherOwner = (owned: string) => (file: string) => {
      const stats = realLstat(file);
      return file === owned
        ? {
            isDirectory: () => stats.isDirectory(),
            isFile: () => stats.isFile(),
            isSymbolicLink: () => stats.isSymbolicLink(),
            uid: UID + 1,
            mode: stats.mode,
            nlink: stats.nlink,
          }
        : stats;
    };
    expect(
      codesOf(check(runnerEnv(), { lstat: otherOwner(githubEnv) })),
    ).toEqual(["GITHUB_ENV_UNSAFE"]);
    expect(
      codesOf(check(runnerEnv(), { lstat: otherOwner(fileCommands) })),
    ).toEqual(["GITHUB_ENV_UNSAFE"]);
  });

  test("an inspection error fails closed with a code only", () => {
    const lstat = (file: string) => {
      if (file === githubEnv) {
        throw Object.assign(new Error(`EACCES ${SECRET}`), { code: "EACCES" });
      }
      return lstatSync(file);
    };
    const result = check(runnerEnv(), { lstat });
    expect(codesOf(result)).toEqual(["GITHUB_ENV_UNREADABLE"]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("checkCiRunner: reporting", () => {
  test("reports every failure, each code once, in a fixed order", () => {
    const env = {
      GITHUB_ACTIONS: "false",
      RUNNER_ENVIRONMENT: "self-hosted",
      RUNNER_OS: "macOS",
      DATABASE_URL: SECRET,
      TEST_DATABASE_URL: SECRET,
      PGHOST: SECRET,
      PGPASSWORD: SECRET,
      NODE_ENV: "production",
      RUNNER_TEMP: "relative",
      GITHUB_ENV: "/a/../b",
    };
    expect(codesOf(check(env, { platform: "darwin", uid: undefined }))).toEqual(
      [
        "NOT_GITHUB_ACTIONS",
        "NOT_CI",
        "NOT_GITHUB_HOSTED",
        "NOT_LINUX_RUNNER",
        "NOT_LINUX_PLATFORM",
        "UID_UNAVAILABLE",
        "DATABASE_VARIABLE_SET",
        "UNEXPECTED_VARIABLE_SET",
        "NODE_ENV_PRODUCTION",
        "RUNNER_TEMP_INVALID",
        "GITHUB_ENV_INVALID",
      ],
    );
  });

  test("never includes a variable's value or a path in the result or its description", () => {
    const env = Object.fromEntries(
      [
        "GITHUB_ACTIONS",
        "CI",
        "RUNNER_ENVIRONMENT",
        "RUNNER_OS",
        "NODE_ENV",
        "PGPASSWORD",
        "NODE_EXTRA_CA_CERTS",
        ...DATABASE_VARIABLES,
      ].map((name) => [name, `${SECRET}-${name}`]),
    );
    const cases: CiRunnerResult[] = [
      check({ ...env, RUNNER_TEMP: `/${SECRET}`, GITHUB_ENV: SECRET }),
      check({ ...runnerEnv(), PGPASSWORD: SECRET }),
      check(runnerEnv({ RUNNER_TEMP: `${base}/missing` })),
    ];
    for (const result of cases) {
      expect(result.ok).toBe(false);
      const output = `${JSON.stringify(result)}\n${describeCiRunnerCodes(codesOf(result))}`;
      expect(output).not.toContain("FakeSecret");
      expect(output).not.toContain(base);
      expect(output).not.toMatch(/postgres(ql)?:\/\//);
    }
  });

  test("describes every code with a fixed line", () => {
    const codes = Object.keys(CI_RUNNER_CODES) as CiRunnerCode[];
    const lines = describeCiRunnerCodes(codes).split("\n");
    expect(lines).toHaveLength(codes.length);
    lines.forEach((line, index) => {
      expect(line).toBe(`${codes[index]}: ${CI_RUNNER_CODES[codes[index]]}`);
    });
  });

  test("prints nothing", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    try {
      check(runnerEnv());
      check(runnerEnv({ PGPASSWORD: SECRET, RUNNER_TEMP: "/a/../b" }));
      for (const spy of [...spies, stdout, stderr]) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of [...spies, stdout, stderr]) spy.mockRestore();
    }
  });
});
