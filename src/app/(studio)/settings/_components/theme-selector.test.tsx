import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { THEME_ATTRIBUTE, THEME_STORAGE_KEY } from "@/lib/theme";
import SettingsPage from "../page";
import { ThemeSelector } from "./theme-selector";

const root = document.documentElement;

beforeEach(() => {
  root.setAttribute(THEME_ATTRIBUTE, "dark");
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function radio(name: "Dark" | "Light") {
  return screen.getByRole("radio", { name: new RegExp(`^${name}`) });
}

describe("ThemeSelector", () => {
  test("is a labeled radio group with Dark and Light", () => {
    render(<ThemeSelector />);

    const group = screen.getByRole("group", { name: "Theme" });
    expect(group.tagName).toBe("FIELDSET");
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(radio("Dark")).toBeTruthy();
    expect(radio("Light")).toBeTruthy();
  });

  test("checks the current theme", () => {
    root.setAttribute(THEME_ATTRIBUTE, "light");
    render(<ThemeSelector />);

    expect((radio("Light") as HTMLInputElement).checked).toBe(true);
    expect((radio("Dark") as HTMLInputElement).checked).toBe(false);
  });

  test("switching applies the theme, saves it, and checks the new option", async () => {
    render(<ThemeSelector />);

    fireEvent.click(radio("Light"));

    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    await waitFor(() =>
      expect((radio("Light") as HTMLInputElement).checked).toBe(true),
    );
  });

  test("follows a change made elsewhere, such as another tab", async () => {
    render(<ThemeSelector />);

    act(() => root.setAttribute(THEME_ATTRIBUTE, "light"));

    await waitFor(() =>
      expect((radio("Light") as HTMLInputElement).checked).toBe(true),
    );
  });

  test("says the choice is saved when storage works", () => {
    render(<ThemeSelector />);

    expect(
      screen.getByRole("group", {
        name: "Theme",
        description:
          "Your choice is saved in this browser and applies to every open tab.",
      }),
    ).toBeTruthy();
  });

  test("never claims saving when storage is blocked, even before a choice", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Access denied", "SecurityError");
    });
    render(<ThemeSelector />);

    const group = screen.getByRole("group", { name: "Theme" });
    expect(group.textContent).not.toContain("is saved");
    expect(
      screen.getByRole("group", {
        name: "Theme",
        description:
          "This browser blocks saving, so your choice applies only until you reload.",
      }),
    ).toBeTruthy();

    // The theme still applies for this visit.
    fireEvent.click(radio("Light"));
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("light");
  });

  test("switches to the not-saved message if a later save fails", () => {
    render(<ThemeSelector />);
    // Storage worked when checked, then fails (for example, it's full).
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    fireEvent.click(radio("Light"));

    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    expect(
      screen.getByRole("group", {
        name: "Theme",
        description:
          "This browser blocks saving, so your choice applies only until you reload.",
      }),
    ).toBeTruthy();
  });

  test("says nothing about saving in the server HTML", () => {
    const html = renderToString(<ThemeSelector />);

    expect(html).not.toContain("is saved");
    expect(html).not.toContain("blocks saving");
    // The message element is there, empty, ready to be filled after hydration.
    expect(html).toMatch(/<p id="[^"]+" class="min-h-5[^"]*"><\/p>/);
  });

  test("leaves no probe value behind in storage", () => {
    render(<ThemeSelector />);

    expect(Object.keys(localStorage)).toEqual([]);
  });

  test("describes each option and marks the selection with more than color", () => {
    render(<ThemeSelector />);

    expect(radio("Dark").closest("label")?.textContent).toContain(
      "The default.",
    );
    // A check mark, shown by the theme variant, sits in each option.
    expect(
      radio("Dark")
        .closest("label")
        ?.querySelector('[aria-hidden="true"].dark\\:flex'),
    ).toBeTruthy();
    expect(
      radio("Light")
        .closest("label")
        ?.querySelector('[aria-hidden="true"].light\\:flex'),
    ).toBeTruthy();
  });

  test("shows a visible focus outline on the option being focused", () => {
    render(<ThemeSelector />);

    expect(radio("Dark").closest("label")?.className).toContain(
      "has-focus-visible:outline-ring",
    );
  });
});

describe("Settings page", () => {
  test("has a Settings heading and the Appearance section with the theme choice", () => {
    render(<SettingsPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Appearance" }),
    ).toBeTruthy();
    expect(screen.getByRole("group", { name: "Theme" })).toBeTruthy();
  });

  test("doesn't show account, billing, or other unrelated settings", () => {
    render(<SettingsPage />);

    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getAllByRole("heading")).toHaveLength(2);
  });
});
