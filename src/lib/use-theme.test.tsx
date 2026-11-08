import { act, renderHook, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { THEME_ATTRIBUTE, setTheme } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";

const root = document.documentElement;

function ThemeLabel() {
  return <p>{useTheme()}</p>;
}

beforeEach(() => {
  root.setAttribute(THEME_ATTRIBUTE, "dark");
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useTheme", () => {
  test("reads the theme from <html>", () => {
    root.setAttribute(THEME_ATTRIBUTE, "light");

    const { result } = renderHook(() => useTheme());

    expect(result.current).toBe("light");
  });

  test("updates after setTheme", async () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe("dark");

    act(() => setTheme("light"));

    await waitFor(() => expect(result.current).toBe("light"));
  });

  test("updates when the attribute changes elsewhere, such as from another tab", async () => {
    const { result } = renderHook(() => useTheme());

    act(() => root.setAttribute(THEME_ATTRIBUTE, "light"));

    await waitFor(() => expect(result.current).toBe("light"));
  });

  test("renders the default on the server, whatever the document says", () => {
    root.setAttribute(THEME_ATTRIBUTE, "light");

    expect(renderToString(<ThemeLabel />)).toBe("<p>dark</p>");
  });

  test("hydrates server HTML without a mismatch, then shows the saved theme", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<ThemeLabel />);
    document.body.append(container);
    // The inline script switched the document to light before hydration.
    root.setAttribute(THEME_ATTRIBUTE, "light");
    const onRecoverableError = vi.fn();

    const reactRoot = await act(async () =>
      hydrateRoot(container, <ThemeLabel />, { onRecoverableError }),
    );

    await waitFor(() => expect(container.textContent).toBe("light"));
    expect(onRecoverableError).not.toHaveBeenCalled();

    act(() => reactRoot.unmount());
    container.remove();
  });
});
