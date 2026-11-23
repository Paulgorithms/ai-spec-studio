import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

const SOURCE = readFileSync(new URL("./client.ts", import.meta.url), "utf8");

describe("authClient", () => {
  test("exposes the documented OAuth, session, and sign-out API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { authClient } = await import("@/lib/auth/client");
    expect(authClient.signIn.social).toBeTypeOf("function");
    expect(authClient.signOut).toBeTypeOf("function");
    expect(authClient.useSession).toBeTypeOf("function");
    // Creating the client doesn't call the server.
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test("reads no environment variables and imports no server code", () => {
    expect(SOURCE).not.toMatch(/process\.env/);
    expect(SOURCE).not.toMatch(/SECRET|DATABASE|CLIENT_ID/);
    expect(SOURCE).not.toMatch(/from\s+["'][^"']*(server|db)[^"']*["']/);
  });
});
