import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { THEME_ATTRIBUTE, THEME_STORAGE_KEY } from "@/lib/theme";
import { ThemeToggle } from "./theme-toggle";

const root = document.documentElement;

beforeEach(() => {
  root.setAttribute(THEME_ATTRIBUTE, "dark");
  localStorage.clear();
});

describe("ThemeToggle", () => {
  test("is a 'Dark theme' toggle button, pressed while dark is on", () => {
    render(<ThemeToggle />);

    const toggle = screen.getByRole("button", { name: "Dark theme" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  test("switches to light and back, saving each choice", async () => {
    render(<ThemeToggle />);
    const toggle = screen.getByRole("button", { name: "Dark theme" });

    fireEvent.click(toggle);
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-pressed")).toBe("false"),
    );

    fireEvent.click(toggle);
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-pressed")).toBe("true"),
    );
  });

  test("follows a change made elsewhere", async () => {
    render(<ThemeToggle />);

    act(() => root.setAttribute(THEME_ATTRIBUTE, "light"));

    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Dark theme" })
          .getAttribute("aria-pressed"),
      ).toBe("false"),
    );
  });

  test("shows the icon for the active theme through CSS, so it's right before hydration", () => {
    render(<ThemeToggle />);

    const icons = screen.getByRole("button").querySelectorAll("svg");
    expect([...icons].map((svg) => svg.getAttribute("class"))).toEqual([
      "hidden size-5 dark:block",
      "hidden size-5 light:block",
    ]);
  });
});
