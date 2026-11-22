import { describe, expect, test } from "vitest";
import {
  estimateEntropyBits,
  MIN_SECRET_ENTROPY_BITS,
  parseAuthEnv,
  parseOrigin,
  type AuthEnv,
} from "@/lib/auth/env";
import type { EnvParseResult } from "@/lib/db/env";

// Fictional values made only for these tests. Each is distinctive, so a
// leak into an error message shows up in expectNoSecrets.
const SECRET = "FakeAuthSecretForUnitTestsOnly+0123456789/xyzQ=";
const GITHUB_ID = "Ov23liFakeGithubClientId";
const GITHUB_SECRET = "fake0github0client0secret0value0for0tests";
const GOOGLE_ID = "1234567890-fakeclientid.apps.googleusercontent.com";
const GOOGLE_SECRET = "GOCSPX-FakeGoogleClientSecretForTests";
const ALL_SECRETS = [SECRET, GITHUB_SECRET, GOOGLE_SECRET];

const LOCAL_ENV: AuthEnv = {
  NODE_ENV: "development",
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_CLIENT_ID: GITHUB_ID,
  GITHUB_CLIENT_SECRET: GITHUB_SECRET,
  GOOGLE_CLIENT_ID: GOOGLE_ID,
  GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
};

const PRODUCTION_ENV: AuthEnv = {
  ...LOCAL_ENV,
  NODE_ENV: "production",
  BETTER_AUTH_URL: "https://studio.example.com",
};

function expectErrors<T>(result: EnvParseResult<T>): string[] {
  if (result.ok) throw new Error("Expected the env to be rejected.");
  expectNoSecrets(result.errors.join("\n"));
  return result.errors;
}

function expectValue<T>(result: EnvParseResult<T>): T {
  if (!result.ok) throw new Error(`Unexpected errors: ${result.errors}`);
  return result.value;
}

function expectNoSecrets(output: string) {
  for (const secret of ALL_SECRETS) expect(output).not.toContain(secret);
}

describe("parseAuthEnv: valid configuration", () => {
  test("accepts a complete local development configuration", () => {
    expect(expectValue(parseAuthEnv(LOCAL_ENV))).toEqual({
      secret: SECRET,
      baseURL: "http://localhost:3000",
      trustedOrigins: ["http://localhost:3000"],
      secureCookies: false,
      github: { clientId: GITHUB_ID, clientSecret: GITHUB_SECRET },
      google: { clientId: GOOGLE_ID, clientSecret: GOOGLE_SECRET },
    });
  });

  test("accepts an HTTPS production configuration with secure cookies", () => {
    const config = expectValue(parseAuthEnv(PRODUCTION_ENV));
    expect(config.baseURL).toBe("https://studio.example.com");
    expect(config.trustedOrigins).toEqual(["https://studio.example.com"]);
    expect(config.secureCookies).toBe(true);
  });

  test.each(["http://127.0.0.1:3001", "http://[::1]:3000", "http://localhost"])(
    "allows loopback HTTP in local development: %s",
    (url) => {
      const config = expectValue(
        parseAuthEnv({ ...LOCAL_ENV, BETTER_AUTH_URL: url }),
      );
      expect(config.secureCookies).toBe(false);
    },
  );

  test("normalizes BETTER_AUTH_URL to its origin", () => {
    const config = expectValue(
      parseAuthEnv({
        ...PRODUCTION_ENV,
        BETTER_AUTH_URL: "https://Studio.Example.com:443",
      }),
    );
    expect(config.baseURL).toBe("https://studio.example.com");
  });

  test("adds extra trusted origins after BETTER_AUTH_URL, without duplicates", () => {
    const config = expectValue(
      parseAuthEnv({
        ...PRODUCTION_ENV,
        BETTER_AUTH_TRUSTED_ORIGINS:
          "https://studio.example.com,https://preview.example.com",
      }),
    );
    expect(config.trustedOrigins).toEqual([
      "https://studio.example.com",
      "https://preview.example.com",
    ]);
  });

  test("treats an empty BETTER_AUTH_TRUSTED_ORIGINS as unset", () => {
    const config = expectValue(
      parseAuthEnv({ ...LOCAL_ENV, BETTER_AUTH_TRUSTED_ORIGINS: "" }),
    );
    expect(config.trustedOrigins).toEqual(["http://localhost:3000"]);
  });

  test("never reads process.env", () => {
    // An empty record fails even though the test process may have values.
    expect(parseAuthEnv({}).ok).toBe(false);
  });
});

describe("parseAuthEnv: BETTER_AUTH_SECRET", () => {
  test.each([undefined, "", "   "])("rejects a missing secret: %j", (value) => {
    expect(
      expectErrors(parseAuthEnv({ ...LOCAL_ENV, BETTER_AUTH_SECRET: value })),
    ).toContain("BETTER_AUTH_SECRET is not set.");
  });

  test("rejects a secret shorter than 32 characters", () => {
    const errors = expectErrors(
      parseAuthEnv({
        ...LOCAL_ENV,
        BETTER_AUTH_SECRET: "Sh0rt+Fake/Secret_x9",
      }),
    );
    expect(errors).toEqual([
      expect.stringContaining("must be at least 32 characters"),
    ]);
  });

  test.each([
    ["one repeated character", "a".repeat(64)],
    ["two alternating characters", "ab".repeat(32)],
    ["a short repeated pattern", "abcde".repeat(8)],
  ])("rejects a low-entropy secret: %s", (_label, value) => {
    expect(estimateEntropyBits(value)).toBeLessThan(MIN_SECRET_ENTROPY_BITS);
    const errors = expectErrors(
      parseAuthEnv({ ...LOCAL_ENV, BETTER_AUTH_SECRET: value }),
    );
    expect(errors).toEqual([expect.stringContaining("too predictable")]);
    for (const error of errors) expect(error).not.toContain(value);
  });

  test("rejects Better Auth's built-in default secret", () => {
    expect(
      expectErrors(
        parseAuthEnv({
          ...LOCAL_ENV,
          BETTER_AUTH_SECRET: "better-auth-secret-12345678901234567890",
        }),
      ),
    ).toEqual([expect.stringContaining("built-in default secret")]);
  });

  test.each([
    ["inner space", `${SECRET.slice(0, 20)} ${SECRET.slice(20)}`],
    ["trailing newline", `${SECRET}\n`],
    ["leading space", ` ${SECRET}`],
    ["control character", `${SECRET}\u0007`],
  ])("rejects whitespace and control characters: %s", (_label, value) => {
    expect(
      expectErrors(parseAuthEnv({ ...LOCAL_ENV, BETTER_AUTH_SECRET: value })),
    ).toEqual([
      "BETTER_AUTH_SECRET must not contain spaces or control characters.",
    ]);
  });

  test("rejects a secret longer than 1024 characters", () => {
    const value = SECRET.repeat(30);
    expect(
      expectErrors(parseAuthEnv({ ...LOCAL_ENV, BETTER_AUTH_SECRET: value })),
    ).toEqual(["BETTER_AUTH_SECRET must be at most 1024 characters."]);
  });

  test("accepts generated secrets (openssl rand -base64 32 and -hex 32)", () => {
    for (const value of [
      "q8Zf3mV1xK0pR7sT2wY9bN4cH6jL5dG+eA/uIoE1nQ=",
      "4f9c2a7e1b8d3f6a0c5e9b2d7f1a4c8e3b6d0f5a9c2e7b1d4f8a3c6e0b5d9f2a",
    ]) {
      expect(estimateEntropyBits(value)).toBeGreaterThanOrEqual(
        MIN_SECRET_ENTROPY_BITS,
      );
      expect(parseAuthEnv({ ...LOCAL_ENV, BETTER_AUTH_SECRET: value }).ok).toBe(
        true,
      );
    }
  });

  test("refuses BETTER_AUTH_SECRETS, which would replace the secret", () => {
    expect(
      expectErrors(
        parseAuthEnv({
          ...LOCAL_ENV,
          BETTER_AUTH_SECRETS: `1:${SECRET}`,
        }),
      ),
    ).toEqual([
      expect.stringMatching(/^BETTER_AUTH_SECRETS must not be set\./),
    ]);
  });
});

describe("parseAuthEnv: BETTER_AUTH_URL", () => {
  test.each([undefined, "", "  "])("rejects a missing URL: %j", (value) => {
    expect(
      expectErrors(parseAuthEnv({ ...LOCAL_ENV, BETTER_AUTH_URL: value })),
    ).toEqual(["BETTER_AUTH_URL is not set."]);
  });

  test.each([
    ["not a URL", "studio.example.com", "is not a valid URL"],
    ["another scheme", "ftp://studio.example.com", "must start with https://"],
    ["a javascript: URL", "javascript:alert(1)", "must start with https://"],
    ["a path", "https://studio.example.com/app", "origin only"],
    ["a trailing slash", "https://studio.example.com/", "origin only"],
    ["a query", "https://studio.example.com?x=1", "query parameters"],
    ["a fragment", "https://studio.example.com#top", "#fragment"],
    [
      "credentials",
      "https://user:pass@studio.example.com",
      "user name or password",
    ],
    ["a wildcard", "https://*.example.com", "Wildcards"],
    ["surrounding spaces", " https://studio.example.com", "spaces"],
  ])("rejects %s", (_label, url, message) => {
    const errors = expectErrors(
      parseAuthEnv({ ...PRODUCTION_ENV, BETTER_AUTH_URL: url }),
    );
    expect(errors.join("\n")).toContain(message);
    expect(errors.every((error) => error.startsWith("BETTER_AUTH_URL"))).toBe(
      true,
    );
  });

  test("rejects plain HTTP for a remote host, even in development", () => {
    expect(
      expectErrors(
        parseAuthEnv({
          ...LOCAL_ENV,
          BETTER_AUTH_URL: "http://studio.example.com",
        }),
      ),
    ).toEqual([expect.stringContaining("must use https://")]);
  });

  test.each(["http://localhost:3000", "http://127.0.0.1:3000"])(
    "rejects loopback HTTP in production: %s",
    (url) => {
      expect(
        expectErrors(parseAuthEnv({ ...PRODUCTION_ENV, BETTER_AUTH_URL: url })),
      ).toEqual([
        "BETTER_AUTH_URL must use https:// when NODE_ENV is production.",
      ]);
    },
  );

  test("doesn't treat look-alike hosts as loopback", () => {
    for (const url of [
      "http://localhost.example.com",
      "http://127.0.0.1.example.com",
      "http://0.0.0.0:3000",
    ]) {
      expect(
        parseOrigin("BETTER_AUTH_URL", url, { isProduction: false }).ok,
      ).toBe(false);
    }
  });
});

describe("parseAuthEnv: BETTER_AUTH_TRUSTED_ORIGINS", () => {
  test.each([
    ["a wildcard", "https://*.example.com", "Wildcards"],
    ["a bare wildcard", "*", "Wildcards"],
    [
      "a path (redirect target)",
      "https://other.example.com/callback",
      "origin only",
    ],
    [
      "plain HTTP for a remote host",
      "http://other.example.com",
      "must use https://",
    ],
    [
      "spaces after commas",
      "https://a.example.com, https://b.example.com",
      "spaces",
    ],
    [
      "an empty entry",
      "https://a.example.com,,https://b.example.com",
      "is empty",
    ],
    ["a trailing comma", "https://a.example.com,", "is empty"],
    ["an uppercase host", "https://Other.Example.com", "canonical form"],
    ["a default port", "https://other.example.com:443", "canonical form"],
    [
      "a non-HTTP scheme",
      "chrome-extension://abcdef",
      "must start with https://",
    ],
  ])("rejects %s", (_label, value, message) => {
    const errors = expectErrors(
      parseAuthEnv({ ...PRODUCTION_ENV, BETTER_AUTH_TRUSTED_ORIGINS: value }),
    );
    expect(errors.join("\n")).toContain(message);
    expect(
      errors.every((error) =>
        error.startsWith("BETTER_AUTH_TRUSTED_ORIGINS entry"),
      ),
    ).toBe(true);
  });

  test("names the failing entry by position", () => {
    expect(
      expectErrors(
        parseAuthEnv({
          ...PRODUCTION_ENV,
          BETTER_AUTH_TRUSTED_ORIGINS:
            "https://a.example.com,https://b.example.com/path",
        }),
      ),
    ).toEqual([expect.stringMatching(/^BETTER_AUTH_TRUSTED_ORIGINS entry 2 /)]);
  });

  test("rejects loopback HTTP origins in production", () => {
    expect(
      expectErrors(
        parseAuthEnv({
          ...PRODUCTION_ENV,
          BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
        }),
      ),
    ).toEqual([
      "BETTER_AUTH_TRUSTED_ORIGINS entry 1 must use https:// when NODE_ENV is production.",
    ]);
  });
});

describe("parseAuthEnv: OAuth providers", () => {
  test.each([
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  ])("requires %s", (name) => {
    expect(
      expectErrors(parseAuthEnv({ ...LOCAL_ENV, [name]: undefined })),
    ).toEqual([`${name} is not set.`]);
    expect(expectErrors(parseAuthEnv({ ...LOCAL_ENV, [name]: " " }))).toEqual([
      `${name} is not set.`,
    ]);
  });

  test.each(["GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"])(
    "rejects whitespace in %s without printing it",
    (name) => {
      const errors = expectErrors(
        parseAuthEnv({ ...LOCAL_ENV, [name]: `${GITHUB_SECRET}\n` }),
      );
      expect(errors).toEqual([
        `${name} must not contain spaces or control characters.`,
      ]);
    },
  );

  test("requires a Google web client ID", () => {
    expect(
      expectErrors(
        parseAuthEnv({ ...LOCAL_ENV, GOOGLE_CLIENT_ID: "fake-google-client" }),
      ),
    ).toEqual([
      "GOOGLE_CLIENT_ID must be a web client ID ending in .apps.googleusercontent.com.",
    ]);
  });

  test("reports every missing provider variable at once", () => {
    const errors = expectErrors(
      parseAuthEnv({
        NODE_ENV: "development",
        BETTER_AUTH_SECRET: SECRET,
        BETTER_AUTH_URL: "http://localhost:3000",
      }),
    );
    expect(errors).toEqual([
      "GITHUB_CLIENT_ID is not set.",
      "GITHUB_CLIENT_SECRET is not set.",
      "GOOGLE_CLIENT_ID is not set.",
      "GOOGLE_CLIENT_SECRET is not set.",
    ]);
  });
});

describe("parseAuthEnv: refused variables", () => {
  test.each(["BETTER_AUTH_TELEMETRY", "BETTER_AUTH_TELEMETRY_ENDPOINT"])(
    "refuses %s",
    (name) => {
      expect(expectErrors(parseAuthEnv({ ...LOCAL_ENV, [name]: "1" }))).toEqual(
        [expect.stringMatching(new RegExp(`^${name} must not be set\\.`))],
      );
    },
  );

  test("refuses TEST in production, but allows it elsewhere", () => {
    expect(
      expectErrors(parseAuthEnv({ ...PRODUCTION_ENV, TEST: "true" })),
    ).toEqual([
      expect.stringMatching(
        /^TEST must not be set when NODE_ENV is production/,
      ),
    ]);
    expect(parseAuthEnv({ ...LOCAL_ENV, TEST: "true" }).ok).toBe(true);
  });

  test("refuses secrets behind the NEXT_PUBLIC_ prefix, naming them without values", () => {
    const errors = expectErrors(
      parseAuthEnv({
        ...LOCAL_ENV,
        NEXT_PUBLIC_GITHUB_CLIENT_SECRET: GITHUB_SECRET,
        NEXT_PUBLIC_BETTER_AUTH_SECRET: SECRET,
        NEXT_PUBLIC_SITE_NAME: "AI Specification Studio",
      }),
    );
    expect(errors).toEqual([
      expect.stringMatching(
        /^NEXT_PUBLIC_BETTER_AUTH_SECRET must not be set\./,
      ),
      expect.stringMatching(
        /^NEXT_PUBLIC_GITHUB_CLIENT_SECRET must not be set\./,
      ),
    ]);
  });
});

describe("parseAuthEnv: diagnostics", () => {
  test("never includes secret values, even when every rule fails", () => {
    const errors = expectErrors(
      parseAuthEnv({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "a".repeat(40),
        BETTER_AUTH_SECRETS: SECRET,
        BETTER_AUTH_URL: `http://${GITHUB_SECRET}@localhost:3000/${SECRET}`,
        BETTER_AUTH_TRUSTED_ORIGINS: `https://${GOOGLE_SECRET}.example.com/path`,
        GITHUB_CLIENT_ID: GITHUB_ID,
        GITHUB_CLIENT_SECRET: `${GITHUB_SECRET} `,
        GOOGLE_CLIENT_ID: "not-a-web-client",
        GOOGLE_CLIENT_SECRET: `${GOOGLE_SECRET}\t`,
        NEXT_PUBLIC_GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
      }),
    );
    expect(errors.length).toBeGreaterThanOrEqual(7);
    expect(errors.join("\n")).not.toContain("a".repeat(40));
  });

  test("returns errors instead of throwing", () => {
    expect(() =>
      parseAuthEnv({ BETTER_AUTH_URL: "http://[bad", BETTER_AUTH_SECRET: "x" }),
    ).not.toThrow();
  });
});
