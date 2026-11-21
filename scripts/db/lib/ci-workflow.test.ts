// Structural and behavioral tests of the PostgreSQL integration job in
// .github/workflows/ci.yml (Phase 4B-2).
//
// The workflow is parsed with a strict parser for the YAML subset it uses
// (anything else is an error, so the file can't drift into constructs these
// tests don't understand). The job's own `run` scripts are then executed in
// a sandbox: a temporary RUNNER_TEMP, stub `tsx`, `dd`, `systemctl`, and
// `sudo` on PATH, and GitHub's shell flags. Nothing here reaches a database,
// the real RUNNER_TEMP, or systemd.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

const WORKFLOW_PATH = ".github/workflows/ci.yml";
const workflowText = readFileSync(WORKFLOW_PATH, "utf8");

// ---------------------------------------------------------------------------
// A strict parser for the YAML subset the workflow uses: block mappings,
// block sequences, literal block scalars (|), plain and quoted scalars, flow
// sequences of plain scalars, and comments. Scalars stay strings.

type Yaml = string | Yaml[] | { [key: string]: Yaml };

type Line = { indent: number; text: string; number: number };

function stripComment(text: string): string {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (i === 0 || /[\s:[,-]/.test(text[i - 1] ?? "")) quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1] ?? ""))) {
      return text.slice(0, i).replace(/\s+$/, "");
    }
  }
  return text;
}

function parseScalar(raw: string, number: number): Yaml {
  const value = raw.trim();
  if (/^[&*!>{]|^---|^\.\.\.$/.test(value)) {
    throw new Error(`line ${number}: unsupported YAML: ${value}`);
  }
  if (value.startsWith('"')) {
    if (!/^"[^"\\]*"$/.test(value))
      throw new Error(`line ${number}: unsupported quoted scalar`);
    return value.slice(1, -1);
  }
  if (value.startsWith("'")) {
    if (!/^'([^']|'')*'$/.test(value))
      throw new Error(`line ${number}: unsupported quoted scalar`);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith("[")) {
    if (!/^\[[^[\]{}'"]*\]$/.test(value))
      throw new Error(`line ${number}: unsupported flow sequence`);
    const inner = value.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((item) => item.trim());
  }
  return value;
}

function parseYaml(text: string): Yaml {
  if (/\t/.test(text)) throw new Error("tabs are not allowed");
  const raw = text.split("\n");
  let i = 0;

  const nextContent = (): Line | undefined => {
    while (i < raw.length) {
      const line = raw[i] ?? "";
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        i += 1;
        continue;
      }
      return {
        indent: line.length - line.trimStart().length,
        text: line.trim(),
        number: i + 1,
      };
    }
    return undefined;
  };

  const blockScalar = (parentIndent: number): string => {
    const lines: string[] = [];
    let indent: number | undefined;
    while (i < raw.length) {
      const line = raw[i] ?? "";
      if (line.trim() === "") {
        lines.push("");
        i += 1;
        continue;
      }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= parentIndent) break;
      indent ??= lineIndent;
      if (lineIndent < indent)
        throw new Error(`line ${i + 1}: inconsistent block indentation`);
      lines.push(line.slice(indent));
      i += 1;
    }
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  };

  // A "key: value" entry. Returns [key, value].
  const entry = (
    content: string,
    indent: number,
    number: number,
  ): [string, Yaml] => {
    const match = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(content);
    if (!match)
      throw new Error(`line ${number}: expected "key: value", got: ${content}`);
    const key = match[1] ?? "";
    const rest = stripComment(match[2] ?? "");
    if (rest === "|") return [key, blockScalar(indent)];
    if (rest !== "") return [key, parseScalar(rest, number)];
    const next = nextContent();
    if (!next || next.indent <= indent)
      throw new Error(`line ${number}: "${key}" has no value`);
    return [key, block(next.indent)];
  };

  const mapping = (indent: number, first?: [string, Yaml]): Yaml => {
    const result: Record<string, Yaml> = {};
    const add = ([key, value]: [string, Yaml], number: number) => {
      if (Object.hasOwn(result, key))
        throw new Error(`line ${number}: duplicate key ${key}`);
      result[key] = value;
    };
    if (first) add(first, 0);
    for (;;) {
      const line = nextContent();
      if (!line || line.indent < indent) break;
      if (line.indent > indent)
        throw new Error(`line ${line.number}: unexpected indentation`);
      if (line.text.startsWith("- ")) break;
      i += 1;
      add(entry(line.text, indent, line.number), line.number);
    }
    return result;
  };

  const sequence = (indent: number): Yaml => {
    const items: Yaml[] = [];
    for (;;) {
      const line = nextContent();
      if (!line || line.indent < indent) break;
      if (line.indent > indent || !line.text.startsWith("- ")) {
        throw new Error(`line ${line.number}: expected a sequence item`);
      }
      i += 1;
      const content = line.text.slice(2);
      if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(content)) {
        items.push(
          mapping(indent + 2, entry(content, indent + 2, line.number)),
        );
      } else {
        items.push(parseScalar(stripComment(content), line.number));
      }
    }
    return items;
  };

  const block = (indent: number): Yaml => {
    const line = nextContent();
    if (!line) throw new Error("unexpected end of file");
    return line.text.startsWith("- ") ? sequence(indent) : mapping(indent);
  };

  const result = block(0);
  if (nextContent())
    throw new Error(`line ${i + 1}: content after the document`);
  return result;
}

const asMap = (value: Yaml | undefined): Record<string, Yaml> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a mapping");
  }
  return value;
};
const asList = (value: Yaml | undefined): Yaml[] => {
  if (!Array.isArray(value)) throw new Error("expected a sequence");
  return value;
};

const workflow = asMap(parseYaml(workflowText));
const jobs = asMap(workflow.jobs);
const job = asMap(jobs["postgres-integration"]);
const steps = asList(job.steps).map(asMap);
const stepNamed = (name: string) => {
  const found = steps.filter((s) => s.name === name);
  if (found.length !== 1) throw new Error(`no single step named ${name}`);
  return found[0] as Record<string, Yaml>;
};
const runOf = (name: string) => {
  const run = stepNamed(name).run;
  if (typeof run !== "string") throw new Error(`step ${name} has no run`);
  return run;
};

// ---------------------------------------------------------------------------
// Running a step's script in a sandbox

type Sandbox = {
  root: string;
  temp: string;
  stubs: string;
  work: string;
  calls: () => string[];
};

let sandbox: Sandbox;

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ci-workflow-")));
  const temp = `${root}/runner-temp`;
  const stubs = `${root}/stubs`;
  const work = `${root}/work`;
  mkdirSync(temp);
  mkdirSync(stubs);
  mkdirSync(`${work}/node_modules/.bin`, { recursive: true });
  const stub = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  // dd: only the exact protected read the workflow is allowed to do.
  stub(
    `${stubs}/dd`,
    [
      'printf \'dd %s\\n\' "$*" >> "$SANDBOX/calls"',
      '[ "$#" -eq 3 ] && [ "$2" = "iflag=nofollow" ] && [ "$3" = "status=none" ] || exit 9',
      'file="${1#if=}"',
      '[ -L "$file" ] && exit 1',
      'cat -- "$file"',
    ].join("\n"),
  );
  // tsx: records what it was asked and whether it got the URL, then prints
  // the configured report.
  stub(
    `${work}/node_modules/.bin/tsx`,
    [
      'printf \'tsx %s\\n\' "$*" >> "$SANDBOX/calls"',
      'printf \'%s\' "${TEST_DATABASE_URL:-}" > "$SANDBOX/received-url"',
      "printf '%b' \"${STUB_OUTPUT:-}\"",
      'exit "${STUB_STATUS:-0}"',
    ].join("\n"),
  );
  // systemctl: postgresql@18-main is loaded (STUB_LOAD) and in STUB_ACTIVE
  // until a successful stop, unless STUB_STAYS_ACTIVE says the stop didn't
  // take effect.
  stub(
    `${stubs}/systemctl`,
    [
      'printf \'systemctl %s\\n\' "$*" >> "$SANDBOX/calls"',
      'if [ "$*" = "show -p LoadState --value postgresql@18-main" ]; then printf \'%s\\n\' "${STUB_LOAD:-loaded}"; exit 0; fi',
      'if [ "$*" = "show -p ActiveState --value postgresql@18-main" ]; then',
      "  if [ -e \"$SANDBOX/stopped\" ]; then printf '%s\\n' inactive; else printf '%s\\n' \"${STUB_ACTIVE:-inactive}\"; fi",
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
  );
  stub(
    `${stubs}/sudo`,
    [
      'printf \'sudo %s\\n\' "$*" >> "$SANDBOX/calls"',
      'status="${STUB_SUDO_STATUS:-0}"',
      'if [ "$status" = "0" ] && [ "$*" = "-n systemctl stop postgresql@18-main" ] && [ -z "${STUB_STAYS_ACTIVE:-}" ]; then : > "$SANDBOX/stopped"; fi',
      'exit "$status"',
    ].join("\n"),
  );
  sandbox = {
    root,
    temp,
    stubs,
    work,
    calls: () =>
      existsSync(`${root}/calls`)
        ? readFileSync(`${root}/calls`, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
        : [],
  };
});

afterEach(() => {
  // Undo any permission a test removed, then delete the sandbox.
  spawnSync("chmod", ["-R", "u+rwx", sandbox.root]);
  rmSync(sandbox.root, { recursive: true, force: true });
});

// GitHub runs `shell: bash` steps as: bash --noprofile --norc -eo pipefail {0}
function runStep(script: string, env: Record<string, string> = {}) {
  return spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
    {
      cwd: sandbox.work,
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: `${sandbox.stubs}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
        SANDBOX: sandbox.root,
        RUNNER_TEMP: sandbox.temp,
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
        RUNNER_OS: "Linux",
        ...env,
      },
    },
  );
}

const SECRET_PASSWORD = "0123456789abcdef".repeat(4);
const TEST_URL = `postgresql://ai_spec_studio_test:${SECRET_PASSWORD}@127.0.0.1:5432/ai_spec_studio_test`;

function writeCredentials() {
  const dir = `${sandbox.temp}/ai-spec-studio-db`;
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(`${dir}/test-database-url`, TEST_URL, { mode: 0o600 });
  return dir;
}

// ---------------------------------------------------------------------------

describe("the workflow file", () => {
  test("parses with the strict parser", () => {
    expect(Object.keys(workflow)).toEqual([
      "name",
      "on",
      "permissions",
      "concurrency",
      "jobs",
    ]);
    expect(Object.keys(jobs)).toEqual(["ci", "postgres-integration"]);
  });

  test("the strict parser rejects what it doesn't support", () => {
    for (const bad of [
      "a: &anchor x\n",
      "a: *alias\n",
      "a: !!str x\n",
      "a: >\n  folded\n",
      "a: {b: c}\n",
      "a: x\na: y\n",
      "a:\n\tb: c\n",
      'a: "x\\ny"\n',
    ]) {
      expect(() => parseYaml(bad), bad).toThrow();
    }
  });

  test("starts with the original workflow, byte for byte (the existing job is unchanged)", () => {
    const original = workflowText.slice(0, 1746);
    expect(createHash("sha256").update(original).digest("hex")).toBe(
      "503657f5be08efbbb3ba084cd103434d2d2670266e9298a5f0edb4110cfdfe4a",
    );
    expect(
      workflowText.slice(1746).startsWith("\n  # Disposable PostgreSQL 18"),
    ).toBe(true);
  });

  test("the existing job still has exactly its steps, runner, and timeout", () => {
    const ci = asMap(jobs.ci);
    expect(ci.name).toBe("Lint, build, and E2E");
    expect(ci["runs-on"]).toBe("ubuntu-24.04");
    expect(ci["timeout-minutes"]).toBe("20");
    expect(asList(ci.steps).map((s) => asMap(s).name)).toEqual([
      "Check out repository",
      "Set up Node.js",
      "Install dependencies",
      "Format check",
      "Lint",
      "Unit tests",
      "Build",
      "Install Playwright Chromium",
      "Run E2E tests",
      "Upload Playwright report and test results",
    ]);
  });

  test("triggers only on pull requests to main and pushes to main", () => {
    expect(workflow.on).toEqual({
      pull_request: { branches: ["main"] },
      push: { branches: ["main"] },
    });
    expect(workflowText).not.toMatch(
      /\b(pull_request_target|workflow_run|issue_comment|workflow_dispatch|repository_dispatch|schedule)\b/,
    );
    expect(workflow.permissions).toEqual({ contents: "read" });
  });
});

describe("the PostgreSQL integration job", () => {
  test("runs on GitHub-hosted ubuntu-26.04 with a 15-minute limit, read-only contents, and bash", () => {
    expect(job.name).toBe("PostgreSQL integration");
    expect(job["runs-on"]).toBe("ubuntu-26.04");
    expect(job["timeout-minutes"]).toBe("15");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.defaults).toEqual({ run: { shell: "bash" } });
  });

  test("is independent of the existing job and has no job-level environment, services, or container", () => {
    expect(Object.keys(job).sort()).toEqual(
      [
        "defaults",
        "name",
        "permissions",
        "runs-on",
        "steps",
        "timeout-minutes",
      ].sort(),
    );
  });

  test("runs exactly the approved steps, in order", () => {
    expect(steps.map((s) => s.name)).toEqual([
      "Check out repository",
      "Set up Node.js",
      "Install dependencies",
      "Runner and PostgreSQL preflight",
      "Generate disposable credentials",
      "Provision PostgreSQL",
      "Expect a second provisioning to be refused",
      "Expect a second ci-setup.sql run to be refused",
      "Verify server identity and negative security probes",
      "Check the test database is fresh",
      "Apply the test database migration",
      "Check the migration is applied",
      "Run the PostgreSQL integration tests",
      "Check the integration test results",
      "Clean up credentials and stop PostgreSQL",
    ]);
  });

  test("uses the same pinned checkout and setup-node as the existing job, without persisted credentials", () => {
    const ciSteps = asList(asMap(jobs.ci).steps).map(asMap);
    expect(steps[0]).toEqual(ciSteps[0]);
    expect(steps[1]).toEqual(ciSteps[1]);
    expect(steps[0]?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(steps[1]?.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    expect(asMap(steps[0]?.with)).toEqual({ "persist-credentials": "false" });
    expect(asMap(steps[1]?.with)).toEqual({
      "node-version-file": ".nvmrc",
      cache: "npm",
    });
    expect(readFileSync(".nvmrc", "utf8").trim()).toBe("24");
  });

  test("uses no other action: no artifact upload, cache action, or third-party step", () => {
    expect(steps.filter((s) => "uses" in s)).toHaveLength(2);
  });

  test("no step sets an environment, continues on error, or runs conditionally except cleanup", () => {
    for (const step of steps) {
      expect(Object.keys(step)).not.toContain("env");
      expect(Object.keys(step)).not.toContain("continue-on-error");
      expect(Object.keys(step)).not.toContain("shell");
      expect(Object.keys(step)).not.toContain("working-directory");
      if (step.name === "Clean up credentials and stop PostgreSQL") {
        expect(step.if).toBe("${{ always() }}");
      } else {
        expect(Object.keys(step)).not.toContain("if");
      }
    }
  });

  test("the credential, provisioning, refusal, and verification steps call the approved entry points", () => {
    expect(runOf("Install dependencies")).toBe("npm ci");
    expect(runOf("Generate disposable credentials")).toBe(
      "./node_modules/.bin/tsx scripts/db/ci-credentials.ts",
    );
    expect(runOf("Provision PostgreSQL")).toBe(
      "bash -p scripts/db/ci-provision-postgres.sh",
    );
    expect(runOf("Expect a second provisioning to be refused")).toBe(
      "bash -p scripts/db/ci-expect-refusals.sh provision",
    );
    expect(runOf("Expect a second ci-setup.sql run to be refused")).toBe(
      "bash -p scripts/db/ci-expect-refusals.sh sql",
    );
    expect(runOf("Verify server identity and negative security probes")).toBe(
      "./node_modules/.bin/tsx scripts/db/ci-verify-postgres.ts",
    );
  });

  test("every Bash script it runs is run in privileged mode", () => {
    const shellScripts = steps
      .map((s) => s.run)
      .filter((r): r is string => typeof r === "string")
      .flatMap((r) =>
        [...r.matchAll(/\b(\S+\.sh)\b/g)].map((m) => ({
          run: r,
          script: m[1],
        })),
      );
    expect(shellScripts.map((s) => s.script)).toEqual([
      "scripts/db/ci-provision-postgres.sh",
      "scripts/db/ci-expect-refusals.sh",
      "scripts/db/ci-expect-refusals.sh",
    ]);
    for (const { run, script } of shellScripts) {
      expect(run).toContain(`bash -p ${script}`);
    }
  });

  test("the referenced entry points exist, and the steps use their real interfaces", () => {
    for (const file of [
      "scripts/db/ci-credentials.ts",
      "scripts/db/ci-provision-postgres.sh",
      "scripts/db/ci-expect-refusals.sh",
      "scripts/db/ci-verify-postgres.ts",
      "scripts/db/test-database-check.ts",
    ]) {
      expect(existsSync(file), file).toBe(true);
    }
    const check = readFileSync("scripts/db/test-database-check.ts", "utf8");
    expect(check).toContain('if (process.argv[2] !== "pre") {');
    expect(check).toContain(
      "if (state) console.log(`Test database state: ${state}`);",
    );
    const scripts = (
      JSON.parse(readFileSync("package.json", "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["db:migrate:test"]).toBe(
      "tsx scripts/db/migrate-test-database.ts",
    );
    expect(scripts["test:integration"]).toBe(
      "AI_SPEC_STUDIO_INTEGRATION=1 vitest run --project integration",
    );
  });

  test("step time limits are set where a hang is possible", () => {
    expect(stepNamed("Provision PostgreSQL")["timeout-minutes"]).toBe("5");
    expect(
      stepNamed("Verify server identity and negative security probes")[
        "timeout-minutes"
      ],
    ).toBe("3");
    expect(
      stepNamed("Apply the test database migration")["timeout-minutes"],
    ).toBe("3");
    expect(
      stepNamed("Run the PostgreSQL integration tests")["timeout-minutes"],
    ).toBe("8");
    expect(
      stepNamed("Clean up credentials and stop PostgreSQL")["timeout-minutes"],
    ).toBe("3");
  });

  test("cleanup is the last step, always runs, and is limited to 3 minutes", () => {
    const cleanup = steps.at(-1);
    expect(cleanup?.name).toBe("Clean up credentials and stop PostgreSQL");
    expect(cleanup?.if).toBe("${{ always() }}");
    expect(cleanup?.["timeout-minutes"]).toBe("3");
    expect(Object.keys(cleanup ?? {}).sort()).toEqual(
      ["if", "name", "run", "timeout-minutes"].sort(),
    );
  });
});

// The one line that may name TEST_DATABASE_URL outside the URL steps: the
// preflight's refusal pattern, which fails the job if the variable is set.
const REFUSAL_PATTERN =
  "PG*|POSTGRES_*|postgres_*|DATABASE_*|TEST_DATABASE_URL)";
const withoutRefusalPattern = (run: string) =>
  run
    .split("\n")
    .filter((l) => l.trim() !== REFUSAL_PATTERN)
    .join("\n");

describe("credential handling in the job", () => {
  const runs = steps
    .map((s) => (typeof s.run === "string" ? s.run : ""))
    .join("\n");
  const URL_STEPS = [
    "Check the test database is fresh",
    "Apply the test database migration",
    "Check the migration is applied",
    "Run the PostgreSQL integration tests",
  ];

  test("uses no secrets, no GITHUB_ENV or GITHUB_OUTPUT, and no tracing", () => {
    expect(workflowText).not.toMatch(/\$\{\{\s*secrets\./);
    expect(runs).not.toMatch(
      /GITHUB_ENV|GITHUB_OUTPUT|GITHUB_STATE|::add-mask::|::set-output/,
    );
    expect(runs).not.toMatch(
      /\bset\s+-[a-wyz]*x|\bset\s+-o\s+xtrace|\bbash\s+-[a-oq-z]*x/,
    );
    expect(runs).not.toMatch(/\|\|\s*true\b|\bset \+e\b/);
  });

  test("TEST_DATABASE_URL is read from the protected file and given only to the commands that need it", () => {
    for (const step of steps) {
      const run = withoutRefusalPattern(
        typeof step.run === "string" ? step.run : "",
      );
      const uses = run
        .split("\n")
        .filter((l) => l.includes("TEST_DATABASE_URL"));
      if (!URL_STEPS.includes(String(step.name))) {
        expect(uses, String(step.name)).toEqual([]);
        expect(run).not.toContain("test-database-url");
        continue;
      }
      const lines = run.split("\n").map((l) => l.trim());
      expect(lines[0]).toBe(
        'url="$(dd if="$RUNNER_TEMP/ai-spec-studio-db/test-database-url" iflag=nofollow status=none)"',
      );
      // Only as a one-command prefix, never exported or printed.
      expect(uses).toHaveLength(1);
      expect(uses[0]).toMatch(
        /TEST_DATABASE_URL="\$url" (\.\/node_modules\/\.bin\/tsx|npm) /,
      );
      expect(run).not.toMatch(/export\s+(TEST_DATABASE_URL|url)\b/);
      expect(run).not.toMatch(/(printf|echo)[^\n]*\$\{?url\b/);
    }
  });

  test("the preflight and verification steps never see the URL", () => {
    for (const name of [
      "Runner and PostgreSQL preflight",
      "Generate disposable credentials",
      "Provision PostgreSQL",
      "Expect a second provisioning to be refused",
      "Expect a second ci-setup.sql run to be refused",
      "Verify server identity and negative security probes",
      "Check the integration test results",
      "Clean up credentials and stop PostgreSQL",
    ]) {
      expect(withoutRefusalPattern(runOf(name))).not.toMatch(
        /TEST_DATABASE_URL|\$url\b|test-database-url/,
      );
    }
  });

  test("the preflight names TEST_DATABASE_URL only in its refusal pattern", () => {
    const lines = runOf("Runner and PostgreSQL preflight")
      .split("\n")
      .map((l) => l.trim());
    expect(lines.filter((l) => l.includes("TEST_DATABASE_URL"))).toEqual([
      REFUSAL_PATTERN,
    ]);
  });

  test("the preflight is read only: no sudo, no write, no service change", () => {
    const run = runOf("Runner and PostgreSQL preflight");
    expect(run).not.toMatch(
      /\bsudo\b|\brm\b|\bmkdir\b|\binstall\b|>\s*[^&/]|\bsystemctl\s+(start|stop|restart|enable|disable)\b/,
    );
  });
});

describe("the state checks (run in a sandbox with a stub tsx)", () => {
  const cases: Array<["fresh" | "applied", string]> = [
    ["fresh", "Check the test database is fresh"],
    ["applied", "Check the migration is applied"],
  ];

  test.each(cases)(
    "%s: passes on exactly one matching state line, and prints the report",
    (state, name) => {
      writeCredentials();
      const report = `PASS  connected as the test role\\n\\nALL 30 CHECKS PASSED\\nTest database state: ${state}\\n`;
      const result = runStep(runOf(name), { STUB_OUTPUT: report });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Test database state: ${state}`);
      expect(readFileSync(`${sandbox.root}/received-url`, "utf8")).toBe(
        TEST_URL,
      );
      expect(sandbox.calls()).toEqual([
        `dd if=${sandbox.temp}/ai-spec-studio-db/test-database-url iflag=nofollow status=none`,
        "tsx scripts/db/test-database-check.ts pre",
      ]);
      expect(result.stdout + result.stderr).not.toContain(SECRET_PASSWORD);
    },
  );

  test.each([
    [
      "the other state",
      (s: string) =>
        `Test database state: ${s === "fresh" ? "applied" : "fresh"}\\n`,
    ],
    ["the unexpected state", () => "Test database state: unexpected\\n"],
    ["no state line", () => "ALL 30 CHECKS PASSED\\n"],
    [
      "two state lines",
      (s: string) => `Test database state: ${s}\\nTest database state: ${s}\\n`,
    ],
    ["a near-miss line", (s: string) => `Test database state: ${s} \\n`],
  ])("fails on %s", (_label, output) => {
    for (const [state, name] of cases) {
      writeCredentials();
      const result = runStep(runOf(name), { STUB_OUTPUT: output(state) });
      expect(result.status, `${name}`).toBe(1);
      expect(result.stdout).toContain(
        `FAIL  expected exactly one state line: ${state}`,
      );
      rmSync(`${sandbox.temp}/ai-spec-studio-db`, { recursive: true });
    }
  });

  test.each(cases)(
    "%s: a failing check fails the step, after printing its report",
    (state, name) => {
      writeCredentials();
      const result = runStep(runOf(name), {
        STUB_OUTPUT: `FAIL  state: neither fresh nor exactly the approved migration\\nTest database state: ${state}\\n`,
        STUB_STATUS: "1",
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("FAIL  state: neither fresh");
    },
  );

  test.each(cases)(
    "%s: a missing URL file fails the step before the check runs",
    (_state, name) => {
      const result = runStep(runOf(name), {
        STUB_OUTPUT: "Test database state: fresh\\n",
      });
      expect(result.status).not.toBe(0);
      expect(sandbox.calls().some((c) => c.startsWith("tsx "))).toBe(false);
    },
  );

  test.each(cases)(
    "%s: a URL file that is a symbolic link is refused",
    (_state, name) => {
      const dir = `${sandbox.temp}/ai-spec-studio-db`;
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(`${sandbox.root}/elsewhere`, TEST_URL);
      symlinkSync(`${sandbox.root}/elsewhere`, `${dir}/test-database-url`);
      const result = runStep(runOf(name), {
        STUB_OUTPUT: "Test database state: fresh\\n",
      });
      expect(result.status).not.toBe(0);
      expect(sandbox.calls().some((c) => c.startsWith("tsx "))).toBe(false);
    },
  );
});

describe("the migration and integration-test steps", () => {
  test("migrate with the package script, given the URL", () => {
    writeCredentials();
    const npm = `${sandbox.stubs}/npm`;
    writeFileSync(
      npm,
      '#!/bin/bash\nprintf \'npm %s\\n\' "$*" >> "$SANDBOX/calls"\nprintf \'%s\' "${TEST_DATABASE_URL:-}" > "$SANDBOX/received-url"\n',
    );
    chmodSync(npm, 0o755);
    const result = runStep(runOf("Apply the test database migration"));
    expect(result.status).toBe(0);
    expect(sandbox.calls().at(-1)).toBe("npm run db:migrate:test");
    expect(readFileSync(`${sandbox.root}/received-url`, "utf8")).toBe(TEST_URL);
  });

  test("run the integration project with a JSON report in RUNNER_TEMP", () => {
    writeCredentials();
    const npm = `${sandbox.stubs}/npm`;
    writeFileSync(
      npm,
      '#!/bin/bash\nprintf \'npm %s\\n\' "$*" >> "$SANDBOX/calls"\nprintf \'%s\' "${TEST_DATABASE_URL:-}" > "$SANDBOX/received-url"\nexit "${STUB_STATUS:-0}"\n',
    );
    chmodSync(npm, 0o755);
    const result = runStep(runOf("Run the PostgreSQL integration tests"));
    expect(result.status).toBe(0);
    expect(sandbox.calls().at(-1)).toBe(
      `npm run test:integration -- --reporter=default --reporter=json --outputFile.json=${sandbox.temp}/integration-results.json`,
    );
    expect(readFileSync(`${sandbox.root}/received-url`, "utf8")).toBe(TEST_URL);
    // A failing test run fails the step.
    expect(
      runStep(runOf("Run the PostgreSQL integration tests"), {
        STUB_STATUS: "1",
      }).status,
    ).toBe(1);
  });
});

// A Vitest 5 JSON report, shaped as its JsonReporter writes it.
function report(
  overrides: Record<string, unknown> = {},
  testsPerFile = [8, 57],
) {
  const testResults = testsPerFile.map((count, f) => ({
    assertionResults: Array.from({ length: count }, (_, t) => ({
      ancestorTitles: [`file ${f}`],
      fullName: `file ${f} test ${t}`,
      status: "passed",
      title: `test ${t}`,
      duration: 1,
      failureMessages: [],
      meta: {},
      tags: [],
    })),
    startTime: 0,
    endTime: 1,
    status: "passed",
    message: "",
    name: `/work/src/lib/db/file${f}.integration.test.ts`,
  }));
  const total = testsPerFile.reduce((a, b) => a + b, 0);
  return {
    numTotalTestSuites: 4,
    numPassedTestSuites: 4,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: total,
    numPassedTests: total,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    snapshot: {},
    startTime: 0,
    success: true,
    testResults,
    ...overrides,
  };
}

describe("the integration result check (run on Vitest-shaped reports)", () => {
  const check = (content: unknown) => {
    writeFileSync(
      `${sandbox.temp}/integration-results.json`,
      typeof content === "string" ? content : JSON.stringify(content),
    );
    return runStep(runOf("Check the integration test results"));
  };

  test("passes 65 of 65 passed tests and prints counts only", () => {
    const result = check(report());
    expect(result.stdout).toBe(
      "PASS  integration tests: 65 of 65 passed in 2 files\n",
    );
    expect(result.status).toBe(0);
  });

  test("passes more than 65", () => {
    expect(check(report({}, [8, 60])).stdout).toBe(
      "PASS  integration tests: 68 of 68 passed in 2 files\n",
    );
  });

  const failing: Array<[string, () => unknown, string]> = [
    ["fewer than 65 tests", () => report({}, [8, 56]), "FEWER_THAN_65_TESTS"],
    [
      "a failed test",
      () => {
        const r = report({
          numFailedTests: 1,
          numPassedTests: 64,
          success: false,
        });
        r.testResults[1]!.assertionResults[0]!.status = "failed";
        r.testResults[1]!.status = "failed";
        return r;
      },
      "FAILED_TESTS",
    ],
    [
      "a skipped test (counted as pending)",
      () => {
        const r = report({ numPendingTests: 1, numPassedTests: 64 });
        r.testResults[0]!.assertionResults[0]!.status = "skipped";
        return r;
      },
      "SKIPPED_OR_PENDING_TESTS",
    ],
    [
      "a todo test",
      () => {
        const r = report({ numTodoTests: 1, numPassedTests: 64 });
        r.testResults[0]!.assertionResults[0]!.status = "todo";
        return r;
      },
      "TODO_TESTS",
    ],
    [
      "success false with clean counts",
      () => report({ success: false }),
      "NOT_SUCCESSFUL",
    ],
    [
      "a failed suite",
      () => report({ numFailedTestSuites: 1 }),
      "SUITES_NOT_PASSED",
    ],
    [
      "a pending suite",
      () => report({ numPendingTestSuites: 1 }),
      "SUITES_NOT_PASSED",
    ],
    [
      "totals that don't add up",
      () => report({ numTotalTests: 70 }),
      "INCONSISTENT_TOTALS",
    ],
    [
      "counts claiming a pass for a failed test",
      () => {
        const r = report();
        r.testResults[1]!.assertionResults[3]!.status = "failed";
        return r;
      },
      "TEST_NOT_PASSED",
    ],
    [
      "a failed file",
      () => {
        const r = report();
        r.testResults[0]!.status = "failed";
        return r;
      },
      "FILE_NOT_PASSED",
    ],
    [
      "no test files",
      () => report({ testResults: [], numTotalTests: 0, numPassedTests: 0 }),
      "FILE_NOT_PASSED",
    ],
    [
      "counts that aren't integers",
      () => report({ numFailedTests: "0" }),
      "FAILED_TESTS",
    ],
    [
      "a missing count",
      () => {
        const r: Record<string, unknown> = report();
        delete r.numTodoTests;
        return r;
      },
      "TODO_TESTS",
    ],
  ];

  test.each(failing)("fails on %s", (_name, make, code) => {
    const result = check(make());
    expect(result.status).toBe(1);
    expect(result.stdout.startsWith("FAIL  ")).toBe(true);
    expect(result.stdout).toContain(code);
  });

  test.each([
    ["malformed JSON", "{not json"],
    ["an empty file", ""],
  ])("fails on %s", (_name, content) => {
    const result = check(content);
    expect(result.stdout).toBe("FAIL  INTEGRATION_RESULTS_UNREADABLE\n");
    expect(result.status).toBe(1);
  });

  test("fails when the report is missing", () => {
    const result = runStep(runOf("Check the integration test results"));
    expect(result.stdout).toBe("FAIL  INTEGRATION_RESULTS_UNREADABLE\n");
    expect(result.status).toBe(1);
  });

  test("fails when the report is a symbolic link", () => {
    writeFileSync(`${sandbox.root}/elsewhere.json`, JSON.stringify(report()));
    symlinkSync(
      `${sandbox.root}/elsewhere.json`,
      `${sandbox.temp}/integration-results.json`,
    );
    const result = runStep(runOf("Check the integration test results"));
    expect(result.stdout).toBe("FAIL  INTEGRATION_RESULTS_UNREADABLE\n");
  });

  test("never prints failure messages from the report", () => {
    const r = report({ numFailedTests: 1, numPassedTests: 64, success: false });
    r.testResults[1]!.assertionResults[0]!.status = "failed";
    (
      r.testResults[1]!.assertionResults[0] as { failureMessages: string[] }
    ).failureMessages = [`error: password authentication failed ${TEST_URL}`];
    const result = check(r);
    expect(result.stdout + result.stderr).not.toContain(SECRET_PASSWORD);
    expect(result.stdout + result.stderr).not.toContain("postgresql://");
  });

  test("requires the count the repository actually has: at least 65 integration test cases", () => {
    const files = readdirSync("src/lib/db").filter((f) =>
      f.endsWith(".integration.test.ts"),
    );
    let total = 0;
    for (const file of files) {
      const source = readFileSync(`src/lib/db/${file}`, "utf8");
      total += (source.match(/^\s*(test|it)\(/gm) ?? []).length;
      // test.each([...]) rows: one per top-level element of the array.
      for (const m of source.matchAll(/test\.each\(\s*\[/g)) {
        let depth = 1;
        let items = 0;
        let value = false;
        let quote: string | undefined;
        for (
          let i = (m.index ?? 0) + m[0].length;
          i < source.length && depth > 0;
          i += 1
        ) {
          const ch = source[i] ?? "";
          if (quote) {
            if (ch === "\\") i += 1;
            else if (ch === quote) quote = undefined;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            if (depth === 1) value = true;
          } else if ("[{(".includes(ch)) {
            if (depth === 1) value = true;
            depth += 1;
          } else if ("]})".includes(ch)) {
            depth -= 1;
          } else if (depth === 1 && ch === ",") {
            if (value) items += 1;
            value = false;
          } else if (depth === 1 && /\S/.test(ch)) {
            value = true;
          }
        }
        if (value) items += 1;
        total += items;
      }
    }
    expect(total).toBe(65);
    expect(runOf("Check the integration test results")).toContain(
      'if (total < 65) problems.push("FEWER_THAN_65_TESTS");',
    );
  });
});

describe("cleanup (run in a sandbox with stub systemctl and sudo)", () => {
  const cleanup = () => runOf("Clean up credentials and stop PostgreSQL");

  test("removes the credential directory and the report, stops the cluster, and passes", () => {
    const dir = writeCredentials();
    writeFileSync(`${sandbox.temp}/integration-results.json`, "{}");
    writeFileSync(`${sandbox.temp}/keep-me`, "unrelated");
    const result = runStep(cleanup(), { STUB_ACTIVE: "active" });
    expect(result.stdout).toBe("PASS  CLEANUP\n");
    expect(result.status).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${sandbox.temp}/integration-results.json`)).toBe(false);
    expect(readFileSync(`${sandbox.temp}/keep-me`, "utf8")).toBe("unrelated");
    expect(sandbox.calls()).toContain(
      "sudo -n systemctl stop postgresql@18-main",
    );
  });

  test("passes with nothing to remove and an inactive cluster, without calling sudo", () => {
    const result = runStep(cleanup());
    expect(result.stdout).toBe("PASS  CLEANUP\n");
    expect(sandbox.calls().filter((c) => c.startsWith("sudo"))).toEqual([]);
  });

  test("only ever stops the CI cluster, and runs no database command", () => {
    runStep(cleanup(), { STUB_ACTIVE: "failed" });
    const sudo = sandbox.calls().filter((c) => c.startsWith("sudo"));
    expect(sudo).toEqual(["sudo -n systemctl stop postgresql@18-main"]);
    expect(cleanup()).not.toMatch(
      /\bpsql\b|\bdropdb\b|\bpg_dropcluster\b|\bDROP\b|rm -rf|rm -fr|\bfind\b/,
    );
  });

  test("refuses a symbolic-link credential directory and leaves its target alone, but still stops the cluster", () => {
    mkdirSync(`${sandbox.root}/target`);
    writeFileSync(`${sandbox.root}/target/important`, "keep");
    symlinkSync(`${sandbox.root}/target`, `${sandbox.temp}/ai-spec-studio-db`);
    const result = runStep(cleanup(), { STUB_ACTIVE: "active" });
    expect(result.stdout).toBe("FAIL  CLEANUP_CREDENTIALS_SYMLINK\n");
    expect(result.status).toBe(1);
    expect(readFileSync(`${sandbox.root}/target/important`, "utf8")).toBe(
      "keep",
    );
    expect(sandbox.calls()).toContain(
      "sudo -n systemctl stop postgresql@18-main",
    );
  });

  test("refuses a credential path that isn't a directory", () => {
    writeFileSync(`${sandbox.temp}/ai-spec-studio-db`, "not a directory");
    const result = runStep(cleanup());
    expect(result.stdout).toBe("FAIL  CLEANUP_CREDENTIALS_UNEXPECTED\n");
    expect(existsSync(`${sandbox.temp}/ai-spec-studio-db`)).toBe(true);
  });

  test("refuses a symbolic-link report and leaves its target alone", () => {
    writeFileSync(`${sandbox.root}/report-target`, "keep");
    symlinkSync(
      `${sandbox.root}/report-target`,
      `${sandbox.temp}/integration-results.json`,
    );
    const result = runStep(cleanup());
    expect(result.stdout).toBe("FAIL  CLEANUP_RESULTS_SYMLINK\n");
    expect(readFileSync(`${sandbox.root}/report-target`, "utf8")).toBe("keep");
  });

  test("refuses a report path that is a directory", () => {
    mkdirSync(`${sandbox.temp}/integration-results.json`);
    const result = runStep(cleanup());
    expect(result.stdout).toBe("FAIL  CLEANUP_RESULTS_UNEXPECTED\n");
    expect(existsSync(`${sandbox.temp}/integration-results.json`)).toBe(true);
  });

  test("reports a removal that fails instead of hiding it", () => {
    const dir = writeCredentials();
    mkdirSync(`${dir}/locked`);
    writeFileSync(`${dir}/locked/file`, "x");
    chmodSync(`${dir}/locked`, 0o500);
    const result = runStep(cleanup());
    expect(result.stdout).toContain("FAIL  CLEANUP_CREDENTIALS\n");
    expect(result.status).toBe(1);
  });

  test("reports a failed stop instead of hiding it", () => {
    const result = runStep(cleanup(), {
      STUB_ACTIVE: "active",
      STUB_SUDO_STATUS: "1",
    });
    expect(result.stdout).toBe("FAIL  CLEANUP_STOP_POSTGRESQL\n");
    expect(result.status).toBe(1);
  });

  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["relative", "runner-temp"],
    ["with a traversal", "/tmp/../tmp"],
    ["with a trailing slash", "/tmp/"],
    ["with a space", "/tmp/a b"],
  ])("refuses a RUNNER_TEMP that is %s, removing nothing", (_name, value) => {
    const dir = writeCredentials();
    const env: Record<string, string> = {};
    if (value !== undefined) env.RUNNER_TEMP = value;
    const script =
      value === undefined ? `unset RUNNER_TEMP\n${cleanup()}` : cleanup();
    const result = runStep(script, env);
    expect(result.stdout).toBe("FAIL  CLEANUP_RUNNER_TEMP\n");
    expect(result.status).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });

  test("refuses a RUNNER_TEMP reached through a symbolic link", () => {
    const dir = writeCredentials();
    symlinkSync(sandbox.temp, `${sandbox.root}/temp-link`);
    const result = runStep(cleanup(), {
      RUNNER_TEMP: `${sandbox.root}/temp-link`,
    });
    expect(result.stdout).toBe("FAIL  CLEANUP_RUNNER_TEMP\n");
    expect(existsSync(dir)).toBe(true);
  });
});

describe("the preflight's variable check (run in a sandbox)", () => {
  const loop = () => {
    const run = runOf("Runner and PostgreSQL preflight");
    const start = run.indexOf("for name in $(compgen -e); do");
    expect(start).toBeGreaterThan(-1);
    return run.slice(start);
  };

  test("passes with no database variable", () => {
    expect(runStep(loop()).status).toBe(0);
  });

  test.each([
    "PGHOST",
    "PGPASSWORD",
    "POSTGRES_PASSWORD",
    "DATABASE_URL",
    "TEST_DATABASE_URL",
  ])("fails on %s, printing its name and never its value", (name) => {
    const result = runStep(loop(), { [name]: TEST_URL });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`FAIL  a database variable is set: ${name}\n`);
    expect(result.stdout).not.toContain(SECRET_PASSWORD);
  });
});

describe("the job leaves earlier phases alone", () => {
  // The implementation files of Phases 2, 3, and 4B-1 as reviewed. A change
  // to any of them needs its own review, not a side effect of the workflow.
  const REVIEWED: Record<string, string> = {
    "scripts/db/lib/ci-runner.ts":
      "f0094a75e41c4159662f69bc7d23cc2f74662e7e0ef0548dd9efe95393ba1f7a",
    "scripts/db/lib/ci-credentials.ts":
      "08315a6666e3b5bfeeca1b10e8b686a5dee6f738bc66d250c6dd2db671f2ab6e",
    "scripts/db/lib/ci-credential-files.ts":
      "0f57d85f45a4a659b60cb8af1b6947e8b2f6396e33a1bea1e1a110aeea7f7b63",
    "scripts/db/ci-credentials.ts":
      "9b9f43c85ddfda5fe3e0700b8b5d40f68be06a09b2a3e51a43eade83fb1b04d2",
    "scripts/db/ci/pg_hba.conf":
      "7bd343260de1cd7216d59b41e921b42251a423e6f87b1f446eef58b1ec3444f0",
    "scripts/db/ci/postgresql-ci.conf":
      "79159a342b5dfd8563b3c9bffcebf672914e7f9d59ded1556f0fcfb50ac210ec",
    "scripts/db/ci-setup.sql":
      "4109d4ff9d6874202d667ed6166ff5eb6360194a6818962a953603a66fe801c0",
    "scripts/db/ci-provision-postgres.sh":
      "2a752e94a09991b97e10252a5368e31469a2007c3d9b8c3714566652533761d0",
    "scripts/db/ci-verify-postgres.ts":
      "e8c59776cd307c5c082e374e069e1699ec2f8459654fa7359a23c93716392083",
    "scripts/db/lib/ci-postgres-probes.ts":
      "817fe37d25407893045e42a79a20ba3d2bcd8b8b3788687c8242a60b71c3dfcb",
    "scripts/db/ci-expect-refusals.sh":
      "afc66280fbaef288c708c8f2b462f8aa78931ae934bfbc47de17461800e99057",
  };

  test.each(Object.entries(REVIEWED))(
    "%s is the reviewed version",
    (file, hash) => {
      expect(
        createHash("sha256").update(readFileSync(file)).digest("hex"),
      ).toBe(hash);
    },
  );
});

describe("the documentation", () => {
  const readme = readFileSync("scripts/db/README.md", "utf8");
  const claude = readFileSync("CLAUDE.md", "utf8");

  test("no longer says CI never runs the integration tests", () => {
    expect(claude).not.toContain("Never part of `test:unit` or CI");
    expect(readme).not.toContain("`npm run test:unit` and CI never include it");
  });

  test("describes the CI job and says it hasn't run on GitHub yet", () => {
    expect(readme).toContain("## CI integration tests");
    expect(readme).toContain("**Not yet run on GitHub.**");
    expect(claude).toContain("`postgres-integration`: on `ubuntu-26.04`");
    for (const text of [readme, claude]) {
      expect(text).not.toMatch(
        /\b(passes|passed|verified|succeeds|succeeded) (on GitHub|in CI)\b/i,
      );
    }
  });

  test("names every step of the job, in the job's order", () => {
    const section = readme.slice(readme.indexOf("## CI integration tests"));
    const commands = [
      "`npm ci`",
      "`tsx scripts/db/ci-credentials.ts`",
      "`bash -p scripts/db/ci-provision-postgres.sh`",
      "`bash -p scripts/db/ci-expect-refusals.sh provision`",
      "`bash -p scripts/db/ci-expect-refusals.sh sql`",
      "`tsx scripts/db/ci-verify-postgres.ts`",
      "`npm run db:migrate:test`",
      "`npm run test:integration`",
    ];
    const positions = commands.map((c) => section.indexOf(c));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

test("runs every test with this file's 30-second timeout", ({ task }) => {
  expect(task.timeout).toBe(30_000);
});

describe("cleanup: files and the service are independent", () => {
  const cleanup = () => runOf("Clean up credentials and stop PostgreSQL");
  const sudoCalls = () => sandbox.calls().filter((c) => c.startsWith("sudo"));
  const invalidTemp = { RUNNER_TEMP: "relative/runner-temp" };

  test("an invalid RUNNER_TEMP still stops the active cluster, and the step still fails", () => {
    const dir = writeCredentials();
    const result = runStep(cleanup(), {
      ...invalidTemp,
      STUB_ACTIVE: "active",
    });
    expect(result.stdout).toBe("FAIL  CLEANUP_RUNNER_TEMP\n");
    expect(result.status).toBe(1);
    expect(sudoCalls()).toEqual(["sudo -n systemctl stop postgresql@18-main"]);
    expect(existsSync(dir)).toBe(true);
  });

  test("an invalid RUNNER_TEMP and a failed stop report both problems", () => {
    const result = runStep(cleanup(), {
      ...invalidTemp,
      STUB_ACTIVE: "active",
      STUB_SUDO_STATUS: "1",
    });
    expect(result.stdout).toBe(
      "FAIL  CLEANUP_RUNNER_TEMP\nFAIL  CLEANUP_STOP_POSTGRESQL\n",
    );
    expect(result.status).toBe(1);
  });

  test("an invalid RUNNER_TEMP with the cluster already stopped calls no sudo", () => {
    const result = runStep(cleanup(), invalidTemp);
    expect(result.stdout).toBe("FAIL  CLEANUP_RUNNER_TEMP\n");
    expect(sudoCalls()).toEqual([]);
  });

  test("a RUNNER_TEMP reached through a symbolic link removes nothing but still stops the cluster", () => {
    const dir = writeCredentials();
    symlinkSync(sandbox.temp, `${sandbox.root}/temp-link`);
    const result = runStep(cleanup(), {
      RUNNER_TEMP: `${sandbox.root}/temp-link`,
      STUB_ACTIVE: "active",
    });
    expect(result.stdout).toBe("FAIL  CLEANUP_RUNNER_TEMP\n");
    expect(existsSync(dir)).toBe(true);
    expect(sudoCalls()).toEqual(["sudo -n systemctl stop postgresql@18-main"]);
  });

  test.each([
    ["not GitHub Actions", { GITHUB_ACTIONS: "false" }],
    ["a self-hosted runner", { RUNNER_ENVIRONMENT: "self-hosted" }],
    ["not Linux", { RUNNER_OS: "macOS" }],
  ])(
    "on %s the service is never touched, but files are still removed",
    (_name, env) => {
      const dir = writeCredentials();
      const result = runStep(cleanup(), { ...env, STUB_ACTIVE: "active" });
      expect(result.stdout).toBe("FAIL  CLEANUP_RUNNER\n");
      expect(result.status).toBe(1);
      expect(sudoCalls()).toEqual([]);
      expect(sandbox.calls().some((c) => c.startsWith("systemctl"))).toBe(
        false,
      );
      expect(existsSync(dir)).toBe(false);
    },
  );

  test("an invalid RUNNER_TEMP on an unexpected runner touches neither files nor the service", () => {
    const dir = writeCredentials();
    const result = runStep(cleanup(), {
      ...invalidTemp,
      RUNNER_ENVIRONMENT: "self-hosted",
      STUB_ACTIVE: "active",
    });
    expect(result.stdout).toBe(
      "FAIL  CLEANUP_RUNNER_TEMP\nFAIL  CLEANUP_RUNNER\n",
    );
    expect(sudoCalls()).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  test("a unit that isn't loaded is not stopped, and cleanup passes", () => {
    const result = runStep(cleanup(), {
      STUB_LOAD: "not-found",
      STUB_ACTIVE: "active",
    });
    expect(result.stdout).toBe("PASS  CLEANUP\n");
    expect(sudoCalls()).toEqual([]);
  });

  test("a stop that leaves the cluster running is reported", () => {
    const result = runStep(cleanup(), {
      STUB_ACTIVE: "active",
      STUB_STAYS_ACTIVE: "1",
    });
    expect(result.stdout).toBe("FAIL  CLEANUP_STOP_POSTGRESQL\n");
    expect(result.status).toBe(1);
  });

  test("a failed file removal doesn't skip the service stop", () => {
    const dir = writeCredentials();
    mkdirSync(`${dir}/locked`);
    writeFileSync(`${dir}/locked/file`, "x");
    chmodSync(`${dir}/locked`, 0o500);
    const result = runStep(cleanup(), { STUB_ACTIVE: "active" });
    expect(result.stdout).toBe("FAIL  CLEANUP_CREDENTIALS\n");
    expect(sudoCalls()).toEqual(["sudo -n systemctl stop postgresql@18-main"]);
  });

  test("stops only postgresql@18-main, by its fixed name", () => {
    const run = cleanup();
    const units = [
      ...run.matchAll(/systemctl \S+ (?:-p \S+ --value )?([A-Za-z0-9@._-]+)/g),
    ].map((m) => m[1]);
    expect(new Set(units)).toEqual(new Set(["postgresql@18-main"]));
    expect(run.match(/\bsudo\b/g)).toHaveLength(1);
  });
});

// Every `run:` script of the PostgreSQL job, as text GitHub would hand to the
// shell. A `${{ ... }}` expression in one is substituted into the script
// before the shell parses it, so a value from the event (a branch name, a PR
// title) could become code.
function runExpressionViolations(text: string): string[] {
  const parsed = asMap(parseYaml(text));
  const integration = asMap(asMap(parsed.jobs)["postgres-integration"]);
  return asList(integration.steps)
    .map(asMap)
    .filter((step) => typeof step.run === "string" && step.run.includes("${{"))
    .map((step) => String(step.name));
}

describe("no GitHub expression in any run script of the job", () => {
  test("every run script is checked, and none contains one", () => {
    const withRun = steps.filter((s) => typeof s.run === "string");
    expect(withRun).toHaveLength(13);
    expect(withRun.map((s) => s.name)).toContain(
      "Runner and PostgreSQL preflight",
    );
    expect(runExpressionViolations(workflowText)).toEqual([]);
  });

  test("expressions stay allowed where GitHub evaluates them, not the shell", () => {
    expect(stepNamed("Clean up credentials and stop PostgreSQL").if).toBe(
      "${{ always() }}",
    );
    expect(workflowText).toContain("${{ always() }}");
  });

  // Each mutation inserts an expression into one run script, in memory only.
  const mutations: Array<[string, string, string]> = [
    [
      "Runner and PostgreSQL preflight",
      "          grep -E '^(ID|VERSION_ID)=' /etc/os-release\n",
      "          grep -E '^(ID|VERSION_ID)=' /etc/os-release\n          printf '%s\\n' \"${{ github.head_ref }}\"\n",
    ],
    [
      "Runner and PostgreSQL preflight",
      "          printf 'ImageOS: %s\\n' \"${ImageOS:-unset}\"\n",
      "          printf 'ImageOS: %s\\n' \"${{ github.event.pull_request.title }}\"\n",
    ],
    [
      "Generate disposable credentials",
      "        run: ./node_modules/.bin/tsx scripts/db/ci-credentials.ts\n",
      "        run: ./node_modules/.bin/tsx scripts/db/ci-credentials.ts ${{ github.ref_name }}\n",
    ],
    [
      "Provision PostgreSQL",
      "        run: bash -p scripts/db/ci-provision-postgres.sh\n",
      "        run: bash -p scripts/db/ci-provision-postgres.sh ${{ inputs.mode }}\n",
    ],
    [
      "Check the test database is fresh",
      '          unset url\n          printf \'%s\\n\' "$report"\n          [ "$status" -eq 0 ] || exit 1\n          states=0\n          matched=0\n          while IFS= read -r line; do\n            case "$line" in\n              "Test database state: "*)\n                states=$((states + 1))\n                if [ "$line" = "Test database state: fresh" ]',
      '          unset url\n          printf \'%s\\n\' "$report"\n          [ "$status" -eq 0 ] || exit 1\n          states=0\n          matched=0\n          while IFS= read -r line; do\n            case "$line" in\n              "Test database state: "*)\n                states=$((states + 1))\n                if [ "$line" = "Test database state: ${{ github.head_ref }}" ]',
    ],
    [
      "Run the PostgreSQL integration tests",
      '--outputFile.json="$RUNNER_TEMP/integration-results.json"\n',
      '--outputFile.json="$RUNNER_TEMP/integration-results.json" ${{ github.event.inputs.flags }}\n',
    ],
    [
      "Check the integration test results",
      'if (total < 65) problems.push("FEWER_THAN_65_TESTS");',
      'if (total < ${{ github.run_number }}) problems.push("FEWER_THAN_65_TESTS");',
    ],
    [
      "Clean up credentials and stop PostgreSQL",
      '          temp="${RUNNER_TEMP:-}"\n',
      '          temp="${{ runner.temp }}"\n',
    ],
  ];

  test.each(mutations)(
    "an expression inserted into %s is rejected for that step",
    (step, from, to) => {
      expect(workflowText).toContain(from);
      const mutated = workflowText.replace(from, to);
      expect(mutated).not.toBe(workflowText);
      expect(runExpressionViolations(mutated)).toEqual([step]);
    },
  );

  test("the mutations cover the preflight and every other kind of run script", () => {
    const covered = new Set(mutations.map(([step]) => step));
    for (const name of [
      "Runner and PostgreSQL preflight",
      "Generate disposable credentials",
      "Provision PostgreSQL",
      "Check the test database is fresh",
      "Run the PostgreSQL integration tests",
      "Check the integration test results",
      "Clean up credentials and stop PostgreSQL",
    ]) {
      expect(covered.has(name), name).toBe(true);
    }
  });

  test("an expression in a step name or condition is not mistaken for one in a script", () => {
    const named = workflowText.replace(
      "      - name: Provision PostgreSQL\n",
      "      - name: Provision PostgreSQL ${{ github.run_id }}\n",
    );
    expect(named).not.toBe(workflowText);
    expect(runExpressionViolations(named)).toEqual([]);
    const conditioned = workflowText.replace(
      "        if: ${{ always() }}\n        timeout-minutes: 3\n",
      "        if: ${{ always() && true }}\n        timeout-minutes: 3\n",
    );
    expect(conditioned).not.toBe(workflowText);
    expect(runExpressionViolations(conditioned)).toEqual([]);
  });
});

describe("the 30-second test timeout is targeted", () => {
  const TARGETED = [
    "scripts/db/lib/ci-credential-files.test.ts",
    "scripts/db/lib/ci-expect-refusals.test.ts",
    "scripts/db/lib/ci-provisioning-files.test.ts",
    "scripts/db/lib/ci-workflow.test.ts",
  ];

  test("only the four process-heavy test files call vi.setConfig, each once at module level", () => {
    const testFiles = ["src", "scripts"]
      .flatMap((root) =>
        (readdirSync(root, { recursive: true }) as string[]).map(
          (f) => `${root}/${f}`,
        ),
      )
      .filter((f) => /\.test\.tsx?$/.test(f));
    // A call as a statement at the start of a line; string literals that
    // only mention it (like the ones in this test) don't count.
    const call = /^\s*vi\.setConfig\(/gm;
    const calling = testFiles.filter((f) =>
      new RegExp(call.source, "m").test(readFileSync(f, "utf8")),
    );
    expect(calling.sort()).toEqual(TARGETED);
    for (const file of TARGETED) {
      const source = readFileSync(file, "utf8");
      expect(source.match(call)).toHaveLength(1);
      expect(source).toMatch(/^vi\.setConfig\(\{ testTimeout: 30_000 \}\);$/m);
      // Neither undone nor widened to hooks.
      expect(source).not.toMatch(/^\s*vi\.resetConfig\(|hookTimeout\s*:/m);
    }
  });

  test("the Vitest configuration still sets a test timeout only for the integration project", () => {
    const config = readFileSync("vitest.config.mts", "utf8");
    expect(config.match(/testTimeout/g)).toHaveLength(1);
    const integration = config.indexOf('name: "integration"');
    expect(integration).toBeGreaterThan(0);
    expect(config.indexOf("testTimeout")).toBeGreaterThan(integration);
    expect(config).toContain("testTimeout: 15_000");
  });
});
