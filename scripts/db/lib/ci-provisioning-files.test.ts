// Static checks of the CI PostgreSQL provisioning files: the configuration
// (Phase 3A), the create-only SQL (Phase 3B), and the provisioning script
// (Phase 3C). They read the committed
// files only: nothing here connects to PostgreSQL or touches a local
// server's configuration.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  SCRAM_MAX_ITERATIONS,
  SCRAM_MIN_ITERATIONS,
  scramSha256Verifier,
} from "./ci-credentials";
import { LOCAL_PORT } from "./migration-checks";
import { TEST_DATABASE_TARGET, TEST_PROFILE } from "./test-database-target";

// These tests start real processes (bash, tsx, stubs) many times over. In
// the full suite, with every file running in parallel, they take several
// times longer than alone, close to Vitest's 5-second default, so this file
// gets 30 seconds per test. vi.setConfig applies to this file only: Vitest
// resets it after each file.
vi.setConfig({ testTimeout: 30_000 });

const HBA_PATH = "scripts/db/ci/pg_hba.conf";
const CONF_PATH = "scripts/db/ci/postgresql-ci.conf";
const SQL_PATH = "scripts/db/ci-setup.sql";
const LOCAL_SQL_PATH = "scripts/db/local-setup.sql";
const SCRIPT_PATH = "scripts/db/ci-provision-postgres.sh";

const read = (path: string) => readFileSync(path, "utf8");

// ---------------------------------------------------------------------------
// pg_hba.conf

type HbaRule = {
  type: string;
  database: string;
  user: string;
  address: string | undefined;
  method: string;
  options: string[];
};

// Records as PostgreSQL reads them: "#" starts a comment, fields are
// separated by whitespace, and "local" records have no address field.
function parseHba(text: string): HbaRule[] {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line !== "")
    .map((line) => {
      const fields = line.split(/\s+/);
      const [type = "", database = "", user = ""] = fields;
      const rest = fields.slice(3);
      const address = type === "local" ? undefined : rest.shift();
      const [method = "", ...options] = rest;
      return { type, database, user, address, method, options };
    });
}

// The approved rule set, in order. ci-setup.sql (Phase 3B) checks the same
// rules through pg_hba_file_rules on the running server.
const EXPECTED_RULES: HbaRule[] = [
  {
    type: "local",
    database: "all",
    user: "postgres",
    address: undefined,
    method: "peer",
    options: [],
  },
  {
    type: "hostnossl",
    database: "ai_spec_studio_test",
    user: "ai_spec_studio_test",
    address: "127.0.0.1/32",
    method: "scram-sha-256",
    options: [],
  },
  ...(
    [
      ["local", "all", undefined],
      ["local", "replication", undefined],
      ["host", "all", "0.0.0.0/0"],
      ["host", "replication", "0.0.0.0/0"],
      ["host", "all", "::/0"],
      ["host", "replication", "::/0"],
    ] as const
  ).map(([type, database, address]) => ({
    type,
    database,
    user: "all",
    address,
    method: "reject",
    options: [],
  })),
];

type Connection = {
  socket: "unix" | "tcp";
  ssl?: boolean;
  address?: string;
  database: string;
  user: string;
  // A physical replication connection (it requests no database).
  replication?: boolean;
};

function ipv4ToNumber(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map(Number);
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return undefined;
  }
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function addressMatches(cidr: string, address: string): boolean {
  const [network = "", bitsText = ""] = cidr.split("/");
  const bits = Number(bitsText);
  if (network.includes(":") || address.includes(":")) {
    // Only ::/0 (every IPv6 address) appears in the file.
    return network === "::" && bits === 0 && address.includes(":");
  }
  const net = ipv4ToNumber(network);
  const addr = ipv4ToNumber(address);
  if (net === undefined || addr === undefined) return false;
  if (bits === 0) return true;
  const size = 2 ** (32 - bits);
  return Math.floor(net / size) === Math.floor(addr / size);
}

// PostgreSQL's matching rule: the first record whose type, database, user,
// and address match decides; no record means the connection is refused.
function decide(rules: readonly HbaRule[], c: Connection): string {
  for (const rule of rules) {
    const typeMatches =
      rule.type === "local"
        ? c.socket === "unix"
        : c.socket === "tcp" &&
          (rule.type === "host" ||
            (rule.type === "hostnossl" && !c.ssl) ||
            (rule.type === "hostssl" && c.ssl === true));
    if (!typeMatches) continue;
    const databaseMatches = c.replication
      ? rule.database === "replication"
      : rule.database === "all" || rule.database === c.database;
    if (!databaseMatches) continue;
    if (rule.user !== "all" && rule.user !== c.user) continue;
    if (
      rule.type !== "local" &&
      !(rule.address && c.address && addressMatches(rule.address, c.address))
    ) {
      continue;
    }
    return rule.method;
  }
  return "no match (refused)";
}

describe("pg_hba.conf", () => {
  const text = read(HBA_PATH);
  const rules = parseHba(text);

  test("has exactly the approved rules, in order", () => {
    expect(rules).toEqual(EXPECTED_RULES);
  });

  test("allows only peer and SCRAM-SHA-256, and rejects everything else", () => {
    const methods = new Set(rules.map((rule) => rule.method));
    expect([...methods].sort()).toEqual(["peer", "reject", "scram-sha-256"]);
    for (const weak of [
      "trust",
      "password",
      "md5",
      "ident",
      "cert",
      "gss",
      "sspi",
      "pam",
      "ldap",
      "radius",
      "oauth",
    ]) {
      expect(rules.some((rule) => rule.method === weak)).toBe(false);
    }
  });

  test("every broad rule rejects: no catch-all can allow a connection", () => {
    for (const rule of rules) {
      const broad =
        rule.user === "all" ||
        rule.address === "0.0.0.0/0" ||
        rule.address === "::/0" ||
        rule.database === "replication";
      if (broad) expect(rule.method).toBe("reject");
    }
  });

  test("the two allowing rules come before every reject", () => {
    const firstReject = rules.findIndex((rule) => rule.method === "reject");
    const lastAllow = rules.findLastIndex((rule) => rule.method !== "reject");
    expect(lastAllow).toBe(1);
    expect(firstReject).toBe(2);
    expect(rules.slice(firstReject).every((r) => r.method === "reject")).toBe(
      true,
    );
  });

  test("the only TCP rule that allows anything is IPv4 loopback, without TLS", () => {
    const tcpAllows = rules.filter(
      (rule) => rule.type !== "local" && rule.method !== "reject",
    );
    expect(tcpAllows).toEqual([
      expect.objectContaining({
        type: "hostnossl",
        address: "127.0.0.1/32",
        database: "ai_spec_studio_test",
        user: "ai_spec_studio_test",
      }),
    ]);
  });

  test("IPv6 is rejected explicitly and never allowed", () => {
    expect(
      rules.filter((rule) => rule.address?.includes(":")).map((r) => r.method),
    ).toEqual(["reject", "reject"]);
    expect(
      rules.some(
        (rule) =>
          rule.address === "::/0" &&
          rule.database === "all" &&
          rule.method === "reject",
      ),
    ).toBe(true);
  });

  test("uses no keyword addresses, host names, regular expressions, file references, includes, or options", () => {
    for (const rule of rules) {
      expect(rule.options).toEqual([]);
      for (const field of [rule.database, rule.user, rule.address ?? ""]) {
        expect(field).not.toMatch(/^[/@+]/);
        expect(field).not.toContain(",");
        expect(field).not.toContain('"');
      }
      expect(["samehost", "samenet", "all"]).not.toContain(rule.address);
      if (rule.address) {
        expect(rule.address).toMatch(/^(?:\d{1,3}(?:\.\d{1,3}){3}|::)\/\d+$/);
      }
      expect(["sameuser", "samerole", "samegroup"]).not.toContain(
        rule.database,
      );
    }
    expect(text).not.toMatch(/^\s*include(?:_if_exists|_dir)?\b/m);
    expect(new Set(rules.map((r) => r.type))).toEqual(
      new Set(["local", "hostnossl", "host"]),
    );
  });

  describe("decides each connection as approved (first match wins)", () => {
    const test_ = (overrides: Partial<Connection>): Connection => ({
      socket: "tcp",
      ssl: false,
      address: "127.0.0.1",
      database: "ai_spec_studio_test",
      user: "ai_spec_studio_test",
      ...overrides,
    });

    test.each([
      ["the test role, IPv4 loopback, no TLS", test_({}), "scram-sha-256"],
      ["the test role with TLS", test_({ ssl: true }), "reject"],
      ["the test role from ::1", test_({ address: "::1" }), "reject"],
      [
        "the test role from 127.0.0.2",
        test_({ address: "127.0.0.2" }),
        "reject",
      ],
      [
        "the test role from another host",
        test_({ address: "10.1.0.4" }),
        "reject",
      ],
      ["the test role to postgres", test_({ database: "postgres" }), "reject"],
      [
        "the test role to template1",
        test_({ database: "template1" }),
        "reject",
      ],
      ["the test role over the socket", test_({ socket: "unix" }), "reject"],
      ["the app role", test_({ user: "ai_spec_studio_app" }), "reject"],
      [
        "the migrator role",
        test_({ user: "ai_spec_studio_migrator" }),
        "reject",
      ],
      ["postgres over TCP", test_({ user: "postgres" }), "reject"],
      [
        "postgres over TCP to postgres",
        test_({ user: "postgres", database: "postgres" }),
        "reject",
      ],
      ["an unknown role", test_({ user: "intruder" }), "reject"],
      [
        "postgres over the socket",
        test_({ socket: "unix", user: "postgres", database: "postgres" }),
        "peer",
      ],
      [
        "postgres over the socket to the test database",
        test_({ socket: "unix", user: "postgres" }),
        "peer",
      ],
      [
        "another role over the socket",
        test_({ socket: "unix", user: "ai_spec_studio_app" }),
        "reject",
      ],
      [
        "physical replication as postgres over the socket",
        test_({ socket: "unix", user: "postgres", replication: true }),
        "reject",
      ],
      [
        "physical replication as the test role over IPv4",
        test_({ replication: true }),
        "reject",
      ],
      [
        "physical replication over IPv6",
        test_({ address: "::1", replication: true }),
        "reject",
      ],
    ])("%s: %s", (_name, connection, expected) => {
      expect(decide(rules, connection)).toBe(expected);
    });

    test("without the explicit rejects, the same refusals would rely on no match", () => {
      // Documents why the rejects are there: they make each refusal explicit
      // instead of depending on the absence of a later permissive record.
      const allowOnly = rules.slice(0, 2);
      expect(decide(allowOnly, test_({ address: "::1" }))).toBe(
        "no match (refused)",
      );
      expect(decide(rules, test_({ address: "::1" }))).toBe("reject");
    });
  });
});

// ---------------------------------------------------------------------------
// postgresql-ci.conf

const EXPECTED_SETTINGS: Record<string, string> = {
  listen_addresses: "'127.0.0.1'",
  ssl: "off",
  password_encryption: "'scram-sha-256'",
  log_min_error_statement: "panic",
  log_statement: "none",
};

function settingLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line !== "");
}

describe("postgresql-ci.conf", () => {
  const text = read(CONF_PATH);
  const lines = settingLines(text);

  test("has exactly the approved settings and nothing else", () => {
    const parsed = lines.map((line) => {
      const match = /^([a-z_]+)\s*=\s*(\S+)$/.exec(line);
      expect(match, `unexpected line: ${line}`).not.toBeNull();
      return [match?.[1] ?? "", match?.[2] ?? ""] as const;
    });
    expect(Object.fromEntries(parsed)).toEqual(EXPECTED_SETTINGS);
    expect(parsed).toHaveLength(Object.keys(EXPECTED_SETTINGS).length);
  });

  test("sets each parameter once (PostgreSQL would silently keep the last)", () => {
    const names = lines.map((line) => line.split(/\s*=/)[0]?.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  test("listens on IPv4 loopback only", () => {
    const value = EXPECTED_SETTINGS.listen_addresses;
    expect(text).toContain(`listen_addresses = ${value}`);
    for (const wider of ["*", "0.0.0.0", "::", "localhost", ","]) {
      expect(value).not.toContain(wider);
    }
  });

  test("includes no other files and overrides no paths, ports, or authentication settings", () => {
    expect(text).not.toMatch(/^\s*include(?:_if_exists|_dir)?\b/m);
    for (const name of [
      "port",
      "hba_file",
      "ident_file",
      "data_directory",
      "config_file",
      "unix_socket_directories",
      "unix_socket_permissions",
      "shared_preload_libraries",
      "ssl_cert_file",
      "ssl_key_file",
      "log_statement_sample_rate",
      "log_min_duration_statement",
    ]) {
      expect(lines.some((line) => line.startsWith(`${name} `))).toBe(false);
    }
    // No paths at all: nothing here can point the server at another file.
    expect(lines.join("\n")).not.toContain("/");
  });

  test("uses values PostgreSQL 18 accepts", () => {
    expect([
      "debug5",
      "debug4",
      "debug3",
      "debug2",
      "debug1",
      "info",
      "notice",
      "warning",
      "error",
      "log",
      "fatal",
      "panic",
    ]).toContain(EXPECTED_SETTINGS.log_min_error_statement);
    expect(["none", "ddl", "mod", "all"]).toContain(
      EXPECTED_SETTINGS.log_statement,
    );
    expect(["'scram-sha-256'", "'md5'"]).toContain(
      EXPECTED_SETTINGS.password_encryption,
    );
  });
});

// ---------------------------------------------------------------------------
// Both files

describe("the CI configuration files", () => {
  test.each([HBA_PATH, CONF_PATH])(
    "%s holds no credentials, secrets, or environment-specific values",
    (path) => {
      const text = read(path);
      expect(text).not.toMatch(/SCRAM-SHA-256\$/);
      expect(text).not.toMatch(/\bmd5[0-9a-f]{32}\b/);
      expect(text).not.toMatch(/[0-9a-f]{32,}/i);
      expect(text).not.toMatch(/postgres(?:ql)?:\/\//);
      expect(text).not.toMatch(/PGPASSWORD|POSTGRES_PASSWORD|\bsecret\b/i);
      expect(text).not.toMatch(/^\s*\w*password\s*=(?!.*scram-sha-256)/im);
      // No developer machine paths or user names.
      expect(text).not.toMatch(/\/Users\/|\/home\/|Application Support/);
    },
  );

  test.each([HBA_PATH, CONF_PATH])(
    "%s is plain ASCII with Unix line endings and a final newline",
    (path) => {
      const text = read(path);
      expect(text).toMatch(/^[\x20-\x7e\n]*$/);
      expect(text.endsWith("\n")).toBe(true);
      expect(text).not.toMatch(/[ \t]+$/m);
    },
  );

  test.each([HBA_PATH, CONF_PATH])(
    "%s says it's for the disposable CI cluster only",
    (path) => {
      expect(read(path)).toContain("GitHub-hosted Ubuntu 26.04 runner ONLY");
    },
  );
});

// ---------------------------------------------------------------------------
// ci-setup.sql (Phase 3B)

type SqlUnit =
  | { kind: "meta"; text: string }
  | { kind: "sql"; text: string; terminator: ";" | "\\gset" | "\\gexec" };

// Splits a psql script the way psql reads it: a backslash at the start of a
// line begins a meta-command (to the end of the line); everything else is
// SQL up to a ";" outside quotes, or up to a \gset line. "--" comments are
// dropped; single-quoted strings, quoted identifiers, and dollar-quoted
// bodies are kept whole, so a ";" or "--" inside them never splits.
function splitPsql(script: string): SqlUnit[] {
  const units: SqlUnit[] = [];
  let buffer = "";
  let i = 0;
  let lineStart = true;
  const flush = (terminator: ";" | "\\gset" | "\\gexec") => {
    const text = buffer.replace(/\s+/g, " ").trim();
    if (text === "") throw new Error(`empty statement before ${terminator}`);
    units.push({ kind: "sql", text, terminator });
    buffer = "";
  };
  while (i < script.length) {
    const ch = script[i] ?? "";
    if (lineStart && ch === "\\") {
      const end = script.indexOf("\n", i);
      const line = script.slice(i, end === -1 ? undefined : end).trim();
      i = end === -1 ? script.length : end + 1;
      if (line === "\\gset" || line === "\\gexec") {
        flush(line);
      } else {
        if (buffer.trim() !== "") {
          throw new Error(`meta-command inside a statement: ${line}`);
        }
        units.push({ kind: "meta", text: line.replace(/\s+/g, " ") });
      }
      continue;
    }
    if (ch === "\n") {
      buffer += ch;
      i += 1;
      lineStart = true;
      continue;
    }
    if (lineStart && (ch === " " || ch === "\t")) {
      buffer += ch;
      i += 1;
      continue;
    }
    lineStart = false;
    if (ch === "-" && script[i + 1] === "-") {
      const end = script.indexOf("\n", i);
      i = end === -1 ? script.length : end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= script.length) throw new Error("unterminated quote");
        if (script[j] === ch) {
          if (script[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      buffer += script.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const close = script.indexOf(tag, i + tag.length);
      if (close === -1) throw new Error(`unterminated ${tag}`);
      buffer += stripLineComments(script.slice(i, close + tag.length));
      i = close + tag.length;
      continue;
    }
    if (ch === ";") {
      flush(";");
      i += 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  if (buffer.trim() !== "") throw new Error("unterminated final statement");
  return units;
}

// "--" comments removed from a dollar-quoted body, outside its quotes.
function stripLineComments(body: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === "-" && body[i + 1] === "-") {
      const end = body.indexOf("\n", i);
      i = (end === -1 ? body.length : end) - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

// A short, stable description of each unit: meta-commands in full, SQL by
// its leading words (and a DO block by its tag).
function head(unit: SqlUnit): string {
  if (unit.kind === "meta") return unit.text;
  const doBlock = /^DO (\$[A-Za-z_]*\$)/.exec(unit.text);
  if (doBlock) return `DO ${doBlock[1]}`;
  return unit.text.split(" ").slice(0, 4).join(" ");
}

// String literals (and dollar-quoted bodies) blanked out, for keyword scans
// that must ignore privilege names and messages inside quotes.
function withoutStrings(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, "''");
}

function doBody(units: readonly SqlUnit[], tag: string): string {
  const unit = units.find(
    (u) => u.kind === "sql" && u.text.startsWith(`DO $${tag}$`),
  );
  if (!unit) throw new Error(`no DO $${tag}$ block`);
  return unit.text;
}

// The CI_SETUP_* codes a block appends to `failures`, in order. Each is
// appended as a text element with array_append. `failures || 'CODE'` would
// not be: PostgreSQL takes the untyped literal for an array too, so the
// first failing check raises "malformed array literal" instead of its code
// (seen on the runner in the second live CI run; PostgreSQL 18 docs,
// Arrays, Modifying Arrays).
function failureCodes(body: string): string[] {
  return [
    ...body.matchAll(
      /failures := array_append\(failures, '(CI_SETUP_[A-Z_]+)'::text\);/g,
    ),
  ].map((m) => m[1] ?? "");
}

// Every assignment to `failures` in a block, as written.
function failureAssignments(body: string): string[] {
  return [...body.matchAll(/failures :=[^;]*;/g)].map((m) => m[0]);
}

// What makes a failure-code append ambiguous: any || at all (ci-setup.sql
// has no other use for it), or an assignment to `failures` not in the one
// approved form.
function ambiguousAppends(text: string): string[] {
  const found = [...text.matchAll(/[^\n]*\|\|[^\n]*/g)].map((m) => m[0]);
  for (const assignment of failureAssignments(text)) {
    if (
      !/^failures := array_append\(failures, 'CI_SETUP_[A-Z_]+'::text\);$/.test(
        assignment,
      )
    ) {
      found.push(assignment);
    }
  }
  return found;
}

const sql = read(SQL_PATH);
const units = splitPsql(sql);
const local = splitPsql(read(LOCAL_SQL_PATH));

const MUTATION =
  /^(CREATE|GRANT|REVOKE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|COMMENT|SECURITY|REASSIGN|COPY|VACUUM|CLUSTER|REINDEX|SET|RESET|LOCK)\b/;

const PREFLIGHT_CODES = [
  "CI_SETUP_NOT_POSTGRES",
  "CI_SETUP_NOT_BOOTSTRAP_SUPERUSER",
  "CI_SETUP_NOT_SUPERUSER",
  "CI_SETUP_NOT_UNIX_SOCKET",
  "CI_SETUP_SERVER_VERSION",
  "CI_SETUP_IN_RECOVERY",
  "CI_SETUP_DATA_DIRECTORY",
  "CI_SETUP_CONFIG_FILE",
  "CI_SETUP_HBA_FILE",
  "CI_SETUP_CLUSTER_NAME",
  "CI_SETUP_PORT",
  "CI_SETUP_SETTINGS",
  "CI_SETUP_SETTINGS_SOURCE",
  "CI_SETUP_CONFIG_ERRORS",
  "CI_SETUP_PRELOAD_LIBRARIES",
  "CI_SETUP_HBA_ERRORS",
  "CI_SETUP_HBA_RULES",
  "CI_SETUP_HBA_OPTIONS",
  "CI_SETUP_ROLES_NOT_FRESH",
  "CI_SETUP_PROJECT_OBJECTS_EXIST",
  "CI_SETUP_DATABASES_NOT_FRESH",
  "CI_SETUP_SETTINGS_NOT_FRESH",
  "CI_SETUP_TABLESPACES_NOT_FRESH",
  "CI_SETUP_EXTENSIONS_NOT_FRESH",
  "CI_SETUP_OTHER_SESSIONS",
  "CI_SETUP_ADMIN_HAS_PASSWORD",
];

const TEST_DATABASE_CODES = [
  "CI_SETUP_TESTDB_SESSION",
  "CI_SETUP_TESTDB_SCHEMAS",
  "CI_SETUP_TESTDB_SCHEMA_OWNER",
  "CI_SETUP_TESTDB_NOT_EMPTY",
  "CI_SETUP_TESTDB_EXTENSIONS",
];

const FINAL_CODES = [
  "CI_SETUP_FINAL_TEST_ROLE",
  "CI_SETUP_FINAL_TEST_ROLE_SCRAM",
  "CI_SETUP_FINAL_NOLOGIN_ROLES",
  "CI_SETUP_FINAL_ROLES",
  "CI_SETUP_FINAL_MEMBERSHIPS",
  "CI_SETUP_FINAL_DATABASES",
  "CI_SETUP_FINAL_OWNER",
  "CI_SETUP_FINAL_LABEL",
  "CI_SETUP_FINAL_PUBLIC_PRIVILEGES",
  "CI_SETUP_FINAL_APP_MIGRATOR_PRIVILEGES",
  "CI_SETUP_FINAL_TEST_PRIVILEGES",
  "CI_SETUP_FINAL_ADMIN_PASSWORD",
];

const ROLE_ATTRIBUTES =
  "NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";

// The whole script, in order: inputs, preflight, the database, the role
// transaction, the test-database transaction, then the checks.
const EXPECTED_SEQUENCE = [
  "\\set ON_ERROR_STOP on",
  "\\set ON_ERROR_ROLLBACK off",
  "\\set AUTOCOMMIT on",
  "\\set ECHO none",
  "\\set ECHO_HIDDEN off",
  "\\set QUIET on",
  "\\set VERBOSITY default",
  "\\set SHOW_CONTEXT errors",
  "SELECT coalesce(:VERSION_NUM BETWEEN 180000",
  "\\if :ci_psql_ok",
  "\\else",
  "DO $psql_version$",
  "\\endif",
  "\\if :{?test_verifier}",
  "\\else",
  "DO $verifier_missing$",
  "\\endif",
  "\\set VERBOSITY sqlstate",
  "\\set SHOW_CONTEXT never",
  "SELECT coalesce( :'test_verifier' ~",
  "\\set VERBOSITY default",
  "\\set SHOW_CONTEXT errors",
  "\\if :ci_verifier_ok",
  "\\else",
  "DO $verifier_invalid$",
  "\\endif",
  "DO $preflight$",
  "CREATE DATABASE ai_spec_studio_test TEMPLATE",
  "BEGIN",
  "\\set VERBOSITY sqlstate",
  "\\set SHOW_CONTEXT never",
  "CREATE ROLE ai_spec_studio_test LOGIN",
  "\\set VERBOSITY default",
  "\\set SHOW_CONTEXT errors",
  "CREATE ROLE ai_spec_studio_app NOLOGIN",
  "CREATE ROLE ai_spec_studio_migrator NOLOGIN",
  "REVOKE ALL ON DATABASE",
  "GRANT CONNECT, CREATE ON",
  "ALTER DATABASE ai_spec_studio_test SET",
  "COMMIT",
  "\\connect ai_spec_studio_test",
  "BEGIN",
  "REVOKE ALL ON SCHEMA",
  "GRANT USAGE, CREATE ON",
  ...Array.from({ length: 9 }, () => "ALTER DEFAULT PRIVILEGES FOR"),
  "COMMIT",
  "DO $check_test$",
  "DO $check_ci_test_database$",
  "\\connect postgres",
  "DO $check_ci_server$",
  "\\set VERBOSITY sqlstate",
  "\\set SHOW_CONTEXT never",
  "SELECT coalesce((SELECT rolpassword FROM",
  "\\set VERBOSITY default",
  "\\set SHOW_CONTEXT errors",
  "\\if :ci_verifier_stored",
  "\\else",
  "DO $verifier_not_stored$",
  "\\endif",
  "\\echo 'PASS ci-setup.sql: ai_spec_studio_test provisioned and verified'",
];

describe("ci-setup.sql: structure", () => {
  test("splits cleanly into meta-commands and statements", () => {
    expect(units.length).toBeGreaterThan(40);
  });

  test("runs exactly the approved sequence", () => {
    expect(units.map(head)).toEqual(EXPECTED_SEQUENCE);
  });

  test("uses only the approved psql meta-commands", () => {
    const metas = units.filter((u) => u.kind === "meta").map((u) => u.text);
    for (const meta of metas) {
      expect(meta).toMatch(/^\\(set|if|else|endif|connect|echo) ?/);
    }
    const sets = metas.filter((m) => m.startsWith("\\set "));
    expect(new Set(sets)).toEqual(
      new Set([
        "\\set ON_ERROR_STOP on",
        "\\set ON_ERROR_ROLLBACK off",
        "\\set AUTOCOMMIT on",
        "\\set ECHO none",
        "\\set ECHO_HIDDEN off",
        "\\set QUIET on",
        "\\set VERBOSITY default",
        "\\set VERBOSITY sqlstate",
        "\\set SHOW_CONTEXT errors",
        "\\set SHOW_CONTEXT never",
      ]),
    );
    // The script never sets the verifier itself, and runs nothing outside
    // the server: no shell, files, output redirection, or environment.
    expect(sql).not.toMatch(/^\s*\\set\s+test_verifier\b/m);
    expect(sql).not.toMatch(
      /^\s*\\(!|o\b|out\b|w\b|write\b|copy\b|i\b|ir\b|include|setenv|getenv|g\s|gexec|cd\b|lo_|password)/m,
    );
  });

  test("every \\if has an \\else and an \\endif, never nested", () => {
    let depth = 0;
    for (const unit of units) {
      if (unit.kind !== "meta") continue;
      if (unit.text.startsWith("\\if ")) {
        expect(depth).toBe(0);
        depth = 1;
      } else if (unit.text === "\\endif") {
        expect(depth).toBe(1);
        depth = 0;
      }
    }
    expect(depth).toBe(0);
  });

  test("each \\else branch only raises a fixed CI_SETUP_* error", () => {
    units.forEach((unit, index) => {
      if (unit.kind === "meta" && unit.text === "\\else") {
        const branch = units[index + 1];
        expect(branch?.kind).toBe("sql");
        expect(branch?.text).toMatch(
          /^DO \$[a-z_]+\$ BEGIN RAISE EXCEPTION 'CI_SETUP_[A-Z_]+: [^'%]+'; END \$[a-z_]+\$$/,
        );
        expect(units[index + 2]).toEqual({ kind: "meta", text: "\\endif" });
      }
    });
  });

  test("every top-level SELECT stores its result (\\gset) instead of printing it", () => {
    const selects = units.filter(
      (u) => u.kind === "sql" && u.text.startsWith("SELECT"),
    );
    expect(selects).toHaveLength(3);
    for (const select of selects) {
      expect(select.kind === "sql" && select.terminator).toBe("\\gset");
      // NULL would unset the variable and break the \if, so coalesce.
      expect(select.text).toMatch(/^SELECT coalesce\(/);
    }
  });
});

describe("ci-setup.sql: transactions", () => {
  test("CREATE DATABASE runs alone, outside any transaction", () => {
    let depth = 0;
    let checked = false;
    for (const unit of units) {
      if (unit.kind !== "sql") continue;
      if (unit.text === "BEGIN") depth += 1;
      if (unit.text === "COMMIT") depth -= 1;
      expect(depth === 0 || depth === 1).toBe(true);
      if (unit.text.startsWith("CREATE DATABASE")) {
        expect(depth).toBe(0);
        checked = true;
      }
    }
    expect(depth).toBe(0);
    expect(checked).toBe(true);
  });

  test("every other change runs inside one of the two transactions", () => {
    let depth = 0;
    let transaction = 0;
    const changesByTransaction: Record<number, string[]> = {};
    for (const unit of units) {
      if (unit.kind === "meta") {
        if (unit.text.startsWith("\\connect")) expect(depth).toBe(0);
        continue;
      }
      if (unit.text === "BEGIN") {
        depth = 1;
        transaction += 1;
        continue;
      }
      if (unit.text === "COMMIT") {
        depth = 0;
        continue;
      }
      if (
        MUTATION.test(unit.text) &&
        !unit.text.startsWith("CREATE DATABASE")
      ) {
        expect(depth, unit.text).toBe(1);
        (changesByTransaction[transaction] ??= []).push(head(unit));
      }
    }
    expect(transaction).toBe(2);
    expect(changesByTransaction[1]).toEqual([
      "CREATE ROLE ai_spec_studio_test LOGIN",
      "CREATE ROLE ai_spec_studio_app NOLOGIN",
      "CREATE ROLE ai_spec_studio_migrator NOLOGIN",
      "REVOKE ALL ON DATABASE",
      "GRANT CONNECT, CREATE ON",
      "ALTER DATABASE ai_spec_studio_test SET",
    ]);
    expect(changesByTransaction[2]?.[0]).toBe("REVOKE ALL ON SCHEMA");
    expect(changesByTransaction[2]).toHaveLength(11);
  });

  test("the second transaction runs in the test database, the final checks in postgres", () => {
    const connects = units
      .map((u, index) => ({ u, index }))
      .filter(({ u }) => u.kind === "meta" && u.text.startsWith("\\connect"));
    expect(connects.map(({ u }) => u.text)).toEqual([
      "\\connect ai_spec_studio_test",
      "\\connect postgres",
    ]);
    const secondBegin = units.findIndex(
      (u, index) =>
        index > (connects[0]?.index ?? 0) &&
        u.kind === "sql" &&
        u.text === "BEGIN",
    );
    expect(secondBegin).toBe((connects[0]?.index ?? 0) + 1);
  });

  test("uses no savepoints, rollbacks, or transaction-control tricks", () => {
    for (const unit of units) {
      if (unit.kind !== "sql") continue;
      expect(unit.text).not.toMatch(
        /^(ROLLBACK|SAVEPOINT|RELEASE|END|ABORT|START TRANSACTION|PREPARE|SET TRANSACTION)\b/,
      );
    }
  });

  test("ON_ERROR_STOP is on, autocommit is on, and errors never roll back silently", () => {
    expect(units[0]).toEqual({ kind: "meta", text: "\\set ON_ERROR_STOP on" });
    expect(units[1]).toEqual({
      kind: "meta",
      text: "\\set ON_ERROR_ROLLBACK off",
    });
    expect(units[2]).toEqual({ kind: "meta", text: "\\set AUTOCOMMIT on" });
  });
});

describe("ci-setup.sql: preflight before any change", () => {
  const preflightIndex = units.findIndex(
    (u) => u.kind === "sql" && u.text.startsWith("DO $preflight$"),
  );
  const firstChange = units.findIndex(
    (u) => u.kind === "sql" && MUTATION.test(u.text),
  );

  test("nothing changes until the psql checks and the whole preflight have run", () => {
    expect(preflightIndex).toBeGreaterThan(0);
    expect(firstChange).toBe(preflightIndex + 1);
    for (const unit of units.slice(0, preflightIndex)) {
      if (unit.kind === "sql") {
        expect(unit.text).toMatch(/^(SELECT|DO \$[a-z_]+\$ BEGIN RAISE)/);
      }
    }
  });

  test("checks exactly the approved preconditions, in order", () => {
    expect(failureCodes(doBody(units, "preflight"))).toEqual(PREFLIGHT_CODES);
  });

  test("every preflight check is an IF that records exactly one code", () => {
    const body = doBody(units, "preflight");
    const ifs = body.match(/\bIF\b(?! NOT TRUE)(?!\s+cardinality)/g) ?? [];
    // One IF per code, plus the final "IF cardinality(...)".
    expect(body.match(/ END IF;/g)?.length).toBe(PREFLIGHT_CODES.length + 1);
    expect(ifs.length).toBeGreaterThanOrEqual(PREFLIGHT_CODES.length);
    expect(body).toMatch(
      /IF cardinality\(failures\) > 0 THEN RAISE EXCEPTION 'CI_SETUP_PREFLIGHT_FAILED: %', array_to_string\(failures, ', '\); END IF;/,
    );
  });

  test("the preflight and every check block are read only", () => {
    for (const tag of [
      "preflight",
      "check_test",
      "check_ci_test_database",
      "check_ci_server",
    ]) {
      const body = withoutStrings(doBody(units, tag));
      expect(body).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT|REVOKE|DROP|TRUNCATE|EXECUTE|PERFORM|COPY|set_config|pg_reload_conf|pg_terminate_backend|pg_cancel_backend|lo_\w+|dblink)\b/i,
      );
    }
  });

  test("checks the approved paths, cluster, port, and version", () => {
    const body = doBody(units, "preflight");
    for (const expected of [
      "current_setting('data_directory') = '/var/lib/postgresql/18/main'",
      "current_setting('config_file') = '/etc/postgresql/18/main/postgresql.conf'",
      "current_setting('hba_file') = '/etc/postgresql/18/main/pg_hba.conf'",
      "current_setting('cluster_name') = '18/main'",
      `current_setting('port') = '${LOCAL_PORT}'`,
      "current_setting('server_version_num')::int BETWEEN 180000 AND 189999",
      "((SELECT oid FROM pg_roles WHERE rolname = current_user) = 10)",
      "inet_server_addr() IS NULL AND inet_client_addr() IS NULL",
      "IF pg_is_in_recovery() THEN",
      "SELECT rolpassword IS NULL FROM pg_authid WHERE oid = 10",
      "backend_type = 'client backend' AND pid <> pg_backend_pid()",
      "ci_conf constant text := '/etc/postgresql/18/main/conf.d/90-ai-spec-studio-ci.conf'",
    ]) {
      expect(body).toContain(expected);
    }
  });

  test("requires a fresh cluster: built-in roles, databases, and tablespaces only", () => {
    const body = doBody(units, "preflight");
    expect(body).toContain(
      "WHERE oid <> 10 AND (oid >= 16384 OR rolname NOT LIKE 'pg\\_%')",
    );
    expect(body).toContain(
      "= ARRAY['postgres', 'template0', 'template1']::text[]",
    );
    expect(body).toContain("= ARRAY['pg_default', 'pg_global']::text[]");
    expect(body).toContain("= ARRAY['plpgsql']::text[]");
    expect(body).toContain("IF EXISTS (SELECT 1 FROM pg_db_role_setting) THEN");
  });
});

describe("ci-setup.sql: compatibility with the Phase 3A configuration", () => {
  const body = doBody(units, "preflight");

  test("expects exactly the eight pg_hba.conf rules, in order", () => {
    const rules = parseHba(read(HBA_PATH));
    const mask = (cidr: string) => {
      const [address = "", bits = ""] = cidr.split("/");
      if (address === "::") return { address, netmask: "::" };
      const n = Number(bits);
      const octets = [0, 1, 2, 3].map((i) =>
        Math.max(0, Math.min(8, n - i * 8)),
      );
      return {
        address,
        netmask: octets.map((b) => 256 - 2 ** (8 - b)).join("."),
      };
    };
    const expected = rules.map((rule) => {
      const { address, netmask } = rule.address
        ? mask(rule.address)
        : { address: "-", netmask: "-" };
      return `'${rule.type}|{${rule.database}}|{${rule.user}}|${address}|${netmask}|${rule.method}'`;
    });
    const found =
      /ORDER BY rule_number\) FROM pg_hba_file_rules\) = ARRAY\[ (.*?) \]::text\[\]/.exec(
        body,
      );
    expect(found?.[1]?.split(", ")).toEqual(expected);
    expect(expected).toHaveLength(8);
  });

  test("expects exactly the five postgresql-ci.conf settings, from that file", () => {
    const pairs = Object.fromEntries(
      [...body.matchAll(/current_setting\('([a-z_]+)'\) = '([^']*)'/g)]
        .map((m) => [m[1] ?? "", m[2] ?? ""])
        .filter(([name]) => name in EXPECTED_SETTINGS),
    );
    const unquoted = Object.fromEntries(
      Object.entries(EXPECTED_SETTINGS).map(([k, v]) => [
        k,
        v.replace(/^'|'$/g, ""),
      ]),
    );
    expect(pairs).toEqual(unquoted);
    const sourceNames =
      /WHERE name IN \(([^)]*)\) AND source = 'configuration file' AND sourcefile = ci_conf AND NOT pending_restart\) = 5\)/.exec(
        body,
      );
    expect(
      sourceNames?.[1]
        ?.split(", ")
        .map((n) => n.replace(/'/g, ""))
        .sort(),
    ).toEqual(Object.keys(EXPECTED_SETTINGS).sort());
  });
});

describe("ci-setup.sql: what it creates", () => {
  const statements = units.filter(
    (u): u is Extract<SqlUnit, { kind: "sql" }> => u.kind === "sql",
  );

  test("creates exactly one database and three roles, and nothing else", () => {
    const creates = statements
      .map((u) => u.text)
      .filter((t) => t.startsWith("CREATE "));
    expect(creates).toEqual([
      "CREATE DATABASE ai_spec_studio_test TEMPLATE template0 ENCODING 'UTF8'",
      `CREATE ROLE ai_spec_studio_test LOGIN ${ROLE_ATTRIBUTES} CONNECTION LIMIT 10 PASSWORD :'test_verifier'`,
      `CREATE ROLE ai_spec_studio_app NOLOGIN ${ROLE_ATTRIBUTES}`,
      `CREATE ROLE ai_spec_studio_migrator NOLOGIN ${ROLE_ATTRIBUTES}`,
    ]);
  });

  test("names match the existing validators' target", () => {
    expect(TEST_DATABASE_TARGET.user).toBe("ai_spec_studio_test");
    expect(TEST_DATABASE_TARGET.database).toBe("ai_spec_studio_test");
    expect(TEST_DATABASE_TARGET.port).toBe(5432);
    expect(
      statements.some(
        (u) =>
          u.text ===
          `ALTER DATABASE ${TEST_PROFILE.database} SET app.environment = '${TEST_PROFILE.environmentLabel}'`,
      ),
    ).toBe(true);
  });

  test("never creates or mentions ai_spec_studio_dev outside comments", () => {
    expect(units.map((u) => u.text).join("\n")).not.toContain(
      "ai_spec_studio_dev",
    );
  });

  test("uses no destructive, takeover, or repair statement", () => {
    // DO blocks are checked separately (read only); these are the statements.
    for (const unit of statements.filter((u) => !u.text.startsWith("DO "))) {
      expect(unit.text).not.toMatch(
        /^(DROP|TRUNCATE|DELETE|UPDATE|INSERT|REASSIGN|COPY|VACUUM|ALTER SYSTEM|ALTER ROLE|ALTER USER|ALTER GROUP|ALTER SCHEMA|ALTER TABLE|SET ROLE|SET SESSION|RESET|SECURITY LABEL|COMMENT)\b/,
      );
      expect(unit.text).not.toMatch(
        /\b(IF NOT EXISTS|IF EXISTS|OR REPLACE|OWNER TO|RENAME TO|WITH ADMIN|IN ROLE|IN GROUP|ROLE ai_spec_studio_\w+ ADMIN)\b/,
      );
    }
    const alterDatabase = statements.filter((u) =>
      u.text.startsWith("ALTER DATABASE"),
    );
    expect(alterDatabase.map((u) => u.text)).toEqual([
      "ALTER DATABASE ai_spec_studio_test SET app.environment = 'test'",
    ]);
  });

  test("grants nothing to the app role, the migrator, or PUBLIC", () => {
    const grants = statements.filter((u) => u.text.startsWith("GRANT"));
    expect(grants.map((u) => u.text)).toEqual([
      "GRANT CONNECT, CREATE ON DATABASE ai_spec_studio_test TO ai_spec_studio_test",
      "GRANT USAGE, CREATE ON SCHEMA public TO ai_spec_studio_test",
    ]);
  });
});

describe("ci-setup.sql: consistency with local-setup.sql", () => {
  const segment = (list: readonly SqlUnit[]) => {
    const start = list.findIndex(
      (u) => u.kind === "meta" && u.text === "\\connect ai_spec_studio_test",
    );
    const end = list.findIndex(
      (u) => u.kind === "sql" && u.text.startsWith("DO $check_test$"),
    );
    if (start === -1 || end === -1) throw new Error("section 7 not found");
    return list.slice(start, end + 1);
  };

  test("the test-database section (local-setup.sql section 7) is identical", () => {
    expect(segment(units)).toEqual(segment(local));
  });

  test("the test-database privileges and label match local-setup.sql section 5", () => {
    const localTexts = new Set(local.map((u) => u.text));
    for (const text of [
      "REVOKE ALL ON DATABASE ai_spec_studio_test FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app, ai_spec_studio_test",
      "GRANT CONNECT, CREATE ON DATABASE ai_spec_studio_test TO ai_spec_studio_test",
      "ALTER DATABASE ai_spec_studio_test SET app.environment = 'test'",
    ]) {
      expect(units.some((u) => u.text === text)).toBe(true);
      expect(localTexts.has(text)).toBe(true);
    }
  });

  test("the test role has local-setup.sql's attributes and connection limit", () => {
    const localRoles = local.find(
      (u) => u.kind === "sql" && u.text.startsWith("DO $roles$"),
    );
    expect(localRoles?.text).toContain("('ai_spec_studio_test', 10)");
    expect(localRoles?.text).toContain(
      "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT",
    );
    for (const attribute of ROLE_ATTRIBUTES.split(" ")) {
      expect(
        units.some(
          (u) =>
            u.text.startsWith("CREATE ROLE ai_spec_studio_test LOGIN") &&
            u.text.split(" ").includes(attribute),
        ),
      ).toBe(true);
    }
  });
});

describe("ci-setup.sql: the SCRAM verifier", () => {
  const texts = units.map((u) => u.text);
  const uses = texts.filter((t) => t.includes("test_verifier"));

  test("is used only through psql's literal quoting, in exactly three places", () => {
    expect(uses).toEqual([
      "\\if :{?test_verifier}",
      expect.stringMatching(/^SELECT coalesce\( :'test_verifier' ~ /),
      expect.stringMatching(/PASSWORD :'test_verifier'$/),
      expect.stringMatching(
        /= :'test_verifier', false\) AS ci_verifier_stored$/,
      ),
    ]);
    const all = texts.join("\n");
    expect(all.match(/:'test_verifier'/g)).toHaveLength(4);
    expect(all).not.toMatch(/:test_verifier\b|:"test_verifier"/);
  });

  test("is checked for presence, then format, before the preflight and any use", () => {
    const presence = texts.indexOf("\\if :{?test_verifier}");
    const format = texts.findIndex((t) => t.includes(":'test_verifier' ~"));
    const preflight = texts.findIndex((t) => t.startsWith("DO $preflight$"));
    const create = texts.findIndex((t) =>
      t.includes("PASSWORD :'test_verifier'"),
    );
    expect(presence).toBeGreaterThan(-1);
    expect(presence).toBeLessThan(format);
    expect(format).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(create);
  });

  test("every statement carrying it reports only the SQLSTATE of an error", () => {
    const carriers = texts
      .map((t, index) => ({ t, index }))
      .filter(({ t }) => t.includes(":'test_verifier'"));
    expect(carriers).toHaveLength(3);
    for (const { index } of carriers) {
      expect(texts.slice(index - 2, index)).toEqual([
        "\\set VERBOSITY sqlstate",
        "\\set SHOW_CONTEXT never",
      ]);
      expect(texts.slice(index + 1, index + 3)).toEqual([
        "\\set VERBOSITY default",
        "\\set SHOW_CONTEXT errors",
      ]);
    }
    // And verbosity is never lowered anywhere else.
    expect(texts.filter((t) => t === "\\set VERBOSITY sqlstate")).toHaveLength(
      3,
    );
  });

  const formatCheck = texts.find((t) => t.includes(":'test_verifier' ~")) ?? "";
  const pattern = /:'test_verifier' ~ '([^']+)'/.exec(formatCheck)?.[1] ?? "";
  const shape = new RegExp(pattern);

  test("the format check is exactly the strict pattern", () => {
    expect(pattern).toBe(
      "^SCRAM-SHA-256\\$[1-9][0-9]{3,5}:[A-Za-z0-9+/]{22}==\\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$",
    );
  });

  test("the format check matches what ci-credentials.ts produces", () => {
    expect(pattern.startsWith("^SCRAM-SHA-256\\$")).toBe(true);
    for (const iterations of [
      SCRAM_MIN_ITERATIONS,
      8192,
      SCRAM_MAX_ITERATIONS,
    ]) {
      expect(
        shape.test(
          scramSha256Verifier("0123456789abcdef".repeat(4), { iterations }),
        ),
      ).toBe(true);
    }
    expect(formatCheck).toContain(
      `::numeric BETWEEN ${SCRAM_MIN_ITERATIONS} AND ${SCRAM_MAX_ITERATIONS}`,
    );
  });

  test.each([
    ["an MD5 hash", `md5${"0".repeat(32)}`],
    ["a plain password", "0123456789abcdef".repeat(4)],
    [
      "SCRAM-SHA-1",
      "SCRAM-SHA-1$4096:AQIDBAUGBwgJCgsMDQ4PEA==$" +
        "A".repeat(43) +
        "=:" +
        "A".repeat(43) +
        "=",
    ],
    [
      "a short salt",
      "SCRAM-SHA-256$4096:AQIDBAUGBwgJCgsM==$" +
        "A".repeat(43) +
        "=:" +
        "A".repeat(43) +
        "=",
    ],
    [
      "a quote",
      "SCRAM-SHA-256$4096:AQIDBAUGBwgJCgsMDQ4PEA==$" +
        "A".repeat(42) +
        "'=:" +
        "A".repeat(43) +
        "=",
    ],
    [
      "a newline",
      "SCRAM-SHA-256$4096:AQIDBAUGBwgJCgsMDQ4PEA==$" +
        "A".repeat(43) +
        "=:" +
        "A".repeat(43) +
        "=\n\\! id",
    ],
    [
      "a space",
      "SCRAM-SHA-256$4096:AQIDBAUGBwgJCgsMDQ4PEA==$" +
        "A".repeat(43) +
        "=: " +
        "A".repeat(42) +
        "=",
    ],
    [
      "a space in the salt",
      "SCRAM-SHA-256$4096:AQIDBAUGBwgJ CgsMDQ4PEA==$" +
        "A".repeat(43) +
        "=:" +
        "A".repeat(43) +
        "=",
    ],
    [
      "a space in StoredKey",
      "SCRAM-SHA-256$4096:AQIDBAUGBwgJCgsMDQ4PEA==$" +
        "A".repeat(42) +
        " =:" +
        "A".repeat(43) +
        "=",
    ],
    [
      "a backslash",
      "SCRAM-SHA-256$4096:AQIDBAUGBwgJCgsMDQ4PEA==$" +
        "A".repeat(42) +
        "\\=:" +
        "A".repeat(43) +
        "=",
    ],
    [
      "leading zeros",
      "SCRAM-SHA-256$04096:AQIDBAUGBwgJCgsMDQ4PEA==$" +
        "A".repeat(43) +
        "=:" +
        "A".repeat(43) +
        "=",
    ],
  ])("the format check rejects %s", (_name, value) => {
    expect(shape.test(value)).toBe(false);
  });

  test("is never echoed, raised, or printed", () => {
    for (const unit of units) {
      if (unit.kind === "meta" && unit.text.startsWith("\\echo")) {
        // One single-quoted, fixed string: no psql variable can be
        // interpolated into it.
        expect(unit.text).toMatch(/^\\echo '[^']*'$/);
        expect(unit.text).not.toMatch(/:[A-Za-z_{'"]/);
      }
      if (unit.kind === "sql" && /RAISE/.test(unit.text)) {
        for (const raise of unit.text.match(/RAISE [A-Z]+ [^;]*;/g) ?? []) {
          expect(raise).not.toMatch(
            /test_verifier|rolpassword|setconfig|current_setting|:'/,
          );
        }
      }
    }
    // The stored secret is only ever compared (IS NULL, LIKE, or equal to
    // the provided verifier on the server), never selected for display.
    const mentions = units
      .flatMap((u) => u.text.match(/rolpassword[^,;]*/g) ?? [])
      .map((m) => m.trim());
    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) {
      expect(mention).toMatch(
        /^rolpassword (IS NULL|LIKE 'SCRAM-SHA-256\$%'|FROM pg_authid WHERE rolname = 'ai_spec_studio_test'\) = :'test_verifier')/,
      );
    }
    expect(
      units
        .filter((u) => u.kind === "sql" && u.text.includes("rolpassword"))
        .map(head),
    ).toEqual([
      "DO $preflight$",
      "DO $check_ci_server$",
      "SELECT coalesce((SELECT rolpassword FROM",
    ]);
  });
});

describe("ci-setup.sql: failure codes are appended as text elements", () => {
  const BLOCKS: Array<[string, string[]]> = [
    ["preflight", PREFLIGHT_CODES],
    ["check_ci_test_database", TEST_DATABASE_CODES],
    ["check_ci_server", FINAL_CODES],
  ];

  test("every assignment to failures is array_append(failures, '<code>'::text)", () => {
    for (const [tag, codes] of BLOCKS) {
      const body = doBody(units, tag);
      expect(failureAssignments(body)).toEqual(
        codes.map(
          (code) => `failures := array_append(failures, '${code}'::text);`,
        ),
      );
    }
    expect(failureAssignments(sql)).toHaveLength(43);
  });

  test("no ambiguous text-array concatenation remains", () => {
    expect(ambiguousAppends(sql)).toEqual([]);
    expect(sql).not.toContain("||");
  });

  test.each([
    [
      "the old || form",
      "failures := array_append(failures, 'CI_SETUP_PORT'::text);",
      "failures := failures || 'CI_SETUP_PORT';",
    ],
    [
      "an uncast literal",
      "failures := array_append(failures, 'CI_SETUP_PORT'::text);",
      "failures := array_append(failures, 'CI_SETUP_PORT');",
    ],
    [
      "array_cat",
      "failures := array_append(failures, 'CI_SETUP_PORT'::text);",
      "failures := array_cat(failures, '{CI_SETUP_PORT}');",
    ],
    [
      "|| elsewhere",
      "array_to_string(failures, ', ')",
      "array_to_string(failures || '{}', ', ')",
    ],
  ])("the check catches %s", (_name, from, to) => {
    expect(sql).toContain(from);
    expect(ambiguousAppends(sql.replace(from, to))).not.toEqual([]);
  });

  test("each block starts from an empty text[] and raises once, after every check", () => {
    for (const [tag, codes] of BLOCKS) {
      const body = doBody(units, tag);
      expect(body).toContain("failures text[] := ARRAY[]::text[];");
      expect(body.match(/\bRAISE\b/g)).toHaveLength(1);
      expect(body).not.toMatch(/\b(RETURN|EXIT|CONTINUE)\b/);
      // The single RAISE comes after the last code is recorded.
      const last = codes.at(-1) ?? "";
      expect(body.indexOf("RAISE")).toBeGreaterThan(body.lastIndexOf(last));
      expect(body).toMatch(
        /IF cardinality\(failures\) > 0 THEN RAISE EXCEPTION 'CI_SETUP_[A-Z_]+_FAILED: %', array_to_string\(failures, ', '\); END IF;/,
      );
    }
  });

  test("the preflight, which records the four freshness codes a repeated setup hits, runs before any change", () => {
    const codes = failureCodes(doBody(units, "preflight"));
    for (const code of [
      "CI_SETUP_ROLES_NOT_FRESH",
      "CI_SETUP_PROJECT_OBJECTS_EXIST",
      "CI_SETUP_DATABASES_NOT_FRESH",
      "CI_SETUP_SETTINGS_NOT_FRESH",
    ]) {
      expect(codes).toContain(code);
    }
    const preflightIndex = units.findIndex(
      (u) => u.kind === "sql" && u.text.startsWith("DO $preflight$"),
    );
    const firstChange = units.findIndex(
      (u) => u.kind === "sql" && MUTATION.test(u.text),
    );
    expect(firstChange).toBe(preflightIndex + 1);
  });
});

describe("ci-setup.sql: final verification", () => {
  test("checks the test database as the migration runner expects it", () => {
    expect(failureCodes(doBody(units, "check_ci_test_database"))).toEqual(
      TEST_DATABASE_CODES,
    );
  });

  test("checks the roles, database, label, and privileges on the server", () => {
    const body = doBody(units, "check_ci_server");
    expect(failureCodes(body)).toEqual(FINAL_CODES);
    for (const expected of [
      "rolcanlogin AND NOT rolinherit AND NOT rolsuper",
      "rolconnlimit = 10 AND rolvaliduntil IS NULL",
      "NOT rolcanlogin AND NOT rolinherit",
      "rolpassword IS NULL) = 2",
      "= ARRAY['ai_spec_studio_app', 'ai_spec_studio_migrator', 'ai_spec_studio_test']::text[]",
      "pg_auth_members WHERE roleid >= 16384 OR member >= 16384",
      "= ARRAY['ai_spec_studio_test', 'postgres', 'template0', 'template1']::text[]",
      "(SELECT datdba FROM pg_database WHERE oid = test_db) = 10",
      "setdatabase = test_db AND setrole = 0 AND setconfig = ARRAY['app.environment=test']::text[]",
      "has_database_privilege('ai_spec_studio_test', 'ai_spec_studio_test', 'CREATE')",
      "NOT has_database_privilege('ai_spec_studio_test', 'ai_spec_studio_test', 'TEMPORARY')",
    ]) {
      expect(body).toContain(expected);
    }
  });

  test("ends with the stored-verifier check and one fixed PASS line", () => {
    expect(units.at(-1)).toEqual({
      kind: "meta",
      text: "\\echo 'PASS ci-setup.sql: ai_spec_studio_test provisioned and verified'",
    });
    expect(sql.match(/\\echo/g)).toHaveLength(1);
  });

  test("every failure message is a fixed CI_SETUP_* code (or local-setup.sql's own check text)", () => {
    for (const unit of units) {
      if (unit.kind !== "sql") continue;
      for (const raise of unit.text.match(/RAISE EXCEPTION [^;]*;/g) ?? []) {
        expect(raise).toMatch(
          /^RAISE EXCEPTION (?:'CI_SETUP_[A-Z_]+: [^']*'(?:, array_to_string\(failures, ', '\))?|E'ai_spec_studio_test isn''t in the expected state:\\n %', concat_ws\(E'\\n ', schema_failures, default_failures\));$/,
        );
      }
    }
  });
});

describe("ci-setup.sql: the file", () => {
  test("is plain ASCII with Unix line endings, a final newline, and no trailing spaces", () => {
    expect(sql).toMatch(/^[\x20-\x7e\n]*$/);
    expect(sql.endsWith("\n")).toBe(true);
    expect(sql).not.toMatch(/[ \t]+$/m);
  });

  test("says it's for the disposable CI cluster only, and how it must be run", () => {
    const prose = sql.replace(/\n--\s*/g, " ");
    expect(prose).toContain("GitHub-hosted Ubuntu 26.04 runner ONLY");
    expect(prose).toContain(
      "Never run psql with -a, -e, -1, or --single-transaction",
    );
  });

  test("holds no credentials", () => {
    expect(sql).not.toMatch(/SCRAM-SHA-256\$\d/);
    expect(sql).not.toMatch(/[0-9a-f]{32,}/i);
    expect(sql).not.toMatch(/postgres(?:ql)?:\/\//);
    expect(sql).not.toMatch(/PGPASSWORD|POSTGRES_PASSWORD/);
  });
});

// ---------------------------------------------------------------------------
// ci-provision-postgres.sh (Phase 3C)

// The script's code: comment lines dropped (the shebang kept), trailing
// whitespace trimmed. Inline comments aren't used in the script.
function codeLines(script: string): string[] {
  return script
    .split("\n")
    .filter((line, index) => index === 0 || !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line !== "");
}

// Top-level function bodies (definitions start at column 0: "name() {").
function functionBodies(script: string): Record<string, string[]> {
  const bodies: Record<string, string[]> = {};
  let current: string | undefined;
  for (const line of codeLines(script)) {
    const start = /^([a-z_]+)\(\) \{$/.exec(line);
    if (start) {
      current = start[1];
      bodies[current ?? ""] = [];
      continue;
    }
    if (line === "}") {
      current = undefined;
      continue;
    }
    if (current) bodies[current]?.push(line.trim());
  }
  return bodies;
}

const MAIN_ORDER = [
  'check_shell "$@"',
  "check_runner",
  "check_environment",
  "check_repository_files",
  "check_credentials",
  "check_cluster",
  "install_configuration",
  "start_server",
  "provision",
  "remove_verifier",
  'pass "CI_PROVISION_COMPLETE (${SERVER_VERSION%% (Ubuntu*})"',
];

// The only functions that may change anything, in the order main runs them.
const CHANGING_FUNCTIONS = [
  "install_configuration",
  "start_server",
  "provision",
  "remove_verifier",
];

const PRELUDE = [
  "#!/bin/bash -p",
  "set +x",
  'case "$-" in',
  "  *p*) ;;",
  "  *)",
  "    builtin printf '%s\\n' 'FAIL  CI_PROVISION_NOT_PRIVILEGED_MODE'",
  "    exit 1",
  "    ;;",
  "esac",
  "set -euo pipefail",
  "set -o errtrace",
  "umask 077",
  "IFS=$' \\t\\n'",
  "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
  "export PATH",
  "export LC_ALL=C",
  "hash -r",
  'if [ -n "$(declare -F)" ]; then',
];

const RUNNER_GATES = [
  'USER_ID="$(id -u)"',
  '[ "$USER_ID" != "0" ] || fail CI_PROVISION_RUNNING_AS_ROOT',
  '[ "${GITHUB_ACTIONS:-}" = "true" ] || fail CI_PROVISION_NOT_GITHUB_ACTIONS',
  '[ "${CI:-}" = "true" ] || fail CI_PROVISION_NOT_CI',
  '[ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ] || fail CI_PROVISION_NOT_GITHUB_HOSTED',
  '[ "${RUNNER_OS:-}" = "Linux" ] || fail CI_PROVISION_NOT_LINUX_RUNNER',
  '[ "$(uname -s)" = "Linux" ] || fail CI_PROVISION_NOT_LINUX',
  '[ "${ImageOS:-}" = "ubuntu26" ] || fail CI_PROVISION_IMAGE_OS',
  "grep -qx 'ID=ubuntu' /etc/os-release || fail CI_PROVISION_OS_RELEASE",
  "grep -qx 'VERSION_ID=\"26.04\"' /etc/os-release || fail CI_PROVISION_OS_RELEASE",
  "sudo -n true || fail CI_PROVISION_SUDO",
  "pass CI_PROVISION_RUNNER",
];

const ENVIRONMENT_GATES = [
  "PG*|POSTGRES_*|postgres_*|DATABASE_*|TEST_DATABASE_URL) fail CI_PROVISION_DATABASE_VARIABLE_SET ;;",
  "BASH_ENV|ENV|SHELLOPTS|BASHOPTS|BASH_XTRACEFD) fail CI_PROVISION_SHELL_VARIABLE_SET ;;",
];

// Every code check_cluster can fail with, in order.
const CLUSTER_CODES = [
  "CI_PROVISION_NO_PG_LSCLUSTERS",
  "CI_PROVISION_CLUSTER_LIST",
  "CI_PROVISION_CLUSTER_COUNT",
  "CI_PROVISION_CLUSTER_STATE",
  "CI_PROVISION_SERVICE_ACTIVE",
  "CI_PROVISION_SERVICE_ACTIVE",
  "CI_PROVISION_SERVICE_ENABLED",
  "CI_PROVISION_SERVER_RUNNING",
  "CI_PROVISION_PORT_IN_USE",
  "CI_PROVISION_DATA_DIRECTORY",
  "CI_PROVISION_DATA_DIRECTORY",
  "CI_PROVISION_PG_VERSION",
  "CI_PROVISION_PG_VERSION",
  "CI_PROVISION_POSTMASTER_PID",
  "CI_PROVISION_CONFIG_DIRECTORY",
  "CI_PROVISION_CONFIG_DIRECTORY",
  "CI_PROVISION_CONFIG_DIRECTORY",
  "CI_PROVISION_CONFIG_FILE",
  "CI_PROVISION_CONFIG_FILE",
  "CI_PROVISION_CONFIG_INCLUDE",
  "CI_PROVISION_CONF_D_NOT_EMPTY",
  "CI_PROVISION_HBA_FILE",
  "CI_PROVISION_HBA_FILE",
  "CI_PROVISION_SERVER_BINARY",
  "CI_PROVISION_SERVER_BINARY",
  "CI_PROVISION_PSQL_BINARY",
  "CI_PROVISION_PSQL_BINARY",
  "CI_PROVISION_PG_ISREADY",
];

const CREDENTIAL_CODES = [
  "CI_PROVISION_CREDENTIAL_DIRECTORY",
  "CI_PROVISION_CREDENTIAL_DIRECTORY",
  "CI_PROVISION_CREDENTIAL_DIRECTORY",
  "CI_PROVISION_CREDENTIAL_CONTENTS",
  "CI_PROVISION_CREDENTIAL_CONTENTS",
  "CI_PROVISION_CREDENTIAL_FILE",
  "CI_PROVISION_CREDENTIAL_FILE",
  "CI_PROVISION_CREDENTIAL_FILE",
  "CI_PROVISION_VERIFIER_UNREADABLE",
  "CI_PROVISION_VERIFIER_FORMAT",
  "CI_PROVISION_VERIFIER_FORMAT",
  "CI_PROVISION_VERIFIER_FORMAT",
  "CI_PROVISION_VERIFIER_CHANGED",
];

const CONSTANTS: Record<string, string> = {
  CREDENTIAL_DIR_NAME: '"ai-spec-studio-db"',
  URL_NAME: '"test-database-url"',
  VERIFIER_NAME: '"test-role-verifier"',
  SERVICE: '"postgresql@18-main"',
  PORT: '"5432"',
  DATA_DIR: '"/var/lib/postgresql/18/main"',
  CONF_DIR: '"/etc/postgresql/18/main"',
  CONF_FILE: '"/etc/postgresql/18/main/postgresql.conf"',
  HBA_FILE: '"/etc/postgresql/18/main/pg_hba.conf"',
  CONF_D: '"/etc/postgresql/18/main/conf.d"',
  CI_CONF_NAME: '"90-ai-spec-studio-ci.conf"',
  PG_BIN: '"/usr/lib/postgresql/18/bin"',
  SCRAM_PATTERN:
    "'^SCRAM-SHA-256\\$[1-9][0-9]{3,5}:[A-Za-z0-9+/]{22}==\\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$'",
  SERVER_VERSION_PATTERN: "'^postgres \\(PostgreSQL\\) 18\\.[0-9]+( |$)'",
  PSQL_VERSION_PATTERN: "'^psql \\(PostgreSQL\\) 18\\.[0-9]+( |$)'",
};

const PSQL_PIPELINE = [
  "(",
  "cd / && {",
  "builtin printf '%s\\n' '\\set ECHO none'",
  "builtin printf '%s\\n' \"\\\\set test_verifier '${VERIFIER}'\"",
  'cat -- "$SQL_FILE"',
  '} | sudo -n -u postgres -- "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -d postgres -f -',
  ") || status=$?",
];

// Every line that may mention the verifier's value (not its file).
const VERIFIER_LINES = [
  'VERIFIER=""',
  'VERIFIER="$(dd if="$VERIFIER_FILE" iflag=nofollow status=none)" || fail CI_PROVISION_VERIFIER_UNREADABLE',
  '[ "${#VERIFIER}" -eq "$size" ] || fail CI_PROVISION_VERIFIER_FORMAT',
  '[[ "$VERIFIER" =~ $SCRAM_PATTERN ]] || fail CI_PROVISION_VERIFIER_FORMAT',
  'local rest="${VERIFIER#SCRAM-SHA-256\\$}"',
  "builtin printf '%s\\n' \"\\\\set test_verifier '${VERIFIER}'\"",
  "unset VERIFIER",
];

// The only forms sudo may take: read-only checks as postgres, the two
// installs, the comparisons, starting the one service, and running psql.
const SUDO_FORMS = [
  /^sudo -n true \|\| fail CI_PROVISION_SUDO$/,
  /^\[ "\$\(sudo -n -u postgres (realpath -e|stat -c '[^']+'|cat) -- "\$DATA_DIR(\/PG_VERSION)?"\)" = /,
  /^if sudo -n -u postgres test -e "\$DATA_DIR\/postmaster\.pid" \|\| sudo -n -u postgres test -L "\$DATA_DIR\/postmaster\.pid"; then$/,
  /^sudo -n install -T -o postgres -g postgres -m 0640 -- "\$(HBA_SOURCE|CONF_SOURCE)" "\$(HBA_FILE|CONF_D\/\$CI_CONF_NAME)" \|\| fail CI_PROVISION_INSTALL_(HBA|CONF)$/,
  /^sudo -n cmp -s -- "\$(HBA_SOURCE|CONF_SOURCE)" "\$(HBA_FILE|CONF_D\/\$CI_CONF_NAME)" \|\| fail CI_PROVISION_INSTALLED_(HBA|CONF)$/,
  /^sudo -n systemctl start "\$SERVICE" \|\| fail CI_PROVISION_START$/,
  /^\} \| sudo -n -u postgres -- "\$PG_BIN\/psql" -X -q -v ON_ERROR_STOP=1 -d postgres -f -$/,
];

function failCodes(lines: readonly string[]): string[] {
  return lines.flatMap((line) =>
    [...line.matchAll(/\bfail (CI_PROVISION_[A-Z_]+)/g)].map((m) => m[1] ?? ""),
  );
}

// Every property the provisioning script must have, as violation codes. The
// real script must have none; each mutation test below must produce one.
function scriptViolations(script: string): string[] {
  const violations = new Set<string>();
  const lines = codeLines(script);
  const code = lines.join("\n");
  const bodies = functionBodies(script);
  const flag = (name: string, ok: boolean) => {
    if (!ok) violations.add(name);
  };

  // Shell safety.
  flag(
    "PRELUDE",
    JSON.stringify(lines.slice(0, PRELUDE.length)) === JSON.stringify(PRELUDE),
  );
  flag(
    "XTRACE",
    !/\bset\s+-[a-wyz]*x|\bset\s+-o\s+xtrace|\bbash\s+-[a-z]*x|BASH_XTRACEFD=|\bset\s+-o\s+verbose|\bset\s+-[a-z]*v\b/.test(
      code,
    ) && lines.filter((l) => l === "set +x").length === 1,
  );
  flag(
    "ERR_TRAP",
    lines.some((l) =>
      l.startsWith(
        "trap 'builtin printf \"FAIL  CI_PROVISION_UNEXPECTED_ERROR",
      ),
    ),
  );
  flag(
    "MAIN_ORDER",
    JSON.stringify(bodies.main) === JSON.stringify(MAIN_ORDER),
  );
  flag(
    "MAIN_CALL",
    lines.at(-1) === 'main "$@"' &&
      lines.filter((l) => l.startsWith("main ")).length === 1,
  );
  flag(
    "CONSTANTS",
    Object.entries(CONSTANTS).every(([name, value]) =>
      lines.includes(`readonly ${name}=${value}`),
    ),
  );

  // Gates.
  flag(
    "RUNNER_GATES",
    JSON.stringify(bodies.check_runner) === JSON.stringify(RUNNER_GATES),
  );
  flag(
    "ENVIRONMENT_GATES",
    ENVIRONMENT_GATES.every((gate) =>
      bodies.check_environment?.includes(gate),
    ) &&
      bodies.check_environment?.[0] === "local name" &&
      bodies.check_environment?.[1] === "for name in $(compgen -e); do",
  );
  flag(
    "SHELL_GATES",
    JSON.stringify(failCodes(bodies.check_shell ?? [])) ===
      JSON.stringify(["CI_PROVISION_XTRACE", "CI_PROVISION_USAGE"]),
  );
  flag(
    "CREDENTIAL_GATES",
    JSON.stringify(failCodes(bodies.check_credentials ?? [])) ===
      JSON.stringify(CREDENTIAL_CODES),
  );
  flag(
    "CLUSTER_GATES",
    JSON.stringify(failCodes(bodies.check_cluster ?? [])) ===
      JSON.stringify(CLUSTER_CODES),
  );

  // Nothing changes in a check, and only the changing functions change
  // anything.
  const changing =
    /\bsudo -n (install|systemctl start)\b|\/psql" -X|\brm\b|>\s*"?\$|\btee\b|\bmkdir\b|\btouch\b/;
  for (const [name, body] of Object.entries(bodies)) {
    if (!CHANGING_FUNCTIONS.includes(name)) {
      flag("CHANGE_OUTSIDE_STAGE", !body.some((line) => changing.test(line)));
    }
  }
  const outside = lines.filter((line) => changing.test(line));
  flag(
    "CHANGE_OUTSIDE_STAGE",
    outside.every((line) =>
      CHANGING_FUNCTIONS.some((name) => bodies[name]?.includes(line.trim())),
    ),
  );

  // sudo: non-interactive, and only the approved forms.
  for (const line of lines
    .map((l) => l.trim())
    .filter((l) => /\bsudo\b/.test(l))) {
    flag(
      "SUDO_FORM",
      SUDO_FORMS.some((form) => form.test(line)),
    );
  }
  flag(
    "SUDO_ENVIRONMENT",
    !/--preserve-env|\bsudo\b[^|]*\s-E\b|\bsudo\b.*\benv\b/.test(code),
  );

  // No destructive, recursive, broad-permission, or download operations.
  flag(
    "DESTRUCTIVE",
    // Case-sensitive (so "read -r" isn't "-R"); "rm --" ends options only.
    !/\brm\s+-(?!-\s)|\bchmod\b|\bchown\b|\s-R\b|\bfind\b|\bmv\b|\bln\b|\bshred\b|\btruncate\b|\bdropdb\b|\bdropuser\b|\bpg_dropcluster\b|\bpg_createcluster\b|\bpg_ctlcluster\b|\binitdb\b|\bsystemctl\s+(stop|restart|reload|enable|disable|mask|kill)\b|\bkill\b|\bpkill\b/.test(
      code,
    ) && !/\bDROP\s+(DATABASE|ROLE|USER|SCHEMA|TABLE|OWNED)\b/i.test(code),
  );
  flag(
    "DOWNLOAD",
    !/\b(curl|wget|apt|apt-get|dpkg|snap|docker|pip|npm|npx)\b/.test(code),
  );
  flag(
    "REMOVE",
    lines
      .filter((l) => /\brm\b/.test(l))
      .map((l) => l.trim())
      .join("\n") ===
      'rm -- "$VERIFIER_FILE" || fail CI_PROVISION_VERIFIER_DELETE',
  );

  // Configuration destinations and permissions.
  flag(
    "INSTALL",
    JSON.stringify(bodies.install_configuration?.slice(0, 2)) ===
      JSON.stringify([
        'sudo -n install -T -o postgres -g postgres -m 0640 -- "$HBA_SOURCE" "$HBA_FILE" || fail CI_PROVISION_INSTALL_HBA',
        'sudo -n install -T -o postgres -g postgres -m 0640 -- "$CONF_SOURCE" "$CONF_D/$CI_CONF_NAME" || fail CI_PROVISION_INSTALL_CONF',
      ]) && lines.filter((l) => /\binstall\b -/.test(l)).length === 2,
  );
  flag(
    "INSTALL_VERIFIED",
    [
      '[ "$(stat -c \'%U %G %a %h %F\' -- "$HBA_FILE")" = "postgres postgres 640 1 regular file" ] || fail CI_PROVISION_INSTALLED_HBA',
      '[ "$(stat -c \'%U %G %a %h %F\' -- "$CONF_D/$CI_CONF_NAME")" = "postgres postgres 640 1 regular file" ] || fail CI_PROVISION_INSTALLED_CONF',
    ].every((line) => bodies.install_configuration?.includes(line)),
  );

  // Startup: the one service, a bounded wait.
  flag(
    "START",
    JSON.stringify(bodies.start_server) ===
      JSON.stringify([
        'sudo -n systemctl start "$SERVICE" || fail CI_PROVISION_START',
        '"$PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$PORT" -t 30 || fail CI_PROVISION_NOT_READY',
        '[ "$(systemctl is-active "$SERVICE" || true)" = "active" ] || fail CI_PROVISION_SERVICE_NOT_ACTIVE',
        "pass CI_PROVISION_STARTED",
      ]),
  );

  // The verifier: read with dd iflag=nofollow, validated, used only in the
  // builtin printf that feeds psql's standard input.
  const verifierLines = lines
    .map((l) => l.trim())
    .filter((l) =>
      /\$\{?#?VERIFIER\b(?!_)|\bVERIFIER=|unset VERIFIER\b/.test(l),
    );
  flag(
    "VERIFIER_USE",
    verifierLines.every((l) => VERIFIER_LINES.includes(l)) &&
      VERIFIER_LINES.slice(1).every((l) => verifierLines.includes(l)),
  );
  flag(
    "VERIFIER_EXPORT",
    // A "VERIFIER=value command" prefix is caught by VERIFIER_USE (that line
    // isn't an allowed one); this catches exporting it.
    !/\bexport\s+(-[a-z]+\s+)?VERIFIER\b|\b(declare|local|typeset)\s+-[a-z]*x/.test(
      code,
    ),
  );
  flag(
    "VERIFIER_READ",
    lines.filter((l) => /\bdd\b/.test(l)).length === 1 &&
      code.includes('dd if="$VERIFIER_FILE" iflag=nofollow status=none'),
  );
  const provision = bodies.provision ?? [];
  const pipeline = provision.slice(1, 1 + PSQL_PIPELINE.length);
  flag(
    "PSQL_PIPELINE",
    JSON.stringify(pipeline) === JSON.stringify(PSQL_PIPELINE),
  );
  flag(
    "PSQL_OPTIONS",
    lines.filter((l) => /\/psql"/.test(l)).length === 2 &&
      !/\/psql"[^\n]*(\s-a\b|\s-e\b|\s-1\b|--single-transaction|--echo|\s-s\b|--set=|-v ECHO)/.test(
        code,
      ),
  );
  flag(
    "VERIFIER_CLEARED",
    provision.indexOf('VERIFIER=""') === 1 + PSQL_PIPELINE.length &&
      provision.indexOf("unset VERIFIER") === 2 + PSQL_PIPELINE.length &&
      provision.indexOf(
        '[ "$status" -eq 0 ] || fail CI_PROVISION_SQL_FAILED',
      ) ===
        3 + PSQL_PIPELINE.length,
  );

  // Output: only builtin printf, fixed formats, codes only.
  flag(
    "OUTPUT_ECHO",
    !/\becho\b|\bprintf\b(?<!builtin printf)/.test(
      code.replace(/builtin printf/g, ""),
    ),
  );
  for (const line of lines
    .filter((l) => /\bbuiltin printf\b/.test(l))
    .map((l) => l.trim())) {
    flag(
      "OUTPUT_FORMAT",
      [
        "builtin printf '%s\\n' 'FAIL  CI_PROVISION_IMPORTED_FUNCTIONS'",
        "builtin printf '%s\\n' 'FAIL  CI_PROVISION_NOT_PRIVILEGED_MODE'",
        'trap \'builtin printf "FAIL  CI_PROVISION_UNEXPECTED_ERROR (line %s)\\n" "$LINENO"\' ERR',
        "builtin printf 'FAIL  %s\\n' \"$1\"",
        "builtin printf 'PASS  %s\\n' \"$1\"",
        "builtin printf '%s\\n' '\\set ECHO none'",
        "builtin printf '%s\\n' \"\\\\set test_verifier '${VERIFIER}'\"",
      ].includes(line),
    );
  }
  // fail and pass take a bare code; the one exception is the fixed final
  // line, which adds the validated server version.
  const finalPass =
    'pass "CI_PROVISION_COMPLETE (${SERVER_VERSION%% (Ubuntu*})"';
  for (const line of lines.map((l) => l.trim())) {
    if (line === finalPass) continue;
    for (const m of line.matchAll(/\b(fail|pass) (\S+)/g)) {
      if (m[2] === "{") continue;
      flag("OUTPUT_CODES", /^CI_PROVISION_[A-Z_]+$/.test(m[2] ?? ""));
    }
  }
  flag(
    "URL_NEVER_READ",
    !/(dd|cat|head|tail|grep|less|more|sed|awk)\b[^\n]*\$URL_FILE/.test(code),
  );

  // Cleanup: identity re-checked, the verifier removed and confirmed gone,
  // the URL file confirmed kept.
  flag(
    "CLEANUP",
    JSON.stringify(bodies.remove_verifier) ===
      JSON.stringify([
        '[ -f "$VERIFIER_FILE" ] && [ ! -L "$VERIFIER_FILE" ] || fail CI_PROVISION_VERIFIER_CHANGED',
        '[ "$(stat -c \'%d:%i %u %a %h %F %s\' -- "$VERIFIER_FILE")" = "$VERIFIER_IDENTITY" ] || fail CI_PROVISION_VERIFIER_CHANGED',
        'rm -- "$VERIFIER_FILE" || fail CI_PROVISION_VERIFIER_DELETE',
        '[ ! -e "$VERIFIER_FILE" ] && [ ! -L "$VERIFIER_FILE" ] || fail CI_PROVISION_VERIFIER_STILL_PRESENT',
        '[ -f "$URL_FILE" ] && [ ! -L "$URL_FILE" ] || fail CI_PROVISION_URL_FILE',
        '[ "$(stat -c \'%u %a %h %F\' -- "$URL_FILE")" = "$USER_ID 600 1 regular file" ] || fail CI_PROVISION_URL_FILE',
        "pass CI_PROVISION_VERIFIER_REMOVED",
      ]),
  );

  return [...violations].sort();
}

const script = read(SCRIPT_PATH);

describe("ci-provision-postgres.sh: the script", () => {
  test("parses with bash -n", () => {
    const result = spawnSync("bash", ["-n", SCRIPT_PATH], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("has every required property", () => {
    expect(scriptViolations(script)).toEqual([]);
  });

  test("defines exactly the expected functions", () => {
    expect(Object.keys(functionBodies(script)).sort()).toEqual(
      [
        "check_cluster",
        "check_credentials",
        "check_environment",
        "check_repository_files",
        "check_runner",
        "check_shell",
        "closed_mode",
        "fail",
        "install_configuration",
        "main",
        "pass",
        "provision",
        "remove_verifier",
        "start_server",
      ].sort(),
    );
  });

  test("is plain ASCII with Unix line endings, a final newline, and no trailing spaces", () => {
    expect(script).toMatch(/^[\x20-\x7e\n]*$/);
    expect(script.endsWith("\n")).toBe(true);
    expect(script).not.toMatch(/[ \t]+$/m);
  });

  test("says it's for the disposable CI cluster only", () => {
    expect(script).toContain("GitHub-hosted Ubuntu 26.04 runner ONLY");
  });

  test("holds no credentials", () => {
    expect(script).not.toMatch(/SCRAM-SHA-256\$\d/);
    expect(script).not.toMatch(/[0-9a-f]{32,}/i);
    expect(script).not.toMatch(/postgres(?:ql)?:\/\//);
  });
});

describe("ci-provision-postgres.sh: compatibility with Phases 2, 3A, and 3B", () => {
  test("installs the 3A files to the paths the 3B preflight expects", () => {
    const preflight = doBody(units, "preflight");
    const dataDir = CONSTANTS.DATA_DIR?.replace(/"/g, "");
    const confFile = CONSTANTS.CONF_FILE?.replace(/"/g, "");
    const hbaFile = CONSTANTS.HBA_FILE?.replace(/"/g, "");
    const confD = CONSTANTS.CONF_D?.replace(/"/g, "");
    const confName = CONSTANTS.CI_CONF_NAME?.replace(/"/g, "");
    expect(preflight).toContain(
      `current_setting('data_directory') = '${dataDir}'`,
    );
    expect(preflight).toContain(
      `current_setting('config_file') = '${confFile}'`,
    );
    expect(preflight).toContain(`current_setting('hba_file') = '${hbaFile}'`);
    expect(preflight).toContain(
      `ci_conf constant text := '${confD}/${confName}'`,
    );
    expect(preflight).toContain(
      `current_setting('port') = '${CONSTANTS.PORT?.replace(/"/g, "")}'`,
    );
    expect(script).toContain(
      'HBA_SOURCE="$REPO_ROOT/scripts/db/ci/pg_hba.conf"',
    );
    expect(script).toContain(
      'CONF_SOURCE="$REPO_ROOT/scripts/db/ci/postgresql-ci.conf"',
    );
    expect(script).toContain('SQL_FILE="$REPO_ROOT/scripts/db/ci-setup.sql"');
  });

  test("checks the verifier with exactly the 3B SQL pattern and iteration range", () => {
    const sqlPattern = /:'test_verifier' ~ '([^']+)'/.exec(sql)?.[1];
    expect(CONSTANTS.SCRAM_PATTERN).toBe(`'${sqlPattern}'`);
    expect(script).toContain(
      `(( 10#$iterations >= ${SCRAM_MIN_ITERATIONS} && 10#$iterations <= ${SCRAM_MAX_ITERATIONS} ))`,
    );
  });

  test("sets the psql variable ci-setup.sql reads, as ci-setup.sql documents", () => {
    expect(sql).toContain(
      "\\set test_verifier '<SCRAM-SHA-256 verifier of the test role>'",
    );
    expect(script).toContain("\\\\set test_verifier '${VERIFIER}'");
    // The SQL turns echo off itself too; the script sends it first so not
    // even the \set line could be echoed.
    expect(PSQL_PIPELINE[2]).toBe("builtin printf '%s\\n' '\\set ECHO none'");
  });

  test("uses the Phase 2 credential layout", async () => {
    const files = await import("./ci-credential-files");
    expect(CONSTANTS.CREDENTIAL_DIR_NAME).toBe(
      `"${files.CI_CREDENTIAL_DIRECTORY}"`,
    );
    expect(CONSTANTS.URL_NAME).toBe(
      `"${files.CI_CREDENTIAL_FILES.testDatabaseUrl}"`,
    );
    expect(CONSTANTS.VERIFIER_NAME).toBe(
      `"${files.CI_CREDENTIAL_FILES.testRoleVerifier}"`,
    );
  });

  test("refuses the same variables as the Phase 2 credential step and more", () => {
    expect(ENVIRONMENT_GATES[0]).toContain(
      "PG*|POSTGRES_*|postgres_*|DATABASE_*|TEST_DATABASE_URL",
    );
  });
});

describe("ci-provision-postgres.sh: the shell gates", () => {
  // Only the first lines run, as far as the shell gates: the rest is cut
  // off, so nothing reaches sudo, systemctl, or psql.
  const head = () => {
    const end = script.indexOf("check_runner() {");
    return `${script.slice(0, end)}\ncheck_shell "$@"\n`;
  };
  // Standard input is /dev/null. Node's default stdin pipe is a socket on
  // Linux, and Debian's Bash, started with -c on a socket and with no
  // SHLVL, takes itself for a remote shell and reads /etc/bash.bashrc and
  // ~/.bashrc before the first line (traced under -x). The workflow runs
  // the script as bash -p <script>, never with -c, which never does that.
  const prelude = (
    env: Record<string, string>,
    options: {
      privileged?: boolean;
      text?: string;
      extraFlags?: string[];
    } = {},
  ) =>
    spawnSync(
      "bash",
      [
        ...(options.privileged === false ? [] : ["-p"]),
        ...(options.extraFlags ?? []),
        "-c",
        options.text ?? head(),
        "ci-provision-postgres.sh",
        ...(env.ARGS ? [env.ARGS] : []),
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", ...env },
      },
    );

  test("passes the shell gate in privileged mode with no arguments", () => {
    const result = prelude({});
    expect(result.stdout).toBe("PASS  CI_PROVISION_SHELL\n");
    expect(result.status).toBe(0);
  });

  test("refuses to run without privileged mode, before anything else", () => {
    const result = prelude({}, { privileged: false });
    expect(result.stdout).toBe("FAIL  CI_PROVISION_NOT_PRIVILEGED_MODE\n");
    expect(result.status).toBe(1);
  });

  test("refuses arguments with exit code 2", () => {
    const result = prelude({ ARGS: "extra" });
    expect(result.stdout).toBe("FAIL  CI_PROVISION_USAGE\n");
    expect(result.status).toBe(2);
  });

  test("still refuses a function defined before its own (a second layer behind -p)", () => {
    // Privileged mode never imports functions from the environment, so this
    // layer is reached by defining one in the script text itself, right
    // after the privileged-mode check.
    const text = head().replace(
      "set -euo pipefail\n",
      "set -euo pipefail\ndd() { :; }\n",
    );
    expect(text).not.toBe(head());
    const result = prelude({}, { text });
    expect(result.stdout).toBe("FAIL  CI_PROVISION_IMPORTED_FUNCTIONS\n");
    expect(result.status).toBe(1);
  });

  test("ignores an inherited SHELLOPTS=xtrace in privileged mode: nothing is traced", () => {
    const result = prelude({ SHELLOPTS: "xtrace" });
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("PASS  CI_PROVISION_SHELL\n");
  });

  test("with explicit bash -p -x, only the first command (set +x) is traced", () => {
    const result = prelude({}, { extraFlags: ["-x"] });
    expect(result.stderr.trim().split("\n")).toEqual(["+ set +x"]);
    expect(result.stdout).toBe("PASS  CI_PROVISION_SHELL\n");
  });

  test("no startup file runs before the script, here or in the workflow's form (bash -p <script>)", () => {
    // A ~/.bashrc that leaves a marker, as the runner's would run first.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ci-provision-rc-")));
    try {
      const marker = `${home}/bashrc-ran`;
      writeFileSync(`${home}/.bashrc`, `: > '${marker}'\n`);
      const harness = prelude({ HOME: home }, { extraFlags: ["-x"] });
      expect(harness.stderr.trim().split("\n")).toEqual(["+ set +x"]);
      expect(harness.stdout).toBe("PASS  CI_PROVISION_SHELL\n");
      const copy = `${home}/ci-provision-postgres.sh`;
      writeFileSync(copy, head());
      const asWorkflow = spawnSync("bash", ["-p", "-x", copy], {
        encoding: "utf8",
        env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", HOME: home },
      });
      expect(asWorkflow.stderr.trim().split("\n")).toEqual(["+ set +x"]);
      expect(asWorkflow.stdout).toBe("PASS  CI_PROVISION_SHELL\n");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the workflow runs the script as bash -p <script>, never with -c", () => {
    // The startup-file behavior the prelude avoids needs -c, so it can't
    // happen in the workflow as long as this holds.
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const runs = workflow
      .split("\n")
      .filter((l) => /ci-provision-postgres\.sh|ci-expect-refusals\.sh/.test(l))
      .map((l) => l.trim());
    expect(runs).toEqual([
      "run: bash -p scripts/db/ci-provision-postgres.sh",
      "run: bash -p scripts/db/ci-expect-refusals.sh provision",
      "run: bash -p scripts/db/ci-expect-refusals.sh sql",
    ]);
    expect(workflow).not.toMatch(/\bbash\b[^\n]*\s-[a-zA-Z]*c\b/);
    expect(workflow).not.toMatch(/\bsh -c\b/);
  });
});

describe("ci-provision-postgres.sh: privileged mode against a hostile environment", () => {
  // Real runs of the whole script with environments that try to inject code
  // at shell startup. Every run stops at a gate before sudo, systemctl, or
  // psql; marker files record whether any injected code ran.
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "ci-provision-env-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const runScript = (env: Record<string, string>, flags: string[] = ["-p"]) =>
    spawnSync("bash", [...flags, SCRIPT_PATH], {
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", ...env },
    });

  const hijack = (marker: string) => ({
    "BASH_FUNC_set%%": `() { builtin printf '%s\\n' HIJACKED; : > '${marker}'; }`,
  });

  test("an imported function overriding set does not run in privileged mode", () => {
    const marker = `${dir}/function-ran`;
    const result = runScript(hijack(marker));
    expect(result.stdout).not.toContain("HIJACKED");
    expect(existsSync(marker)).toBe(false);
    expect(result.stdout).toBe(
      "PASS  CI_PROVISION_SHELL\nFAIL  CI_PROVISION_NOT_GITHUB_ACTIONS\n",
    );
  });

  test("without privileged mode the same function does run (why -p is required), and the script then refuses", () => {
    const marker = `${dir}/function-ran`;
    const result = runScript(hijack(marker), []);
    expect(existsSync(marker)).toBe(true);
    expect(result.stdout).toContain("FAIL  CI_PROVISION_NOT_PRIVILEGED_MODE");
    expect(result.status).toBe(1);
  });

  test("BASH_ENV is not executed in privileged mode", () => {
    const marker = `${dir}/bash-env-ran`;
    writeFileSync(`${dir}/startup.sh`, `: > '${marker}'\n`);
    const result = runScript({ BASH_ENV: `${dir}/startup.sh` });
    expect(existsSync(marker)).toBe(false);
    expect(result.stdout).toBe(
      "PASS  CI_PROVISION_SHELL\nFAIL  CI_PROVISION_NOT_GITHUB_ACTIONS\n",
    );
  });

  test("without privileged mode BASH_ENV runs before line 1, and the script then refuses", () => {
    const marker = `${dir}/bash-env-ran`;
    writeFileSync(`${dir}/startup.sh`, `: > '${marker}'\n`);
    const result = runScript({ BASH_ENV: `${dir}/startup.sh` }, []);
    expect(existsSync(marker)).toBe(true);
    expect(result.stdout).toBe("FAIL  CI_PROVISION_NOT_PRIVILEGED_MODE\n");
  });

  test("the #!/bin/bash -p line makes a directly executed copy privileged", () => {
    const copy = `${dir}/ci-provision-postgres.sh`;
    writeFileSync(copy, script);
    chmodSync(copy, 0o700);
    const result = spawnSync(copy, [], {
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" },
    });
    expect(result.stdout).toBe(
      "PASS  CI_PROVISION_SHELL\nFAIL  CI_PROVISION_NOT_GITHUB_ACTIONS\n",
    );
  });

  test("without privileged mode nothing else runs: no later stage, no credential read", () => {
    // A complete runner-like environment with the credential files in
    // place. The credential directory is unreadable, so any attempt to read
    // it would print a credential code; only the privileged-mode refusal
    // may appear.
    const temp = `${dir}/_temp`;
    const commands = `${temp}/_runner_file_commands`;
    mkdirSync(commands, { recursive: true });
    writeFileSync(`${commands}/set_env_x`, "");
    const credentials = `${temp}/ai-spec-studio-db`;
    mkdirSync(credentials, { mode: 0o700 });
    writeFileSync(`${credentials}/test-database-url`, "x", { mode: 0o600 });
    writeFileSync(`${credentials}/test-role-verifier`, "x", { mode: 0o600 });
    chmodSync(credentials, 0o000);
    try {
      const result = runScript(
        {
          GITHUB_ACTIONS: "true",
          CI: "true",
          RUNNER_ENVIRONMENT: "github-hosted",
          RUNNER_OS: "Linux",
          ImageOS: "ubuntu26",
          RUNNER_TEMP: temp,
          GITHUB_ENV: `${commands}/set_env_x`,
        },
        [],
      );
      expect(result.stdout).toBe("FAIL  CI_PROVISION_NOT_PRIVILEGED_MODE\n");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(1);
    } finally {
      chmodSync(credentials, 0o700);
    }
  });

  test("the privileged-mode check precedes every credential, sudo, and psql line", () => {
    const lines = codeLines(script);
    const check = lines.indexOf('case "$-" in');
    expect(check).toBe(2);
    for (const pattern of [
      /\bdd\b/,
      /\bsudo\b/,
      /\/psql"/,
      /VERIFIER=/,
      /\bcompgen\b/,
    ]) {
      const first = lines.findIndex((l) => pattern.test(l));
      expect(first, String(pattern)).toBeGreaterThan(check);
    }
  });
});

describe("ci-provision-postgres.sh: refuses outside a GitHub-hosted runner", () => {
  // The whole script, with a controlled environment: it must stop at the
  // first runner gate, before sudo, systemctl, or psql could run.
  const run = (env: Record<string, string>) =>
    spawnSync("bash", ["-p", SCRIPT_PATH], {
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", ...env },
    });

  test("without GitHub Actions", () => {
    const result = run({});
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(
      "PASS  CI_PROVISION_SHELL\nFAIL  CI_PROVISION_NOT_GITHUB_ACTIONS\n",
    );
    expect(result.stderr).toBe("");
  });

  test("on a self-hosted runner", () => {
    const result = run({
      GITHUB_ACTIONS: "true",
      CI: "true",
      RUNNER_ENVIRONMENT: "self-hosted",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(
      "PASS  CI_PROVISION_SHELL\nFAIL  CI_PROVISION_NOT_GITHUB_HOSTED\n",
    );
  });

  test("with an argument", () => {
    const result = spawnSync("bash", ["-p", SCRIPT_PATH, "--force"], {
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("FAIL  CI_PROVISION_USAGE\n");
  });
});

describe("ci-provision-postgres.sh: mutation tests", () => {
  // Each mutation weakens one property; scriptViolations must catch it.
  const mutations: Array<[string, string | RegExp, string, string]> = [
    // Weakened runner gates.
    [
      "GITHUB_ACTIONS accepted when unset",
      '[ "${GITHUB_ACTIONS:-}" = "true" ]',
      '[ "${GITHUB_ACTIONS:-true}" = "true" ]',
      "RUNNER_GATES",
    ],
    [
      "self-hosted runners accepted",
      '[ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ] || fail CI_PROVISION_NOT_GITHUB_HOSTED\n',
      "",
      "RUNNER_GATES",
    ],
    [
      "any image accepted",
      '[ "${ImageOS:-}" = "ubuntu26" ]',
      '[ -n "${ImageOS:-}" ]',
      "RUNNER_GATES",
    ],
    [
      "os-release not checked",
      "  grep -qx 'VERSION_ID=\"26.04\"' /etc/os-release || fail CI_PROVISION_OS_RELEASE\n",
      "",
      "RUNNER_GATES",
    ],
    [
      "running as root accepted",
      '[ "$USER_ID" != "0" ] || fail CI_PROVISION_RUNNING_AS_ROOT',
      "true",
      "RUNNER_GATES",
    ],
    [
      "PG* variables accepted",
      "PG*|POSTGRES_*|postgres_*",
      "POSTGRES_*|postgres_*",
      "ENVIRONMENT_GATES",
    ],
    ["BASH_ENV accepted", "BASH_ENV|ENV|", "ENV|", "ENVIRONMENT_GATES"],
    [
      "privileged-mode check removed",
      `case "$-" in\n  *p*) ;;\n  *)\n    builtin printf '%s\\n' 'FAIL  CI_PROVISION_NOT_PRIVILEGED_MODE'\n    exit 1\n    ;;\nesac\n`,
      "",
      "PRELUDE",
    ],
    [
      "privileged mode not required",
      "  *p*) ;;\n  *)\n",
      "  *) ;;\n  x)\n",
      "PRELUDE",
    ],
    ["shebang without -p", "#!/bin/bash -p\n", "#!/bin/bash\n", "PRELUDE"],
    [
      "privileged check after strict mode",
      'set +x\ncase "$-" in',
      'set +x\nset -u\ncase "$-" in',
      "PRELUDE",
    ],
    [
      "imported functions accepted",
      'if [ -n "$(declare -F)" ]; then',
      "if false; then",
      "PRELUDE",
    ],
    // Skipped or reordered checks.
    [
      "cluster checks skipped",
      "  check_cluster\n  install_configuration",
      "  install_configuration",
      "MAIN_ORDER",
    ],
    [
      "install before the cluster checks",
      "  check_cluster\n  install_configuration",
      "  install_configuration\n  check_cluster",
      "MAIN_ORDER",
    ],
    [
      "credentials checked after provisioning",
      "  check_credentials\n",
      "",
      "MAIN_ORDER",
    ],
    [
      "port not checked",
      '  [ -z "$(ss -Hltn "sport = :$PORT")" ] || fail CI_PROVISION_PORT_IN_USE\n',
      "",
      "CLUSTER_GATES",
    ],
    [
      "postmaster.pid not checked",
      /  if sudo -n -u postgres test -e[^\n]*\n[^\n]*\n  fi\n/,
      "",
      "CLUSTER_GATES",
    ],
    [
      "conf.d not checked for emptiness",
      '  [ "${#entries[@]}" -eq 0 ] || fail CI_PROVISION_CONF_D_NOT_EMPTY\n',
      "",
      "CLUSTER_GATES",
    ],
    [
      "verifier format not checked",
      '  [[ "$VERIFIER" =~ $SCRAM_PATTERN ]] || fail CI_PROVISION_VERIFIER_FORMAT\n',
      "",
      "CREDENTIAL_GATES",
    ],
    [
      "install inside a check",
      "  pass CI_PROVISION_CLUSTER\n",
      '  sudo -n install -T -o postgres -g postgres -m 0640 -- "$HBA_SOURCE" "$HBA_FILE" || fail CI_PROVISION_INSTALL_HBA\n  pass CI_PROVISION_CLUSTER\n',
      "CHANGE_OUTSIDE_STAGE",
    ],
    // Permissive configuration.
    [
      "world-readable configuration",
      '-m 0640 -- "$HBA_SOURCE"',
      '-m 0644 -- "$HBA_SOURCE"',
      "INSTALL",
    ],
    [
      "configuration in the wrong place",
      '"$CONF_D/$CI_CONF_NAME" || fail CI_PROVISION_INSTALL_CONF',
      '"$CONF_DIR/postgresql.conf" || fail CI_PROVISION_INSTALL_CONF',
      "INSTALL",
    ],
    [
      "a different conf.d file name",
      'readonly CI_CONF_NAME="90-ai-spec-studio-ci.conf"',
      'readonly CI_CONF_NAME="ci.conf"',
      "CONSTANTS",
    ],
    [
      "recursive permission change",
      "  pass CI_PROVISION_CONFIGURATION\n",
      '  sudo -n chmod -R go+r "$CONF_DIR"\n  pass CI_PROVISION_CONFIGURATION\n',
      "DESTRUCTIVE",
    ],
    [
      "recursive delete",
      '  rm -- "$VERIFIER_FILE"',
      '  rm -rf -- "$CREDENTIAL_DIR"',
      "DESTRUCTIVE",
    ],
    [
      "the URL file deleted",
      "  pass CI_PROVISION_VERIFIER_REMOVED\n",
      '  rm -- "$URL_FILE"\n  pass CI_PROVISION_VERIFIER_REMOVED\n',
      "REMOVE",
    ],
    [
      "the cluster recreated",
      "  pass CI_PROVISION_CLUSTER\n",
      "  sudo -n pg_createcluster 18 main\n  pass CI_PROVISION_CLUSTER\n",
      "DESTRUCTIVE",
    ],
    [
      "the service restarted",
      'sudo -n systemctl start "$SERVICE"',
      'sudo -n systemctl restart "$SERVICE"',
      "START",
    ],
    ["an unbounded wait", '-p "$PORT" -t 30 ||', '-p "$PORT" -t 0 ||', "START"],
    // Tracing and secret-bearing commands.
    [
      "tracing enabled",
      "set -o errtrace\n",
      "set -o errtrace\nset -x\n",
      "XTRACE",
    ],
    [
      "tracing via set -ex",
      "set -euo pipefail\n",
      "set -euxo pipefail\n",
      "XTRACE",
    ],
    [
      "the verifier echoed",
      "  pass CI_PROVISION_CREDENTIALS\n",
      '  echo "$VERIFIER"\n  pass CI_PROVISION_CREDENTIALS\n',
      "OUTPUT_ECHO",
    ],
    [
      "the verifier printed",
      "  pass CI_PROVISION_CREDENTIALS\n",
      "  builtin printf '%s\\n' \"$VERIFIER\"\n  pass CI_PROVISION_CREDENTIALS\n",
      "VERIFIER_USE",
    ],
    [
      "the verifier exported",
      '  VERIFIER=""\n  unset VERIFIER',
      '  export VERIFIER\n  VERIFIER=""\n  unset VERIFIER',
      "VERIFIER_EXPORT",
    ],
    [
      "the verifier in an external printf",
      "builtin printf '%s\\n' \"\\\\set test_verifier",
      "/usr/bin/printf '%s\\n' \"\\\\set test_verifier",
      "PSQL_PIPELINE",
    ],
    [
      "the verifier in sudo's environment",
      'sudo -n -u postgres -- "$PG_BIN/psql"',
      'sudo -n --preserve-env=VERIFIER -u postgres -- "$PG_BIN/psql"',
      "SUDO_ENVIRONMENT",
    ],
    [
      "the verifier as a psql argument",
      "-v ON_ERROR_STOP=1 -d postgres -f -",
      '-v ON_ERROR_STOP=1 -v "test_verifier=$VERIFIER" -d postgres -f -',
      "PSQL_PIPELINE",
    ],
    [
      "the verifier read with cat",
      'VERIFIER="$(dd if="$VERIFIER_FILE" iflag=nofollow status=none)"',
      'VERIFIER="$(cat -- "$VERIFIER_FILE")"',
      "VERIFIER_READ",
    ],
    [
      "the verifier read following symlinks",
      "iflag=nofollow status=none",
      "status=none",
      "VERIFIER_READ",
    ],
    [
      "the verifier kept after provisioning",
      '  VERIFIER=""\n  unset VERIFIER\n',
      "",
      "VERIFIER_CLEARED",
    ],
    [
      "the URL file read",
      "  pass CI_PROVISION_VERIFIER_REMOVED\n",
      '  cat -- "$URL_FILE" >/dev/null\n  pass CI_PROVISION_VERIFIER_REMOVED\n',
      "URL_NEVER_READ",
    ],
    [
      "a message carrying a value",
      "fail CI_PROVISION_RUNNER_TEMP\n  case",
      'fail "CI_PROVISION_RUNNER_TEMP $temp"\n  case',
      "OUTPUT_CODES",
    ],
    // Unsafe psql options.
    [
      "psql -a",
      "-X -q -v ON_ERROR_STOP=1",
      "-X -q -a -v ON_ERROR_STOP=1",
      "PSQL_OPTIONS",
    ],
    [
      "psql -e",
      "-X -q -v ON_ERROR_STOP=1",
      "-X -q -e -v ON_ERROR_STOP=1",
      "PSQL_OPTIONS",
    ],
    [
      "psql -1",
      "-X -q -v ON_ERROR_STOP=1",
      "-X -q -1 -v ON_ERROR_STOP=1",
      "PSQL_OPTIONS",
    ],
    [
      "psql --single-transaction",
      "-X -q -v ON_ERROR_STOP=1",
      "-X -q --single-transaction -v ON_ERROR_STOP=1",
      "PSQL_OPTIONS",
    ],
    ["psqlrc read", 'psql" -X -q', 'psql" -q', "PSQL_PIPELINE"],
    ["errors don't stop psql", "-v ON_ERROR_STOP=1 -d", "-d", "PSQL_PIPELINE"],
    [
      "echo not turned off first",
      "      builtin printf '%s\\n' '\\set ECHO none'\n",
      "",
      "PSQL_PIPELINE",
    ],
    [
      "SQL failure ignored",
      '[ "$status" -eq 0 ] || fail CI_PROVISION_SQL_FAILED',
      "true",
      "VERIFIER_CLEARED",
    ],
    // sudo forms.
    [
      "interactive sudo",
      "sudo -n systemctl start",
      "sudo systemctl start",
      "SUDO_FORM",
    ],
    [
      "a root shell",
      "  pass CI_PROVISION_STARTED\n",
      "  sudo -n bash -c 'true'\n  pass CI_PROVISION_STARTED\n",
      "SUDO_FORM",
    ],
    // Error reporting, entry point, and the remaining checks.
    [
      "no trap for unexpected errors",
      `trap 'builtin printf "FAIL  CI_PROVISION_UNEXPECTED_ERROR (line %s)\\n" "$LINENO"' ERR\n`,
      "",
      "ERR_TRAP",
    ],
    [
      "main called without the arguments",
      '\nmain "$@"\n',
      "\nmain\n",
      "MAIN_CALL",
    ],
    [
      "arguments accepted",
      '  [ "$#" -eq 0 ] || fail CI_PROVISION_USAGE 2\n',
      "",
      "SHELL_GATES",
    ],
    [
      "installed file not verified",
      `  [ "$(stat -c '%U %G %a %h %F' -- "$HBA_FILE")" = "postgres postgres 640 1 regular file" ] || fail CI_PROVISION_INSTALLED_HBA\n`,
      "",
      "INSTALL_VERIFIED",
    ],
    [
      "a download",
      "  pass CI_PROVISION_STARTED\n",
      "  curl -fsS https://example.invalid/x >/dev/null\n  pass CI_PROVISION_STARTED\n",
      "DOWNLOAD",
    ],
    [
      "a sensitive path printed",
      "  pass CI_PROVISION_CREDENTIALS\n",
      "  builtin printf 'dir %s\\n' \"$CREDENTIAL_DIR\"\n  pass CI_PROVISION_CREDENTIALS\n",
      "OUTPUT_FORMAT",
    ],
    // Cleanup.
    [
      "the verifier removed without an identity check",
      /  \[ "\$\(stat -c '%d:%i %u %a %h %F %s' -- "\$VERIFIER_FILE"\)" = "\$VERIFIER_IDENTITY" \] \|\| fail CI_PROVISION_VERIFIER_CHANGED\n  rm/,
      "  rm",
      "CLEANUP",
    ],
    [
      "removal not confirmed",
      '  [ ! -e "$VERIFIER_FILE" ] && [ ! -L "$VERIFIER_FILE" ] || fail CI_PROVISION_VERIFIER_STILL_PRESENT\n',
      "",
      "CLEANUP",
    ],
  ];

  test.each(mutations)("%s", (_name, from, to, expected) => {
    const mutated =
      typeof from === "string"
        ? script.replace(from, to)
        : script.replace(from, to);
    expect(mutated, "the mutation must change the script").not.toBe(script);
    expect(scriptViolations(mutated)).toContain(expected);
  });

  test("covers every violation the checker can report", () => {
    const reported = new Set(mutations.map(([, , , code]) => code));
    for (const code of [
      "RUNNER_GATES",
      "ENVIRONMENT_GATES",
      "PRELUDE",
      "MAIN_ORDER",
      "CLUSTER_GATES",
      "CREDENTIAL_GATES",
      "CHANGE_OUTSIDE_STAGE",
      "INSTALL",
      "CONSTANTS",
      "DESTRUCTIVE",
      "REMOVE",
      "START",
      "XTRACE",
      "OUTPUT_ECHO",
      "VERIFIER_USE",
      "VERIFIER_EXPORT",
      "PSQL_PIPELINE",
      "SUDO_ENVIRONMENT",
      "VERIFIER_READ",
      "VERIFIER_CLEARED",
      "URL_NEVER_READ",
      "OUTPUT_CODES",
      "PSQL_OPTIONS",
      "SUDO_FORM",
      "CLEANUP",
      "ERR_TRAP",
      "MAIN_CALL",
      "SHELL_GATES",
      "INSTALL_VERIFIED",
      "DOWNLOAD",
      "OUTPUT_FORMAT",
    ]) {
      expect(reported.has(code), code).toBe(true);
    }
  });
});

test("runs every test with this file's 30-second timeout", ({ task }) => {
  expect(task.timeout).toBe(30_000);
});
