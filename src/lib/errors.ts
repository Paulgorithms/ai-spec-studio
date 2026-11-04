// Errors from Server Components reach error boundaries with a generic message
// in production, plus a `digest` that matches the server-side logs.
export function getErrorDigest(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof error.digest === "string"
  ) {
    return error.digest;
  }
  return undefined;
}
