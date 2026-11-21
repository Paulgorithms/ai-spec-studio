// Tests of scripts/db/ci-expect-refusals.sh (Phase 4B-1). Nothing here
// reaches PostgreSQL: the classifiers run as extracted Bash functions on
// synthetic outputs, the provision capture runs against a stub script in a
// temporary directory, and whole-script runs use environments that stop at
// the first gates, before sudo, psql, or the real provisioning script.
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// These tests start real processes (bash, tsx, stubs) many times over. In
// the full suite, with every file running in parallel, they take several
// times longer than alone, close to Vitest's 5-second default, so this file
// gets 30 seconds per test. vi.setConfig applies to this file only: Vitest
// resets it after each file.
vi.setConfig({ testTimeout: 30_000 });

const SCRIPT_PATH = "scripts/db/ci-expect-refusals.sh";
const PROVISION_PATH = "scripts/db/ci-provision-postgres.sh";
const SQL_PATH = "scripts/db/ci-setup.sql";
const script = readFileSync(SCRIPT_PATH, "utf8");
const provisionScript = readFileSync(PROVISION_PATH, "utf8");
const setupSql = readFileSync(SQL_PATH, "utf8");

// Every bash -c run here gets its standard input from /dev/null. Node's
// default stdin pipe is a socket on Linux, and Debian's Bash, started with
// -c on a socket and with no SHLVL, takes itself for a remote shell and
// reads /etc/bash.bashrc and ~/.bashrc first. The workflow runs the scripts
// as bash -p <script>, which never does that.
const BASH_C_OPTIONS: SpawnSyncOptionsWithStringEncoding = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" },
};

// The one line that names sudo without running it: the constant that
// sql_line_kind compares an output line's prefix with. The checks that sudo
// is run only in the approved places, and only with -n, allow exactly this
// line.
const SUDO_KIND_LINE = 'readonly SQL_SUDO_PREFIX="sudo:"';

const SECRET = "FakeSecret:p@ss/word";
const FAKE_URL = `postgresql://ai_spec_studio_test:${"0123456789abcdef".repeat(4)}@127.0.0.1:5432/ai_spec_studio_test`;

// ---------------------------------------------------------------------------
// Script structure helpers

function codeLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line, index) => index === 0 || !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line !== "");
}

function functionText(text: string, name: string): string {
  const match = new RegExp(
    `^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`,
    "m",
  ).exec(text);
  if (!match) throw new Error(`no function ${name}`);
  return match[0];
}

function functionBody(text: string, name: string): string[] {
  return functionText(text, name)
    .split("\n")
    .slice(1, -2)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function readonlyLines(text: string): string {
  return codeLines(text)
    .filter((line) => line.startsWith("readonly "))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Running the classifiers on synthetic outputs

type Mode = "provision" | "sql";

function classify(
  mode: Mode,
  status: number,
  output: string,
  text: string = script,
) {
  const label =
    mode === "provision"
      ? "CI_REFUSAL_PROVISION_EXPECTED"
      : "CI_REFUSAL_SQL_EXPECTED";
  const program = [
    "set -euo pipefail",
    readonlyLines(text),
    'VERDICT=""',
    'OBSERVED=""',
    'STATUS=""',
    'SQL_UNRECOGNIZED=""',
    'SQL_ERROR_LINE=""',
    'SQL_MARKER=""',
    'LINE_KIND=""',
    functionText(text, "fail"),
    functionText(text, "pass"),
    functionText(text, "sql_line_kind"),
    functionText(text, `classify_${mode}`),
    functionText(text, "report_verdict"),
    'STATUS="$2"',
    `classify_${mode} "$2" "$3"`,
    `report_verdict ${label}`,
  ].join("\n");
  const result = spawnSync(
    "bash",
    ["-p", "-c", program, "classify", mode, String(status), output],
    BASH_C_OPTIONS,
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

const verdictOf = (stdout: string) =>
  /^(PASS|FAIL) {2}(CI_REFUSAL_[A-Z_]+)/.exec(stdout)?.[2];

// The post-provisioning refusal, as ci-provision-postgres.sh prints it.
const PROVISION_PREFIX = [
  "PASS  CI_PROVISION_SHELL",
  "PASS  CI_PROVISION_RUNNER",
  "PASS  CI_PROVISION_ENVIRONMENT",
  "PASS  CI_PROVISION_REPOSITORY",
];
const PROVISION_EXPECTED = [
  ...PROVISION_PREFIX,
  "FAIL  CI_PROVISION_CREDENTIAL_CONTENTS",
].join("\n");

const FRESHNESS_CODES = [
  "CI_SETUP_ROLES_NOT_FRESH",
  "CI_SETUP_PROJECT_OBJECTS_EXIST",
  "CI_SETUP_DATABASES_NOT_FRESH",
  "CI_SETUP_SETTINGS_NOT_FRESH",
];
const sqlError = (codes: string[]) =>
  `psql:<stdin>:172: ERROR:  CI_SETUP_PREFLIGHT_FAILED: ${codes.join(", ")}`;
const CONTEXT =
  "CONTEXT:  PL/pgSQL function inline_code_block line 117 at RAISE";
const SQL_EXPECTED = `${sqlError(FRESHNESS_CODES)}\n${CONTEXT}`;

type Case = [string, number, string, string | "PASS", string?];

const PROVISION_CASES: Case[] = [
  ["the expected refusal", 1, PROVISION_EXPECTED, "PASS"],
  [
    "the expected refusal without the informational PASS lines",
    1,
    "FAIL  CI_PROVISION_CREDENTIAL_CONTENTS",
    "PASS",
  ],
  [
    "the expected refusal after only some PASS lines",
    1,
    "PASS  CI_PROVISION_SHELL\nFAIL  CI_PROVISION_CREDENTIAL_CONTENTS",
    "PASS",
  ],
  [
    "an unexpected success",
    0,
    `${PROVISION_PREFIX.join("\n")}\nPASS  CI_PROVISION_COMPLETE (postgres (PostgreSQL) 18.6)`,
    "CI_REFUSAL_PROVISION_SUCCEEDED",
  ],
  ["a silent success", 0, "", "CI_REFUSAL_PROVISION_SUCCEEDED"],
  [
    "the expected code with exit status 0",
    0,
    PROVISION_EXPECTED,
    "CI_REFUSAL_PROVISION_SUCCEEDED",
  ],
  [
    "the expected code with exit status 2",
    2,
    PROVISION_EXPECTED,
    "CI_REFUSAL_WRONG_STATUS",
  ],
  ["a killed run (137)", 137, PROVISION_EXPECTED, "CI_REFUSAL_WRONG_STATUS"],
  [
    "the cluster gate instead",
    1,
    `${PROVISION_PREFIX.join("\n")}\nFAIL  CI_PROVISION_CLUSTER_STATE`,
    "CI_REFUSAL_WRONG_CODE",
    "CI_PROVISION_CLUSTER_STATE",
  ],
  [
    "the runner gate instead",
    1,
    "PASS  CI_PROVISION_SHELL\nFAIL  CI_PROVISION_NOT_GITHUB_HOSTED",
    "CI_REFUSAL_WRONG_CODE",
    "CI_PROVISION_NOT_GITHUB_HOSTED",
  ],
  [
    "usage refused",
    2,
    "FAIL  CI_PROVISION_USAGE",
    "CI_REFUSAL_WRONG_STATUS",
    "CI_PROVISION_USAGE",
  ],
  [
    "no refusal code",
    1,
    PROVISION_PREFIX.join("\n"),
    "CI_REFUSAL_MISSING_CODE",
  ],
  [
    "two refusal codes",
    1,
    `${PROVISION_EXPECTED}\nFAIL  CI_PROVISION_CLUSTER_STATE`,
    "CI_REFUSAL_WRONG_CODE",
    "CI_PROVISION_CREDENTIAL_CONTENTS CI_PROVISION_CLUSTER_STATE",
  ],
  [
    "an unexpected error",
    1,
    `${PROVISION_PREFIX.join("\n")}\nFAIL  CI_PROVISION_UNEXPECTED_ERROR (line 171)`,
    "CI_REFUSAL_WRONG_CODE",
    "CI_PROVISION_UNEXPECTED_ERROR",
  ],
  [
    "progress past the credential gate",
    1,
    `${PROVISION_PREFIX.join("\n")}\nPASS  CI_PROVISION_CREDENTIALS\nFAIL  CI_PROVISION_CLUSTER_STATE`,
    "CI_REFUSAL_PROVISION_PROGRESSED",
  ],
  [
    "the expected code after progress",
    1,
    `PASS  CI_PROVISION_CLUSTER\n${PROVISION_EXPECTED}`,
    "CI_REFUSAL_PROVISION_PROGRESSED",
  ],
  [
    "a stray error line",
    1,
    `sudo: a password is required\n${PROVISION_EXPECTED}`,
    "CI_REFUSAL_UNRECOGNIZED_OUTPUT",
  ],
  [
    "a leaked URL",
    1,
    `${PROVISION_EXPECTED}\n${FAKE_URL}`,
    "CI_REFUSAL_UNRECOGNIZED_OUTPUT",
  ],
  [
    "a code with trailing text",
    1,
    `FAIL  CI_PROVISION_CREDENTIAL_CONTENTS ${SECRET}`,
    "CI_REFUSAL_UNRECOGNIZED_OUTPUT",
  ],
  [
    "a code from another script",
    1,
    "FAIL  CI_SETUP_ROLES_NOT_FRESH",
    "CI_REFUSAL_UNRECOGNIZED_OUTPUT",
  ],
  [
    "a lowercase code",
    1,
    "FAIL  ci_provision_credential_contents",
    "CI_REFUSAL_UNRECOGNIZED_OUTPUT",
  ],
];

const SQL_CASES: Case[] = [
  ["the expected refusal", 3, SQL_EXPECTED, "PASS"],
  [
    "the expected refusal without CONTEXT",
    3,
    sqlError(FRESHNESS_CODES),
    "PASS",
  ],
  [
    "an unexpected success",
    0,
    "PASS  ci-setup.sql: ai_spec_studio_test provisioned and verified",
    "CI_REFUSAL_SQL_REPORTED_SUCCESS",
  ],
  [
    "a reported success with a failing status",
    3,
    `PASS  ci-setup.sql: ai_spec_studio_test provisioned and verified\n${SQL_EXPECTED}`,
    "CI_REFUSAL_SQL_REPORTED_SUCCESS",
  ],
  ["a silent success", 0, "", "CI_REFUSAL_SQL_SUCCEEDED"],
  [
    "the expected error with exit status 1",
    1,
    SQL_EXPECTED,
    "CI_REFUSAL_WRONG_STATUS",
    FRESHNESS_CODES.join(", "),
  ],
  [
    "the expected error with exit status 2",
    2,
    SQL_EXPECTED,
    "CI_REFUSAL_WRONG_STATUS",
    FRESHNESS_CODES.join(", "),
  ],
  ["a failing status and no error", 3, "", "CI_REFUSAL_MISSING_CODE"],
  [
    "a missing freshness code",
    3,
    sqlError(FRESHNESS_CODES.slice(0, 3)),
    "CI_REFUSAL_MISSING_CODE",
    FRESHNESS_CODES.slice(0, 3).join(", "),
  ],
  [
    "only one freshness code",
    3,
    sqlError(["CI_SETUP_PROJECT_OBJECTS_EXIST"]),
    "CI_REFUSAL_MISSING_CODE",
    "CI_SETUP_PROJECT_OBJECTS_EXIST",
  ],
  [
    "an extra code (another session)",
    3,
    sqlError([...FRESHNESS_CODES, "CI_SETUP_OTHER_SESSIONS"]),
    "CI_REFUSAL_UNEXPECTED_CODE",
  ],
  [
    "an extra code (pg_hba rules changed)",
    3,
    sqlError(["CI_SETUP_HBA_RULES", ...FRESHNESS_CODES]),
    "CI_REFUSAL_UNEXPECTED_CODE",
  ],
  [
    "an extra code (the admin has a password)",
    3,
    sqlError([...FRESHNESS_CODES, "CI_SETUP_ADMIN_HAS_PASSWORD"]),
    "CI_REFUSAL_UNEXPECTED_CODE",
  ],
  [
    "the codes in another order",
    3,
    sqlError([...FRESHNESS_CODES].reverse()),
    "CI_REFUSAL_UNEXPECTED_CODE",
  ],
  [
    "a different missing code replacing one",
    3,
    sqlError(["CI_SETUP_HBA_RULES", ...FRESHNESS_CODES.slice(1)]),
    "CI_REFUSAL_MISSING_CODE",
  ],
  [
    "the verifier check instead",
    3,
    "psql:<stdin>:57: ERROR:  CI_SETUP_VERIFIER_INVALID: the test role verifier is not a strict SCRAM-SHA-256 verifier",
    "CI_REFUSAL_WRONG_ERROR",
  ],
  [
    "the psql version check instead",
    3,
    "psql:<stdin>:47: ERROR:  CI_SETUP_PSQL_VERSION: psql must be version 18",
    "CI_REFUSAL_WRONG_ERROR",
  ],
  [
    "a syntax error",
    3,
    'psql:<stdin>:90: ERROR:  syntax error at or near "x"',
    "CI_REFUSAL_WRONG_ERROR",
  ],
  [
    "a bare SQLSTATE",
    3,
    "psql:<stdin>:90: ERROR:  42601",
    "CI_REFUSAL_WRONG_ERROR",
  ],
  [
    "a malformed code list",
    3,
    "psql:<stdin>:172: ERROR:  CI_SETUP_PREFLIGHT_FAILED: roles not fresh",
    "CI_REFUSAL_WRONG_ERROR",
  ],
  [
    "two errors",
    3,
    `${sqlError(FRESHNESS_CODES)}\n${sqlError(FRESHNESS_CODES)}`,
    "CI_REFUSAL_WRONG_ERROR",
  ],
  [
    "a query excerpt",
    3,
    `${SQL_EXPECTED}\nLINE 1: SELECT coalesce( 'SCRAM-SHA-256$4096:...'`,
    "CI_REFUSAL_UNRECOGNIZED_OUTPUT",
  ],
  [
    "a warning",
    3,
    `WARNING:  something\n${SQL_EXPECTED}`,
    "CI_REFUSAL_UNRECOGNIZED_OUTPUT",
  ],
  [
    "a sudo message",
    3,
    `sudo: unable to resolve host\n${SQL_EXPECTED}`,
    "CI_REFUSAL_UNRECOGNIZED_OUTPUT",
  ],
  [
    "a leaked secret",
    3,
    `${SQL_EXPECTED}\n${SECRET} ${FAKE_URL}`,
    "CI_REFUSAL_UNRECOGNIZED_OUTPUT",
  ],
  [
    "an error from another file",
    3,
    `psql:/tmp/x.sql:172: ERROR:  CI_SETUP_PREFLIGHT_FAILED: ${FRESHNESS_CODES.join(", ")}`,
    "CI_REFUSAL_UNRECOGNIZED_OUTPUT",
  ],
];

function expectCase(
  mode: Mode,
  [_name, status, output, expected, observed]: Case,
) {
  const result = classify(mode, status, output);
  if (expected === "PASS") {
    expect(result.stdout).toBe(
      `PASS  CI_REFUSAL_${mode.toUpperCase()}_EXPECTED\n`,
    );
    expect(result.status).toBe(0);
    return result;
  }
  expect(result.status).toBe(1);
  expect(result.stdout.split("\n")[0]).toBe(`FAIL  ${expected}`);
  expect(result.stdout).toContain(`      exit status: ${status}\n`);
  if (observed !== undefined) {
    expect(result.stdout).toContain(`      observed: ${observed}\n`);
  }
  return result;
}

// ---------------------------------------------------------------------------

describe("ci-expect-refusals.sh: the file", () => {
  test("parses with bash -n", () => {
    const result = spawnSync("bash", ["-n", SCRIPT_PATH], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("is plain ASCII with Unix line endings, a final newline, and no trailing spaces", () => {
    expect(script).toMatch(/^[\x20-\x7e\n]*$/);
    expect(script.endsWith("\n")).toBe(true);
    expect(script).not.toMatch(/[ \t]+$/m);
  });

  test("says it's for the disposable CI cluster only, and documents what provision mode proves", () => {
    const prose = script.replace(/\n#\s*/g, " ");
    expect(prose).toContain("GitHub-hosted Ubuntu 26.04 runner ONLY");
    expect(prose).toContain("This checks the credential-state gate only");
    expect(prose).toContain("does not prove, the cluster-state gate");
  });

  test("has the same shell prelude as ci-provision-postgres.sh, with its own codes", () => {
    const own = codeLines(script).slice(0, 18);
    const provisioning = codeLines(provisionScript)
      .slice(0, 18)
      .map((line) => line.replace(/CI_PROVISION_/g, "CI_REFUSAL_"));
    expect(own).toEqual(provisioning);
    expect(own[0]).toBe("#!/bin/bash -p");
    expect(own[2]).toBe('case "$-" in');
  });

  test("defines exactly the expected functions", () => {
    const names = [...script.matchAll(/^([a-z_]+)\(\) \{$/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual(
      [
        "check_arguments",
        "check_cluster_online",
        "check_credential_state",
        "check_environment",
        "check_provisioned",
        "check_repository_files",
        "check_runner",
        "classify_provision",
        "classify_sql",
        "fail",
        "main",
        "pass",
        "report_verdict",
        "run_provision_refusal",
        "run_sql_refusal",
        "sql_line_kind",
      ].sort(),
    );
  });

  test("holds no credentials", () => {
    // The one long base64 run is the all-"A" placeholder, checked exactly in
    // its own test; nothing else may look like key material.
    const withoutPlaceholder = script.replace(
      /^readonly PLACEHOLDER_VERIFIER='[^']+'$/m,
      "",
    );
    expect(withoutPlaceholder).not.toBe(script);
    expect(withoutPlaceholder).not.toMatch(/[0-9a-f]{32,}/i);
    expect(withoutPlaceholder).not.toMatch(/[A-Za-z0-9+/]{40,}/);
    expect(script).not.toMatch(/postgres(?:ql)?:\/\//);
    expect(script).not.toMatch(/PGPASSWORD|POSTGRES_PASSWORD/);
  });
});

describe("ci-expect-refusals.sh: the refusal contracts match Phase 3", () => {
  test("provision mode expects the code the post-provisioning credential state produces", () => {
    expect(script).toContain(
      'readonly EXPECTED_PROVISION_CODE="CI_PROVISION_CREDENTIAL_CONTENTS"',
    );
    // ci-provision-postgres.sh: check_credentials requires exactly two
    // entries, and the first run removed the verifier, so the first gate
    // that refuses is the entry-count check.
    const body = functionBody(provisionScript, "check_credentials");
    const firstContents = body.findIndex((l) =>
      l.includes("fail CI_PROVISION_CREDENTIAL_CONTENTS"),
    );
    expect(body[firstContents]).toBe(
      '[ "${#entries[@]}" -eq 2 ] || fail CI_PROVISION_CREDENTIAL_CONTENTS',
    );
    // The four stages before it are the only PASS lines allowed.
    expect(functionBody(provisionScript, "main").slice(0, 5)).toEqual([
      'check_shell "$@"',
      "check_runner",
      "check_environment",
      "check_repository_files",
      "check_credentials",
    ]);
    for (const stage of ["SHELL", "RUNNER", "ENVIRONMENT", "REPOSITORY"]) {
      expect(provisionScript).toContain(`pass CI_PROVISION_${stage}`);
      expect(functionText(script, "classify_provision")).toContain(
        `"PASS  CI_PROVISION_${stage}"`,
      );
    }
  });

  test("sql mode expects exactly the four freshness codes, in ci-setup.sql's order", () => {
    const preflight =
      /DO \$preflight\$[\s\S]*?\$preflight\$;/.exec(setupSql)?.[0] ?? "";
    const order = [
      ...preflight.matchAll(
        /failures := array_append\(failures, '(CI_SETUP_[A-Z_]+)'::text\);/g,
      ),
    ].map((m) => m[1]);
    const expected = order.filter((code) =>
      FRESHNESS_CODES.includes(code ?? ""),
    );
    expect(expected).toEqual(FRESHNESS_CODES);
    expect(script).toContain(
      `readonly EXPECTED_SQL_CODES="${FRESHNESS_CODES.join(", ")}"`,
    );
    expect(preflight).toContain(
      "RAISE EXCEPTION 'CI_SETUP_PREFLIGHT_FAILED: %', array_to_string(failures, ', ');",
    );
  });

  test("the placeholder verifier passes ci-setup.sql's format check and is not a credential", () => {
    const placeholder =
      /readonly PLACEHOLDER_VERIFIER='([^']+)'/.exec(script)?.[1] ?? "";
    const sqlPattern = /:'test_verifier' ~ '([^']+)'/.exec(setupSql)?.[1] ?? "";
    expect(new RegExp(sqlPattern).test(placeholder)).toBe(true);
    expect(placeholder).toBe(
      `SCRAM-SHA-256$4096:${"A".repeat(22)}==$${"A".repeat(43)}=:${"A".repeat(43)}=`,
    );
  });

  test("ci-setup.sql reports success with the line sql mode treats as success", () => {
    expect(setupSql).toContain(
      "\\echo 'PASS  ci-setup.sql: ai_spec_studio_test provisioned and verified'",
    );
    expect(functionText(script, "classify_sql")).toContain(
      '"PASS  ci-setup.sql"*) reported=1 ;;',
    );
  });
});

describe("classify_provision", () => {
  test.each(PROVISION_CASES)("%s", (...testCase) => {
    expectCase("provision", testCase);
  });

  test("never prints captured text", () => {
    for (const [, status, output] of PROVISION_CASES) {
      const { stdout } = classify(
        "provision",
        status,
        `${output}\n${SECRET}\n${FAKE_URL}`,
      );
      expect(stdout).not.toContain(SECRET);
      expect(stdout).not.toContain("postgresql://");
      expect(stdout).not.toContain("sudo:");
    }
  });
});

describe("classify_sql", () => {
  test.each(SQL_CASES)("%s", (...testCase) => {
    expectCase("sql", testCase);
  });

  test("never prints captured text or the placeholder", () => {
    for (const [, status, output] of SQL_CASES) {
      const { stdout } = classify("sql", status, `${output}\n${SECRET}`);
      expect(stdout).not.toContain(SECRET);
      expect(stdout).not.toContain("SCRAM-SHA-256");
      expect(stdout).not.toContain("syntax error");
      expect(stdout).not.toContain("psql:");
    }
  });

  test("reports only well-formed codes as observed", () => {
    const { stdout } = classify(
      "sql",
      3,
      "psql:<stdin>:172: ERROR:  CI_SETUP_PREFLIGHT_FAILED: roles; DROP TABLE x",
    );
    expect(stdout).toBe(
      [
        "FAIL  CI_REFUSAL_WRONG_ERROR",
        "      exit status: 3",
        "      unrecognized: none",
        "      error input line: 172",
        "      preflight marker: present",
        "",
      ].join("\n"),
    );
  });
});

describe("classify_sql: diagnostics without captured text", () => {
  const KINDS = [
    "ERROR_OTHER_PREFIX",
    "ERROR_NO_PREFIX",
    "PSQL_CLIENT_ERROR",
    "SERVER_WARNING",
    "SERVER_NOTICE",
    "DETAIL",
    "HINT",
    "LINE",
    "QUERY",
    "STATEMENT",
    "SUDO",
    "PSQL_OTHER",
    "OTHER",
  ];
  const KIND = `(?:${KINDS.join("|")})`;
  const ALLOWED_LINE = new RegExp(
    [
      "^FAIL {2}CI_REFUSAL_[A-Z_]+$",
      "^ {6}exit status: [0-9]+$",
      "^ {6}observed: CI_SETUP_[A-Z_]+(, CI_SETUP_[A-Z_]+)*$",
      `^ {6}unrecognized: (none|${KIND} x[0-9]{1,2}\\+?(, ${KIND} x[0-9]{1,2}\\+?)*)$`,
      "^ {6}error input line: [1-9][0-9]{0,8}$",
      "^ {6}preflight marker: (present|absent)$",
    ].join("|"),
  );
  const FAKE_PASSWORD = "hunter2-Pa55word";

  // Every printed line has one of the fixed forms: codes, labels, digits.
  function expectOnlyPermitted(stdout: string) {
    expect(stdout.endsWith("\n")).toBe(true);
    for (const line of stdout.slice(0, -1).split("\n")) {
      expect(line).toMatch(ALLOWED_LINE);
    }
    for (const leaked of [
      SECRET,
      FAKE_PASSWORD,
      "postgresql://",
      "SCRAM-SHA-256",
      "AAAAAAAA",
      "<stdin>",
      "/tmp/",
      "/var/",
      "SELECT",
      "ai_spec_studio",
      "postgres",
      "runner",
    ]) {
      expect(stdout).not.toContain(leaked);
    }
  }

  const field = (stdout: string, name: string) =>
    stdout
      .split("\n")
      .find((l) => l.startsWith(`      ${name}: `))
      ?.slice(`      ${name}: `.length);

  const KIND_CASES: Array<[string, string]> = [
    [
      "ERROR_OTHER_PREFIX",
      `psql:/tmp/ci-setup.sql:217: ERROR:  CI_SETUP_PREFLIGHT_FAILED: ${FRESHNESS_CODES.join(", ")}`,
    ],
    [
      "ERROR_OTHER_PREFIX",
      `psql:<stdin>:217: ERROR: CI_SETUP_PREFLIGHT_FAILED: ${FRESHNESS_CODES.join(", ")}`,
    ],
    ["ERROR_OTHER_PREFIX", `psql:<stdin>:3: FATAL:  role "${SECRET}" denied`],
    [
      "ERROR_OTHER_PREFIX",
      "psql: ERROR:  CI_SETUP_PREFLIGHT_FAILED: CI_SETUP_ROLES_NOT_FRESH",
    ],
    [
      "ERROR_NO_PREFIX",
      `ERROR:  CI_SETUP_PREFLIGHT_FAILED: ${FRESHNESS_CODES.join(", ")}`,
    ],
    ["ERROR_NO_PREFIX", `FATAL:  password authentication failed ${SECRET}`],
    [
      "PSQL_CLIENT_ERROR",
      'psql:<stdin>:55: error: unrecognized value "x" for "\\if expression": Boolean expected',
    ],
    [
      "PSQL_CLIENT_ERROR",
      `psql: error: connection to server at "127.0.0.1" failed: ${FAKE_URL}`,
    ],
    ["SERVER_WARNING", `WARNING:  ${FAKE_PASSWORD} is weak`],
    ["SERVER_WARNING", "psql:<stdin>:9: WARNING:  there is no transaction"],
    ["SERVER_NOTICE", `NOTICE:  role ${SECRET} exists`],
    ["SERVER_NOTICE", "INFO:  something"],
    ["SERVER_NOTICE", "LOG:  something"],
    ["SERVER_NOTICE", "DEBUG1:  something"],
    ["DETAIL", `DETAIL:  Key (rolname)=(${SECRET}) already exists.`],
    ["HINT", `HINT:  Use ${FAKE_URL}`],
    ["LINE", `LINE 1: ...ROLE x PASSWORD 'SCRAM-SHA-256$4096:AAAAAAAA...'`],
    ["QUERY", `QUERY:  SELECT '${FAKE_PASSWORD}'`],
    ["STATEMENT", `STATEMENT:  SELECT '${FAKE_PASSWORD}'`],
    [
      "SUDO",
      "sudo: unable to resolve host runner-1: Name or service not known",
    ],
    ["PSQL_OTHER", `psql:<stdin>:9: ${SECRET}`],
    ["PSQL_OTHER", "psql: warning: extra command-line argument ignored"],
    ["PSQL_OTHER", "psql:/var/x:y.sql:12: ERROR:  colon in the file name"],
    ["PSQL_OTHER", "psql:/tmp/x.sql:0217: ERROR:  a leading zero"],
    ["PSQL_OTHER", "psql:/tmp/x.sql:1234567890: ERROR:  ten digits"],
    ["PSQL_OTHER", "psql:<stdin>:12x: ERROR:  not digits"],
    ["OTHER", `${SECRET} ${FAKE_URL}`],
    ["OTHER", `error: ${FAKE_PASSWORD}`],
    ["OTHER", `\u0001\u001b[31m${FAKE_PASSWORD}\u001b[0m\t`],
    ["OTHER", " ERROR:  indented"],
  ];

  test.each(KIND_CASES)("%s: %s", (kind, line) => {
    const { stdout, status } = classify("sql", 3, line);
    expect(status).toBe(1);
    expect(verdictOf(stdout)).toBe("CI_REFUSAL_UNRECOGNIZED_OUTPUT");
    expect(field(stdout, "unrecognized")).toBe(`${kind} x1`);
    expectOnlyPermitted(stdout);
  });

  test("every label is produced by some case", () => {
    expect([...new Set(KIND_CASES.map(([kind]) => kind))].sort()).toEqual(
      [...KINDS].sort(),
    );
  });

  test("the labels in the script are exactly the approved ones, in order", () => {
    expect(readonlyLines(script)).toContain(
      `readonly SQL_KINDS="${KINDS.join(" ")}"`,
    );
  });

  test("several unrecognized lines: each label counted, in a fixed order", () => {
    const output = [
      `HINT:  ${SECRET}`,
      "WARNING:  one",
      SQL_EXPECTED,
      "WARNING:  two",
      `DETAIL:  ${FAKE_URL}`,
      FAKE_PASSWORD,
    ].join("\n");
    const { stdout } = classify("sql", 3, output);
    expect(stdout).toBe(
      [
        "FAIL  CI_REFUSAL_UNRECOGNIZED_OUTPUT",
        "      exit status: 3",
        `      observed: ${FRESHNESS_CODES.join(", ")}`,
        "      unrecognized: SERVER_WARNING x2, DETAIL x1, HINT x1, OTHER x1",
        "      error input line: 172",
        "      preflight marker: present",
        "",
      ].join("\n"),
    );
    expectOnlyPermitted(stdout);
  });

  test("counts are bounded at 99", () => {
    const output = Array.from(
      { length: 150 },
      (_, i) => `${FAKE_PASSWORD}${i}`,
    ).join("\n");
    const { stdout } = classify("sql", 3, output);
    expect(field(stdout, "unrecognized")).toBe("OTHER x99+");
    expectOnlyPermitted(stdout);
  });

  test("an extra server warning beside the expected refusal still fails", () => {
    const { stdout, status } = classify(
      "sql",
      3,
      `${SQL_EXPECTED}\npsql:<stdin>:173: WARNING:  ${SECRET}`,
    );
    expect(status).toBe(1);
    expect(verdictOf(stdout)).toBe("CI_REFUSAL_UNRECOGNIZED_OUTPUT");
    expect(field(stdout, "observed")).toBe(FRESHNESS_CODES.join(", "));
    expect(field(stdout, "unrecognized")).toBe("SERVER_WARNING x1");
    expect(field(stdout, "error input line")).toBe("172");
    expectOnlyPermitted(stdout);
  });

  test("a lowercase psql client error fails, with its input line", () => {
    const { stdout, status } = classify(
      "sql",
      3,
      'psql:<stdin>:57: error: unrecognized value ":ci_verifier_ok" for "\\if expression": Boolean expected',
    );
    expect(status).toBe(1);
    expect(stdout).toBe(
      [
        "FAIL  CI_REFUSAL_UNRECOGNIZED_OUTPUT",
        "      exit status: 3",
        "      unrecognized: PSQL_CLIENT_ERROR x1",
        "      error input line: 57",
        "      preflight marker: absent",
        "",
      ].join("\n"),
    );
  });

  test("an unexpected SQL error fails, with its input line and no marker", () => {
    const { stdout } = classify(
      "sql",
      3,
      `psql:<stdin>:90: ERROR:  syntax error at or near "${SECRET}"\nLINE 1: ${FAKE_URL}`,
    );
    expect(stdout).toBe(
      [
        "FAIL  CI_REFUSAL_UNRECOGNIZED_OUTPUT",
        "      exit status: 3",
        "      unrecognized: LINE x1",
        "      error input line: 90",
        "      preflight marker: absent",
        "",
      ].join("\n"),
    );
  });

  test("the expected error in another prefix form: marker present, line known, not accepted", () => {
    const { stdout, status } = classify(
      "sql",
      3,
      `psql:/tmp/ci-setup.sql:217: ERROR:  CI_SETUP_PREFLIGHT_FAILED: ${FRESHNESS_CODES.join(", ")}\n${CONTEXT}`,
    );
    expect(status).toBe(1);
    expect(stdout).toBe(
      [
        "FAIL  CI_REFUSAL_UNRECOGNIZED_OUTPUT",
        "      exit status: 3",
        "      unrecognized: ERROR_OTHER_PREFIX x1",
        "      error input line: 217",
        "      preflight marker: present",
        "",
      ].join("\n"),
    );
  });

  test("the input line is the first error's, and only from a strict psql prefix", () => {
    const first = (output: string) =>
      field(classify("sql", 3, output).stdout, "error input line");
    expect(
      first(
        "psql:<stdin>:12: WARNING:  w\npsql:<stdin>:55: error: e\npsql:<stdin>:90: ERROR:  x",
      ),
    ).toBe("55");
    expect(first("psql:<stdin>:12: WARNING:  only a warning")).toBeUndefined();
    expect(first("ERROR:  failed at line 42")).toBeUndefined();
    expect(first("psql:<stdin>:0217: ERROR:  x")).toBeUndefined();
    expect(first("psql:<stdin>:1234567890: ERROR:  x")).toBeUndefined();
    expect(first("psql:<stdin>:-5: ERROR:  x")).toBeUndefined();
    expect(first("psql:<stdin>:5 : ERROR:  x")).toBeUndefined();
    expect(first("xpsql:<stdin>:5: ERROR:  x")).toBeUndefined();
    expect(first("psql:<stdin>:123456789: ERROR:  x")).toBe("123456789");
  });

  test("an accepted error line with a malformed line number is still classified, but no line is reported", () => {
    const { stdout } = classify(
      "sql",
      3,
      `psql:<stdin>:0172: ERROR:  CI_SETUP_PREFLIGHT_FAILED: ${FRESHNESS_CODES.join(", ")}`,
    );
    expect(stdout).toBe("PASS  CI_REFUSAL_SQL_EXPECTED\n");
    const wrong = classify("sql", 3, "psql:<stdin>:0090: ERROR:  x").stdout;
    expect(verdictOf(wrong)).toBe("CI_REFUSAL_WRONG_ERROR");
    expect(field(wrong, "error input line")).toBeUndefined();
  });

  test("unknown output with no psql line: labels and the marker still say what it was", () => {
    const { stdout } = classify("sql", 3, `${SECRET}\n${FAKE_URL}`);
    expect(stdout).toBe(
      [
        "FAIL  CI_REFUSAL_UNRECOGNIZED_OUTPUT",
        "      exit status: 3",
        "      unrecognized: OTHER x2",
        "      preflight marker: absent",
        "",
      ].join("\n"),
    );
  });

  test("the marker counts wherever it appears, but never makes an output acceptable", () => {
    const { stdout } = classify(
      "sql",
      3,
      `${SECRET} CI_SETUP_PREFLIGHT_FAILED: ${FRESHNESS_CODES.join(", ")}`,
    );
    expect(verdictOf(stdout)).toBe("CI_REFUSAL_UNRECOGNIZED_OUTPUT");
    expect(field(stdout, "preflight marker")).toBe("present");
    expect(field(stdout, "observed")).toBeUndefined();
    expectOnlyPermitted(stdout);
  });

  test("a failing status with no output reports no line and an absent marker", () => {
    const { stdout } = classify("sql", 3, "");
    expect(stdout).toBe(
      [
        "FAIL  CI_REFUSAL_MISSING_CODE",
        "      exit status: 3",
        "      unrecognized: none",
        "      preflight marker: absent",
        "",
      ].join("\n"),
    );
  });

  test("a carriage return in the expected error line fails closed", () => {
    const { stdout } = classify(
      "sql",
      3,
      `${sqlError(FRESHNESS_CODES)}\r\n${CONTEXT}`,
    );
    expect(verdictOf(stdout)).toBe("CI_REFUSAL_WRONG_ERROR");
    expect(field(stdout, "observed")).toBeUndefined();
    expectOnlyPermitted(stdout);
  });

  test("every existing SQL case still prints only permitted lines", () => {
    for (const [, status, output] of SQL_CASES) {
      const { stdout } = classify(
        "sql",
        status,
        `${output}\n${SECRET} ${FAKE_PASSWORD} ${FAKE_URL}`,
      );
      expectOnlyPermitted(stdout);
    }
  });

  describe("oversized output is not classified", () => {
    const BYTE_LIMIT = 16384;
    const LINE_LIMIT = 256;
    const padded = (bytes: number) => {
      const head = `${SQL_EXPECTED}\nCONTEXT:  `;
      return `${head}${"x".repeat(bytes - head.length)}`;
    };

    test("at the byte limit, the expected refusal still passes", () => {
      const output = padded(BYTE_LIMIT);
      expect(output.length).toBe(BYTE_LIMIT);
      expect(classify("sql", 3, output).stdout).toBe(
        "PASS  CI_REFUSAL_SQL_EXPECTED\n",
      );
    });

    test("one byte over, even the expected refusal fails", () => {
      const { stdout, status } = classify("sql", 3, padded(BYTE_LIMIT + 1));
      expect(status).toBe(1);
      expect(stdout).toBe(
        "FAIL  CI_REFUSAL_OUTPUT_TOO_LARGE\n      exit status: 3\n",
      );
    });

    test("at the line limit, the expected refusal still passes", () => {
      // classify_sql counts the lines of the output plus a final newline.
      const output = [SQL_EXPECTED, ...Array(LINE_LIMIT - 2).fill("")].join(
        "\n",
      );
      expect(`${output}\n`.split("\n").length - 1).toBe(LINE_LIMIT);
      expect(classify("sql", 3, output).stdout).toBe(
        "PASS  CI_REFUSAL_SQL_EXPECTED\n",
      );
    });

    test("one line over, even the expected refusal fails", () => {
      const output = [SQL_EXPECTED, ...Array(LINE_LIMIT - 1).fill("")].join(
        "\n",
      );
      expect(classify("sql", 3, output).stdout).toBe(
        "FAIL  CI_REFUSAL_OUTPUT_TOO_LARGE\n      exit status: 3\n",
      );
    });

    test("a large output full of secrets prints none of them", () => {
      const output = `${SQL_EXPECTED}\n${`${SECRET} ${FAKE_URL}\n`.repeat(400)}`;
      expect(output.length).toBeGreaterThan(BYTE_LIMIT);
      const { stdout } = classify("sql", 3, output);
      expect(stdout).toBe(
        "FAIL  CI_REFUSAL_OUTPUT_TOO_LARGE\n      exit status: 3\n",
      );
    });
  });

  test("provision mode prints none of the SQL diagnostics", () => {
    for (const [, status, output] of PROVISION_CASES) {
      const { stdout } = classify("provision", status, output);
      expect(stdout).not.toMatch(
        /unrecognized:|error input line:|preflight marker:/,
      );
    }
  });
});

describe("the classifiers use Bash builtins only", () => {
  test.each([
    "classify_provision",
    "classify_sql",
    "sql_line_kind",
    "report_verdict",
  ])("%s runs no external command", (name) => {
    const body = functionText(script, name);
    expect(body).not.toMatch(
      /\b(sudo|psql|cat|grep|sed|awk|dd|stat|tr|cut|head|tail|wc|sort|printf\s+-v|echo|env|bash)\b(?!\s*\))/,
    );
    expect(body.match(/\bprintf\b/g)?.length ?? 0).toBe(
      body.match(/\bbuiltin printf\b/g)?.length ?? 0,
    );
  });
});

describe("run_provision_refusal against a stub (never the real script)", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "ci-expect-refusals-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The script's own prelude (strict mode, errtrace, the ERR trap) and
  // run_provision_refusal, with PROVISION_SCRIPT pointing at a stub.
  function runAgainstStub(stubBody: string, text: string = script) {
    const stub = `${dir}/stub.sh`;
    writeFileSync(stub, `#!/bin/bash\n${stubBody}\n`);
    chmodSync(stub, 0o700);
    const program = [
      "set -euo pipefail",
      "set -o errtrace",
      `trap 'builtin printf "FAIL  CI_REFUSAL_UNEXPECTED_ERROR (line %s)\\n" "$LINENO"' ERR`,
      readonlyLines(text),
      'VERDICT=""',
      'OBSERVED=""',
      'STATUS=""',
      'SQL_UNRECOGNIZED=""',
      'SQL_ERROR_LINE=""',
      'SQL_MARKER=""',
      `PROVISION_SCRIPT='${stub}'`,
      functionText(text, "fail"),
      functionText(text, "pass"),
      functionText(text, "classify_provision"),
      functionText(text, "report_verdict"),
      functionText(text, "run_provision_refusal"),
      "run_provision_refusal",
    ].join("\n");
    return spawnSync("bash", ["-p", "-c", program], BASH_C_OPTIONS);
  }

  const emit = (lines: string[], status: number) =>
    `${lines.map((l) => `builtin printf '%s\\n' '${l}'`).join("\n")}\nexit ${status}`;

  test("the expected refusal passes (the ERR trap isn't captured into the output)", () => {
    const result = runAgainstStub(emit(PROVISION_EXPECTED.split("\n"), 1));
    expect(result.stdout).toBe("PASS  CI_REFUSAL_PROVISION_EXPECTED\n");
    expect(result.status).toBe(0);
  });

  // Whether this Bash runs an inherited ERR trap inside a command
  // substitution, and so captures the trap's text, when the substitution
  // is an if condition (as in run_provision_refusal) or, as a control, a
  // plain statement. Run the same way as runAgainstStub: bash -p -c, strict
  // mode, errtrace. Bash 3.2 (macOS) runs it in both; Bash 5 (Ubuntu) only
  // in the plain statement, because an if condition ignores failures inside
  // the substitution too.
  function errTrapCaptured(context: "if-condition" | "statement") {
    const capture =
      context === "if-condition"
        ? 'if out="$( /bin/bash -p -c "exit 1" )"; then :; fi'
        : 'out="$( /bin/bash -p -c "exit 1"; true )"';
    const program = [
      "set -euo pipefail",
      "set -o errtrace",
      `trap 'builtin printf "%s\\n" TRAPPED' ERR`,
      'out=""',
      capture,
      'builtin printf "[%s]" "$out"',
    ].join("\n");
    const result = spawnSync("bash", ["-p", "-c", program], BASH_C_OPTIONS);
    expect(result.status).toBe(0);
    expect(["[TRAPPED]", "[]"]).toContain(result.stdout);
    return result.stdout === "[TRAPPED]";
  }

  test("the ERR-trap probe detects a captured trap (control: a plain capture)", () => {
    expect(errTrapCaptured("statement")).toBe(true);
  });

  test("without trap - ERR, the refusal is misread wherever this Bash captures the trap, and read correctly where it doesn't", () => {
    const mutated = script.replace(
      '    trap - ERR\n    /bin/bash -p "$PROVISION_SCRIPT" 2>&1',
      '    /bin/bash -p "$PROVISION_SCRIPT" 2>&1',
    );
    expect(mutated).not.toBe(script);
    const result = runAgainstStub(
      emit(PROVISION_EXPECTED.split("\n"), 1),
      mutated,
    );
    if (errTrapCaptured("if-condition")) {
      expect(result.stdout).toMatch(
        /^FAIL {2}CI_REFUSAL_UNRECOGNIZED_OUTPUT\n/,
      );
      expect(result.status).toBe(1);
    } else {
      expect(result.stdout).toBe("PASS  CI_REFUSAL_PROVISION_EXPECTED\n");
      expect(result.status).toBe(0);
    }
  });

  test("if the ERR trap's text is captured (as Bash 3.2 does), the refusal is misread: what trap - ERR prevents", () => {
    // The other probe outcome, on every Bash: the stub prints exactly what
    // a captured trap adds to the output.
    const result = runAgainstStub(
      `builtin printf '%s\\n' 'FAIL  CI_REFUSAL_UNEXPECTED_ERROR (line 3)'\n${emit(PROVISION_EXPECTED.split("\n"), 1)}`,
    );
    expect(result.stdout.split("\n")[0]).toBe(
      "FAIL  CI_REFUSAL_UNRECOGNIZED_OUTPUT",
    );
    expect(result.status).toBe(1);
  });

  test("with trap - ERR, the refusal is read correctly whatever this Bash does", () => {
    errTrapCaptured("if-condition");
    const result = runAgainstStub(emit(PROVISION_EXPECTED.split("\n"), 1));
    expect(result.stdout).toBe("PASS  CI_REFUSAL_PROVISION_EXPECTED\n");
  });

  test("a stub that succeeds is caught", () => {
    const result = runAgainstStub(emit(["PASS  CI_PROVISION_COMPLETE (x)"], 0));
    expect(result.stdout.split("\n")[0]).toBe(
      "FAIL  CI_REFUSAL_PROVISION_SUCCEEDED",
    );
    expect(result.status).toBe(1);
  });

  test("a stub that writes to stderr is caught, and its text isn't printed", () => {
    const result = runAgainstStub(
      `builtin printf '%s\\n' '${SECRET}' >&2\n${emit(PROVISION_EXPECTED.split("\n"), 1)}`,
    );
    expect(result.stdout.split("\n")[0]).toBe(
      "FAIL  CI_REFUSAL_UNRECOGNIZED_OUTPUT",
    );
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
  });

  test("the wrong refusal from a stub is reported by code only", () => {
    const result = runAgainstStub(
      emit(["FAIL  CI_PROVISION_CLUSTER_STATE"], 1),
    );
    expect(result.stdout).toBe(
      "FAIL  CI_REFUSAL_WRONG_CODE\n      exit status: 1\n      observed: CI_PROVISION_CLUSTER_STATE\n",
    );
  });
});

describe("ci-expect-refusals.sh: whole-script runs stop at the first gates", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "ci-expect-refusals-run-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (
    args: string[],
    env: Record<string, string> = {},
    flags = ["-p"],
  ) =>
    spawnSync("bash", [...flags, SCRIPT_PATH, ...args], {
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", ...env },
    });

  test.each(["provision", "sql"])(
    "%s: refused without privileged mode",
    (mode) => {
      const result = run([mode], {}, []);
      expect(result.stdout).toBe("FAIL  CI_REFUSAL_NOT_PRIVILEGED_MODE\n");
      expect(result.status).toBe(1);
    },
  );

  test.each([
    [[]],
    [["provision", "sql"]],
    [["provision", "--force"]],
    [["bootstrap"]],
    [["/tmp/other-script.sh"]],
    [["../ci-provision-postgres.sh"]],
    [["PROVISION"]],
    [[""]],
  ])("refuses the arguments %j with exit code 2", (args) => {
    const result = run(args);
    expect(result.stdout).toBe("FAIL  CI_REFUSAL_USAGE\n");
    expect(result.status).toBe(2);
  });

  test.each(["provision", "sql"])(
    "%s: refused outside GitHub Actions",
    (mode) => {
      const result = run([mode]);
      expect(result.stdout).toBe(
        "PASS  CI_REFUSAL_ARGUMENTS\nFAIL  CI_REFUSAL_NOT_GITHUB_ACTIONS\n",
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(1);
    },
  );

  test.each(["provision", "sql"])(
    "%s: refused on a self-hosted runner",
    (mode) => {
      const result = run([mode], {
        GITHUB_ACTIONS: "true",
        CI: "true",
        RUNNER_ENVIRONMENT: "self-hosted",
      });
      expect(result.stdout).toBe(
        "PASS  CI_REFUSAL_ARGUMENTS\nFAIL  CI_REFUSAL_NOT_GITHUB_HOSTED\n",
      );
    },
  );

  test("an imported function and BASH_ENV don't run in privileged mode", () => {
    const fnMarker = `${dir}/function-ran`;
    const envMarker = `${dir}/bash-env-ran`;
    writeFileSync(`${dir}/startup.sh`, `: > '${envMarker}'\n`);
    const result = run(["sql"], {
      "BASH_FUNC_set%%": `() { : > '${fnMarker}'; }`,
      BASH_ENV: `${dir}/startup.sh`,
    });
    expect(existsSync(fnMarker)).toBe(false);
    expect(existsSync(envMarker)).toBe(false);
    expect(result.stdout).toBe(
      "PASS  CI_REFUSAL_ARGUMENTS\nFAIL  CI_REFUSAL_NOT_GITHUB_ACTIONS\n",
    );
  });

  test("explicit tracing shows only the first command", () => {
    const result = run(["sql"], {}, ["-p", "-x"]);
    expect(result.stderr.trim().split("\n")).toEqual(["+ set +x"]);
  });
});

describe("ci-expect-refusals.sh: no database access before every gate", () => {
  const lines = codeLines(script);
  const body = (name: string) => functionBody(script, name);

  test("main runs the gates in order, and sql mode checks the cluster before any SQL", () => {
    expect(body("main")).toEqual([
      'check_arguments "$@"',
      "check_runner",
      "check_environment",
      "check_repository_files",
      "check_credential_state",
      'case "$MODE" in',
      "provision)",
      "run_provision_refusal",
      ";;",
      "sql)",
      "check_cluster_online",
      "check_provisioned",
      "run_sql_refusal",
      ";;",
      "esac",
    ]);
    expect(lines.at(-1)).toBe('main "$@"');
  });

  test("sudo, psql, and the provisioning script appear only in the approved places", () => {
    expect(script.split("sudo:").length).toBe(2);
    expect(lines).toContain(SUDO_KIND_LINE);
    const sudoLines = lines
      .filter((l) => l !== SUDO_KIND_LINE)
      .filter((l) => /\bsudo\b/.test(l))
      .map((l) => l.trim());
    expect(sudoLines).toEqual([
      "sudo -n true || fail CI_REFUSAL_SUDO",
      expect.stringMatching(
        /^answer="\$\(cd \/ && sudo -n -u postgres -- "\$PG_BIN\/psql" -X -q -At -v ON_ERROR_STOP=1 -d postgres -c "SELECT EXISTS \(/,
      ),
      '} | sudo -n -u postgres -- "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -d postgres -f - 2>&1',
    ]);
    expect(body("check_runner")).toContain(
      "sudo -n true || fail CI_REFUSAL_SUDO",
    );
    expect(body("check_provisioned")[1]).toMatch(/sudo -n -u postgres/);
    expect(body("run_sql_refusal")).toContain(
      '} | sudo -n -u postgres -- "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -d postgres -f - 2>&1',
    );
    // The provisioning script is only checked, then run with bash -p.
    expect(
      lines
        .filter((l) => l.includes('"$PROVISION_SCRIPT"'))
        .map((l) => l.trim()),
    ).toEqual([
      'for file in "$PROVISION_SCRIPT" "$SQL_FILE"; do',
      '/bin/bash -p "$PROVISION_SCRIPT" 2>&1',
    ]);
  });

  test("the provisioned check is a single read-only SELECT", () => {
    const query =
      /-c "(SELECT [^"]+)"/.exec(body("check_provisioned")[1] ?? "")?.[1] ?? "";
    expect(query).toMatch(/^SELECT EXISTS \(/);
    expect(query).not.toMatch(
      /;|\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|SET|COPY)\b/i,
    );
  });

  test("the cluster check requires 18/main online, on 127.0.0.1:5432 only", () => {
    const cluster = body("check_cluster_online");
    expect(cluster).toContain(
      '[ "$version" = "18" ] && [ "$cluster" = "main" ] && [ "$port" = "$PORT" ] && [ "$status" = "online" ] && [ "$owner" = "postgres" ] && [ "$data_dir" = "$DATA_DIR" ] || fail CI_REFUSAL_CLUSTER_STATE',
    );
    expect(cluster).toContain(
      '[ "$local_address" = "127.0.0.1:$PORT" ] || fail CI_REFUSAL_LISTENERS',
    );
    expect(cluster).toContain(
      '[ "$(systemctl is-active "$SERVICE" || true)" = "active" ] || fail CI_REFUSAL_SERVICE_NOT_ACTIVE',
    );
  });

  test("the credential state is checked without reading either file", () => {
    const state = body("check_credential_state").join("\n");
    expect(state).not.toMatch(/\b(dd|cat|head|tail|grep|read)\b/);
    expect(state).toContain("fail CI_REFUSAL_VERIFIER_PRESENT");
  });
});

// ---------------------------------------------------------------------------
// Mutation tests

// Static properties; each mutation below must produce at least one.
function violations(text: string): string[] {
  const found = new Set<string>();
  const flag = (name: string, ok: boolean) => {
    if (!ok) found.add(name);
  };
  const lines = codeLines(text);
  const code = lines.join("\n");
  const bodyOf = (name: string) => {
    try {
      return functionBody(text, name);
    } catch {
      return [];
    }
  };

  flag(
    "PRIVILEGED",
    lines[0] === "#!/bin/bash -p" &&
      lines[2] === 'case "$-" in' &&
      lines[3] === "*p*) ;;".padStart(9),
  );
  flag(
    "NO_XTRACE",
    !/\bset\s+-[a-wyz]*x|\bset\s+-o\s+xtrace/.test(code) &&
      lines[1] === "set +x",
  );
  flag(
    "ARGUMENTS",
    JSON.stringify(bodyOf("check_arguments")) ===
      JSON.stringify([
        'case "$-" in',
        "*x*) fail CI_REFUSAL_XTRACE ;;",
        "esac",
        '[ "$#" -eq 1 ] || fail CI_REFUSAL_USAGE 2',
        'case "$1" in',
        'provision) MODE="provision" ;;',
        'sql) MODE="sql" ;;',
        "*) fail CI_REFUSAL_USAGE 2 ;;",
        "esac",
        "pass CI_REFUSAL_ARGUMENTS",
      ]),
  );
  flag(
    "RUNNER",
    [
      '[ "${GITHUB_ACTIONS:-}" = "true" ] || fail CI_REFUSAL_NOT_GITHUB_ACTIONS',
      '[ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ] || fail CI_REFUSAL_NOT_GITHUB_HOSTED',
      '[ "${ImageOS:-}" = "ubuntu26" ] || fail CI_REFUSAL_IMAGE_OS',
      '[ "$USER_ID" != "0" ] || fail CI_REFUSAL_RUNNING_AS_ROOT',
    ].every((l) => bodyOf("check_runner").includes(l)),
  );
  flag(
    "ENVIRONMENT",
    bodyOf("check_environment").includes(
      "PG*|POSTGRES_*|postgres_*|DATABASE_*|TEST_DATABASE_URL) fail CI_REFUSAL_DATABASE_VARIABLE_SET ;;",
    ),
  );
  flag(
    "SQL_GATES",
    /check_cluster_online\ncheck_provisioned\nrun_sql_refusal/.test(
      bodyOf("main").join("\n"),
    ),
  );
  flag(
    "CREDENTIAL_GATE",
    bodyOf("main").includes("check_credential_state") &&
      bodyOf("check_credential_state").includes(
        "fail CI_REFUSAL_VERIFIER_PRESENT",
      ),
  );
  flag(
    "PROVISIONED_ANSWER",
    bodyOf("check_provisioned").includes(
      '[ "$answer" = "t" ] || fail CI_REFUSAL_NOT_PROVISIONED',
    ),
  );
  flag(
    "CAPTURE_TRAP",
    ["run_provision_refusal", "run_sql_refusal"].every((name) => {
      const body = bodyOf(name);
      const capture = body.findIndex((l) => l === 'if output="$(');
      return capture !== -1 && body[capture + 1] === "trap - ERR";
    }),
  );
  flag(
    "NO_SUPPRESSION",
    !/\bset \+e\b|continue-on-error/.test(code) &&
      lines
        .filter((l) => /\|\| true\b/.test(l))
        .every((l) =>
          /^\s*\[ "\$\(systemctl is-active "\$SERVICE" \|\| true\)" = "active" \]/.test(
            l,
          ),
        ),
  );
  flag(
    "OUTPUT",
    !/\becho\b/.test(code) &&
      !/printf[^\n]*\$\{?output\b/.test(code) &&
      ["run_provision_refusal", "run_sql_refusal"].every((name) =>
        bodyOf(name).includes('output=""'),
      ),
  );
  flag(
    "PSQL_OPTIONS",
    !/\/psql"[^\n]*(\s-a\b|\s-e\b|\s-1\b|--single-transaction|--echo)/.test(
      code,
    ) && (code.match(/\/psql" -X -q/g)?.length ?? 0) === 2,
  );
  flag(
    "PLACEHOLDER",
    lines.includes(
      `readonly PLACEHOLDER_VERIFIER='SCRAM-SHA-256$4096:${"A".repeat(22)}==$${"A".repeat(43)}=:${"A".repeat(43)}='`,
    ),
  );
  flag(
    "EXPECTED_CODES",
    lines.includes(
      'readonly EXPECTED_PROVISION_CODE="CI_PROVISION_CREDENTIAL_CONTENTS"',
    ) &&
      lines.includes(
        `readonly EXPECTED_SQL_CODES="${FRESHNESS_CODES.join(", ")}"`,
      ),
  );
  flag(
    "DESTRUCTIVE",
    !/\brm\b|\bchmod\b|\bchown\b|\bmv\b|\binstall\b|\bsystemctl\s+(start|stop|restart|reload|enable|disable)\b|\bpg_(drop|create)cluster\b|\bDROP\b|\bdropdb\b/.test(
      code,
    ),
  );
  flag(
    "SUDO_NONINTERACTIVE",
    lines
      .filter((l) => /\bsudo\b/.test(l))
      .every((l) => /\bsudo -n\b/.test(l) || l === SUDO_KIND_LINE),
  );
  return [...found].sort();
}

const CLASSIFIER_MUTATIONS: Array<[string, string, string]> = [
  [
    "provision: success accepted",
    '  if [ "$status" = "0" ]; then\n    VERDICT="CI_REFUSAL_PROVISION_SUCCEEDED"',
    '  if false; then\n    VERDICT="CI_REFUSAL_PROVISION_SUCCEEDED"',
  ],
  [
    "provision: any exit status accepted",
    '  elif [ "$status" != "1" ]; then',
    "  elif false; then",
  ],
  [
    "provision: any refusal code accepted",
    '[ "$OBSERVED" != "$EXPECTED_PROVISION_CODE" ]',
    "false",
  ],
  [
    "provision: progress ignored",
    '      "PASS  CI_PROVISION_"*) progressed=1 ;;',
    '      "PASS  CI_PROVISION_"*) ;;',
  ],
  [
    "provision: unrecognized lines ignored",
    '      *) unrecognized=1 ;;\n    esac\n  done\n  if [ "$status" = "0" ]; then',
    '      *) ;;\n    esac\n  done\n  if [ "$status" = "0" ]; then',
  ],
  [
    "provision: a missing code accepted",
    '  elif [ "$count" = "0" ]; then\n    VERDICT="CI_REFUSAL_MISSING_CODE"',
    '  elif false; then\n    VERDICT="CI_REFUSAL_MISSING_CODE"',
  ],
  [
    "sql: success accepted",
    '  elif [ "$status" = "0" ]; then\n    VERDICT="CI_REFUSAL_SQL_SUCCEEDED"',
    '  elif false; then\n    VERDICT="CI_REFUSAL_SQL_SUCCEEDED"',
  ],
  [
    "sql: reported success ignored",
    '      "PASS  ci-setup.sql"*) reported=1 ;;',
    '      "PASS  ci-setup.sql"*) ;;',
  ],
  [
    "sql: any exit status accepted",
    '  elif [ "$status" != "3" ]; then',
    "  elif false; then",
  ],
  [
    "sql: missing codes accepted",
    '  elif [ "$missing" = "1" ]; then',
    "  elif false; then",
  ],
  [
    "sql: extra codes accepted",
    '  elif [ "$extra" = "1" ]; then',
    "  elif false; then",
  ],
  [
    "sql: any error accepted",
    '  elif [ "$errors" != "1" ] || [ -z "$codes" ]; then',
    "  elif false; then",
  ],
  [
    "sql: unrecognized lines ignored",
    "        else\n          unrecognized=1\n        fi",
    "        else\n          :\n        fi",
  ],
  [
    "report: failures printed as PASS",
    '  if [ "$VERDICT" = "CI_REFUSAL_EXPECTED" ]; then',
    "  if true; then",
  ],
];

describe("mutation tests: classifier behavior", () => {
  const table = (text: string) => [
    ...PROVISION_CASES.map((c) => ({ mode: "provision" as const, c, text })),
    ...SQL_CASES.map((c) => ({ mode: "sql" as const, c, text })),
  ];
  const mismatches = (text: string) =>
    table(text).filter(({ mode, c }) => {
      const [, status, output, expected] = c;
      const { stdout } = classify(mode, status, output, text);
      const verdict = stdout.startsWith("PASS  ") ? "PASS" : verdictOf(stdout);
      return verdict !== expected;
    }).length;

  test("the real classifiers match every case", () => {
    expect(mismatches(script)).toBe(0);
  });

  test.each(CLASSIFIER_MUTATIONS)("%s is caught", (_name, from, to) => {
    const mutated = script.replace(from, to);
    expect(mutated, "the mutation must change the script").not.toBe(script);
    expect(mismatches(mutated)).toBeGreaterThan(0);
  });
});

describe("mutation tests: static properties", () => {
  test("the real script has every property", () => {
    expect(violations(script)).toEqual([]);
  });

  const mutations: Array<[string, string, string, string]> = [
    [
      "privileged check removed",
      `case "$-" in\n  *p*) ;;\n  *)\n    builtin printf '%s\\n' 'FAIL  CI_REFUSAL_NOT_PRIVILEGED_MODE'\n    exit 1\n    ;;\nesac\n`,
      "",
      "PRIVILEGED",
    ],
    ["shebang without -p", "#!/bin/bash -p\n", "#!/bin/bash\n", "PRIVILEGED"],
    [
      "tracing enabled",
      "set -o errtrace\n",
      "set -o errtrace\nset -x\n",
      "NO_XTRACE",
    ],
    [
      "any argument accepted",
      "    *) fail CI_REFUSAL_USAGE 2 ;;\n  esac\n  pass CI_REFUSAL_ARGUMENTS",
      '    *) MODE="$1" ;;\n  esac\n  pass CI_REFUSAL_ARGUMENTS',
      "ARGUMENTS",
    ],
    [
      "extra arguments accepted",
      '  [ "$#" -eq 1 ] || fail CI_REFUSAL_USAGE 2\n',
      "",
      "ARGUMENTS",
    ],
    [
      "self-hosted accepted",
      '  [ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ] || fail CI_REFUSAL_NOT_GITHUB_HOSTED\n',
      "",
      "RUNNER",
    ],
    [
      "PG* variables accepted",
      "PG*|POSTGRES_*|postgres_*",
      "POSTGRES_*|postgres_*",
      "ENVIRONMENT",
    ],
    ["cluster check skipped", "      check_cluster_online\n", "", "SQL_GATES"],
    ["provisioned check skipped", "      check_provisioned\n", "", "SQL_GATES"],
    [
      "credential state skipped",
      "  check_credential_state\n  case",
      "  case",
      "CREDENTIAL_GATE",
    ],
    [
      "any provisioned answer accepted",
      '[ "$answer" = "t" ] || fail CI_REFUSAL_NOT_PROVISIONED',
      "true",
      "PROVISIONED_ANSWER",
    ],
    [
      "ERR trap captured into the output",
      "    trap - ERR\n    /bin/bash -p",
      "    /bin/bash -p",
      "CAPTURE_TRAP",
    ],
    [
      "a refusal suppressed with || true",
      '  classify_provision "$STATUS" "$output"',
      '  classify_provision "$STATUS" "$output" || true',
      "NO_SUPPRESSION",
    ],
    [
      "errexit turned off",
      "set -o errtrace\n",
      "set -o errtrace\nset +e\n",
      "NO_SUPPRESSION",
    ],
    [
      "captured output printed",
      '  classify_sql "$STATUS" "$output"\n',
      '  builtin printf \'%s\\n\' "$output"\n  classify_sql "$STATUS" "$output"\n',
      "OUTPUT",
    ],
    [
      "captured output echoed",
      '  classify_sql "$STATUS" "$output"\n',
      '  echo "$output"\n  classify_sql "$STATUS" "$output"\n',
      "OUTPUT",
    ],
    [
      "captured output kept",
      '  classify_provision "$STATUS" "$output"\n  output=""\n',
      '  classify_provision "$STATUS" "$output"\n',
      "OUTPUT",
    ],
    [
      "psql -a",
      "-X -q -v ON_ERROR_STOP=1 -d postgres -f -",
      "-X -q -a -v ON_ERROR_STOP=1 -d postgres -f -",
      "PSQL_OPTIONS",
    ],
    [
      "psql --single-transaction",
      "-X -q -v ON_ERROR_STOP=1 -d postgres -f -",
      "-X -q --single-transaction -v ON_ERROR_STOP=1 -d postgres -f -",
      "PSQL_OPTIONS",
    ],
    [
      "psqlrc read",
      '"$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -d postgres -f -',
      '"$PG_BIN/psql" -q -v ON_ERROR_STOP=1 -d postgres -f -',
      "PSQL_OPTIONS",
    ],
    [
      "a real-looking placeholder",
      "AAAAAAAAAAAAAAAAAAAAAA==",
      "AQIDBAUGBwgJCgsMDQ4PEA==",
      "PLACEHOLDER",
    ],
    [
      "the wrong provision code expected",
      'readonly EXPECTED_PROVISION_CODE="CI_PROVISION_CREDENTIAL_CONTENTS"',
      'readonly EXPECTED_PROVISION_CODE="CI_PROVISION_CLUSTER_STATE"',
      "EXPECTED_CODES",
    ],
    [
      "a freshness code dropped",
      'CI_SETUP_DATABASES_NOT_FRESH, CI_SETUP_SETTINGS_NOT_FRESH"',
      'CI_SETUP_DATABASES_NOT_FRESH"',
      "EXPECTED_CODES",
    ],
    [
      "the cluster stopped afterwards",
      "  pass CI_REFUSAL_CLUSTER\n",
      '  sudo -n systemctl stop "$SERVICE"\n  pass CI_REFUSAL_CLUSTER\n',
      "DESTRUCTIVE",
    ],
    [
      "credentials removed",
      "  pass CI_REFUSAL_CREDENTIAL_STATE\n",
      '  rm -- "$dir/$URL_NAME"\n  pass CI_REFUSAL_CREDENTIAL_STATE\n',
      "DESTRUCTIVE",
    ],
    [
      "interactive sudo",
      "sudo -n true || fail CI_REFUSAL_SUDO",
      "sudo true || fail CI_REFUSAL_SUDO",
      "SUDO_NONINTERACTIVE",
    ],
  ];

  test.each(mutations)("%s is caught", (_name, from, to, expected) => {
    const mutated = script.replace(from, to);
    expect(mutated, "the mutation must change the script").not.toBe(script);
    expect(violations(mutated)).toContain(expected);
  });
});

test("runs every test with this file's 30-second timeout", ({ task }) => {
  expect(task.timeout).toBe(30_000);
});
