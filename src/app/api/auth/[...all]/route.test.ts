import { beforeEach, describe, expect, test, vi } from "vitest";

// The auth instance is mocked: these tests check the route's wiring only.
const mocks = vi.hoisted(() => {
  const handler = vi.fn<(request: Request) => Promise<Response>>(
    async () => new Response("handled"),
  );
  const getAuth = vi.fn(() => ({ handler }));
  return { handler, getAuth };
});

vi.mock("@/lib/auth/server", () => ({ getAuth: mocks.getAuth }));

async function loadRoute() {
  return import("./route");
}

beforeEach(() => {
  vi.resetModules();
  mocks.getAuth.mockClear();
  mocks.handler.mockClear();
});

describe("/api/auth/[...all]", () => {
  test("exports only the GET and POST handlers", async () => {
    const route = await loadRoute();
    expect(Object.keys(route).sort()).toEqual(["GET", "POST"]);
    expect(route.GET).toBeTypeOf("function");
    expect(route.POST).toBeTypeOf("function");
  });

  test("exports no route segment config (the route stays dynamic and public)", async () => {
    const route: Record<string, unknown> = await loadRoute();
    for (const name of [
      "dynamic",
      "revalidate",
      "fetchCache",
      "runtime",
      "generateStaticParams",
    ]) {
      expect(route).not.toHaveProperty(name);
    }
  });

  test("doesn't create the auth instance at import time", async () => {
    await loadRoute();
    expect(mocks.getAuth).not.toHaveBeenCalled();
  });

  test.each(["GET", "POST"] as const)(
    "%s passes the request to the Better Auth handler",
    async (method) => {
      const route = await loadRoute();
      const request = new Request(
        "https://studio.example.com/api/auth/callback/github?code=fake&state=fake",
        { method },
      );
      const response = await route[method](request);
      expect(await response.text()).toBe("handled");
      expect(mocks.getAuth).toHaveBeenCalledTimes(1);
      expect(mocks.handler).toHaveBeenCalledWith(request);
    },
  );

  test("propagates configuration errors instead of answering", async () => {
    mocks.getAuth.mockImplementationOnce(() => {
      throw new Error("The authentication configuration is invalid.");
    });
    const route = await loadRoute();
    await expect(
      route.GET(new Request("https://studio.example.com/api/auth/get-session")),
    ).rejects.toThrow("The authentication configuration is invalid.");
    expect(mocks.handler).not.toHaveBeenCalled();
  });
});
