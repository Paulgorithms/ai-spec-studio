// Loads .env.local for the database scripts, when it exists.
//
// A missing file (ENOENT) is fine: CI and other shells set the variables
// directly, and the scripts' own checks then decide whether they're enough.
// Every other failure fails closed, by a fixed reason only: never the file's
// contents, a value, or a message that could quote one.
//
// The result matches process.loadEnvFile(): the same parser (util.parseEnv,
// which loadEnvFile uses), the same byte order mark handling (kept, so it
// becomes part of the first name), and the same precedence (a variable
// already set in the environment, even to "", wins). It differs only where
// loadEnvFile would continue silently:
// - loadEnvFile reports an unreadable file (EACCES) as ENOENT. This reads
//   with readFileSync, which reports the real code.
// - A .env.local symbolic link whose target is missing also reads as ENOENT;
//   it's rejected, not treated as no file.
// - Invalid UTF-8 and NUL bytes are rejected instead of loaded as mangled
//   values.
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { parseEnv } from "node:util";

export const LOCAL_ENV_FILE = ".env.local";

export type LocalEnvResult =
  { ok: true; source: "file" | "none" } | { ok: false; reason: string };

export type LocalEnvOptions = {
  path?: string;
  // Defaults to process.env; tests pass a plain object.
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => Buffer;
  lstat?: (path: string) => Pick<Stats, "isSymbolicLink">;
};

const ERROR_CODE = /^(?:E[A-Z0-9]{2,20}|ERR_[A-Z0-9_]{1,40})$/;

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    ERROR_CODE.test(error.code)
  ) {
    return error.code;
  }
  return "unknown error";
}

// After readFile's ENOENT: is there really nothing at the path?
function checkMissing(
  path: string,
  lstat: NonNullable<LocalEnvOptions["lstat"]>,
): LocalEnvResult {
  let entry: Pick<Stats, "isSymbolicLink">;
  try {
    entry = lstat(path);
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT"
      ? { ok: true, source: "none" }
      : { ok: false, reason: code };
  }
  // Something is there: a dangling link, or a file that appeared since the
  // read. Either way, don't run without it.
  return {
    ok: false,
    reason: entry.isSymbolicLink() ? "broken symbolic link" : "ENOENT",
  };
}

export function loadLocalEnv(options: LocalEnvOptions = {}): LocalEnvResult {
  const {
    path = LOCAL_ENV_FILE,
    env = process.env,
    readFile = (file: string) => readFileSync(file),
    lstat = (file: string) => lstatSync(file),
  } = options;

  let bytes: Buffer;
  try {
    bytes = readFile(path);
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT"
      ? checkMissing(path, lstat)
      : { ok: false, reason: code };
  }

  let text: string;
  try {
    // ignoreBOM keeps a byte order mark in the text, as loadEnvFile does.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return { ok: false, reason: "invalid UTF-8" };
  }
  if (text.includes("\0")) return { ok: false, reason: "NUL byte" };

  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(text) as Record<string, string>;
  } catch (error) {
    return { ok: false, reason: `parse failed (${errorCode(error)})` };
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(env, key)) env[key] = value;
  }
  return { ok: true, source: "file" };
}
