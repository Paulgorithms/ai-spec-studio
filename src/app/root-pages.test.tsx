import { fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import ErrorPage from "./error";
import GlobalError from "./global-error";
import NotFound from "./not-found";

// The root boundaries render outside the studio shell. Which errors reach
// them is Next.js's job and is checked in the browser; these tests cover what
// each one shows and how it recovers.

afterEach(() => {
  vi.restoreAllMocks();
});

function quietConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("root error.tsx", () => {
  test("shows a heading, an explanation, and Try again, which calls retry", () => {
    quietConsoleError();
    const retry = vi.fn();
    render(<ErrorPage error={new Error("boom")} retry={retry} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Something went wrong" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/An unexpected error occurred/).className,
    ).toContain("text-muted-foreground");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  test("shows the digest when there is one, and only then", () => {
    quietConsoleError();
    const { unmount } = render(
      <ErrorPage
        error={Object.assign(new Error("boom"), { digest: "d1g3st" })}
        retry={vi.fn()}
      />,
    );
    expect(screen.getByText("d1g3st").tagName).toBe("CODE");
    unmount();

    render(<ErrorPage error={new Error("boom")} retry={vi.fn()} />);
    expect(screen.queryByText(/Error ID/)).toBeNull();
  });

  test("renders a single <main>, since it replaces the page outside any shell", () => {
    quietConsoleError();
    const { container } = render(
      <ErrorPage error={new Error("boom")} retry={vi.fn()} />,
    );

    expect(container.querySelectorAll("main")).toHaveLength(1);
  });

  test("logs the error", () => {
    const consoleError = quietConsoleError();
    const error = new Error("boom");
    render(<ErrorPage error={error} retry={vi.fn()} />);

    expect(consoleError).toHaveBeenCalledWith(error);
  });
});

describe("root global-error.tsx", () => {
  // It renders its own <html>, so check its server HTML.
  function serverHtml(error: unknown) {
    return renderToString(<GlobalError error={error} retry={vi.fn()} />);
  }

  test("renders a full document in the default dark theme", () => {
    const html = serverHtml(new Error("boom"));

    expect(html).toMatch(/^<html lang="en" data-theme="dark"/);
    expect(html).toContain("bg-background");
    expect(html).toContain("<title>Something went wrong</title>");
    expect(html).toMatch(/<h1[^>]*>Something went wrong<\/h1>/);
    expect(html).toMatch(/<button type="button"[^>]*>Try again<\/button>/);
    expect(html.match(/<main/g)).toHaveLength(1);
  });

  test("shows the digest when there is one", () => {
    const html = serverHtml(
      Object.assign(new Error("boom"), { digest: "d1g3st" }),
    );

    expect(html).toContain('<code class="font-mono">d1g3st</code>');
  });

  test("leaves the error ID out without a digest", () => {
    expect(serverHtml(new Error("boom"))).not.toContain("Error ID");
  });
});

describe("root not-found.tsx", () => {
  test("explains the page doesn't exist and links home", () => {
    render(<NotFound />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Go home" }).getAttribute("href"),
    ).toBe("/");
  });
});
