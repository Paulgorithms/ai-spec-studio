import { render } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { THEME_ATTRIBUTE, THEME_STORAGE_KEY } from "@/lib/theme";
import { ThemeRestore } from "./theme-restore";

const root = document.documentElement;

beforeEach(() => {
  root.setAttribute(THEME_ATTRIBUTE, "dark");
  localStorage.clear();
});

describe("ThemeRestore", () => {
  test("restores a saved light theme when it mounts, and renders nothing", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");

    const { container } = render(<ThemeRestore />);

    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    expect(container.innerHTML).toBe("");
  });

  test("leaves the default dark theme alone", () => {
    render(<ThemeRestore />);

    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
  });
});
