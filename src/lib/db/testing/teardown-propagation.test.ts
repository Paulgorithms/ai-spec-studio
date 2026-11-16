// The integration run relies on Vitest failing the whole process when the
// globalSetup teardown throws (integration-run.ts finish() throws when rows
// persisted or the lock was lost). This checks that behavior of the installed
// Vitest directly: a synthetic project with one passing test and a teardown
// that throws, rejects, or succeeds, run by the real Vitest CLI in a child
// process. No database code, configuration, or credentials are involved: the
// child's environment is only PATH, HOME, NO_COLOR, and NODE_ENV=test, and it
// runs in a temporary directory that is removed afterwards.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const VITEST_CLI = resolve("node_modules/vitest/vitest.mjs");

const TEARDOWNS = {
  succeeds: "return () => undefined;",
  throws: 'return () => { throw new Error("SYNTHETIC_TEARDOWN_FAILURE"); };',
  rejects:
    'return async () => { await Promise.resolve(); throw new Error("SYNTHETIC_TEARDOWN_FAILURE"); };',
} as const;

function runSyntheticProject(teardown: keyof typeof TEARDOWNS) {
  const dir = mkdtempSync(join(tmpdir(), "vitest-teardown-probe-"));
  try {
    writeFileSync(
      join(dir, "synthetic.test.js"),
      'test("synthetic test passes", () => { expect(1 + 1).toBe(2); });\n',
    );
    writeFileSync(
      join(dir, "global-setup.js"),
      `export default function setup() { ${TEARDOWNS[teardown]} }\n`,
    );
    writeFileSync(
      join(dir, "probe.config.mjs"),
      'export default { test: { globals: true, include: ["synthetic.test.js"], globalSetup: ["./global-setup.js"] } };\n',
    );
    const result = spawnSync(
      process.execPath,
      [
        VITEST_CLI,
        "run",
        "--root",
        dir,
        "--config",
        join(dir, "probe.config.mjs"),
      ],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NO_COLOR: "1",
          NODE_ENV: "test",
        },
      },
    );
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
      dir,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Vitest globalSetup teardown failures", () => {
  test.each(["throws", "rejects"] as const)(
    "a teardown that %s fails the run (exit 1) although every test passed",
    (teardown) => {
      const { status, output, dir } = runSyntheticProject(teardown);
      expect(status).toBe(1);
      // The synthetic test itself passed: the failure comes from teardown.
      expect(output).toMatch(/Tests\s+1 passed \(1\)/);
      expect(output).not.toMatch(/\bfailed\b/);
      expect(output).toContain("error during close");
      expect(output).toContain("SYNTHETIC_TEARDOWN_FAILURE");
      expect(existsSync(dir)).toBe(false);
    },
    60_000,
  );

  test("a teardown that succeeds leaves the run passing (exit 0)", () => {
    const { status, output, dir } = runSyntheticProject("succeeds");
    expect(status).toBe(0);
    expect(output).toMatch(/Tests\s+1 passed \(1\)/);
    expect(output).not.toContain("SYNTHETIC_TEARDOWN_FAILURE");
    expect(existsSync(dir)).toBe(false);
  }, 60_000);
});
