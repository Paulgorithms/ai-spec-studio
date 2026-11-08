import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import StudioError from "./error";

afterEach(() => {
  vi.restoreAllMocks();
});

function renderError(error: unknown, retry = vi.fn()) {
  // The boundary logs the error; keep test output quiet and check the call.
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const view = render(<StudioError error={error} retry={retry} />);
  return { ...view, retry, consoleError };
}

describe("studio error boundary", () => {
  test("shows a heading and a way to retry", () => {
    const { retry } = renderError(new Error("boom"));

    expect(
      screen.getByRole("heading", { level: 1, name: "Something went wrong" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  test("renders inside the shell's <main> without adding its own", () => {
    const { container } = renderError(new Error("boom"));

    expect(container.querySelector("main")).toBeNull();
  });

  test("shows the error ID when the error has a digest", () => {
    renderError(Object.assign(new Error("boom"), { digest: "abc123" }));

    expect(screen.getByText("abc123").tagName).toBe("CODE");
  });

  test("leaves out the error ID without a digest", () => {
    renderError(new Error("boom"));

    expect(screen.queryByText(/Error ID/)).toBeNull();
  });

  test("logs the error", () => {
    const error = new Error("boom");
    const { consoleError } = renderError(error);

    expect(consoleError).toHaveBeenCalledWith(error);
  });
});
