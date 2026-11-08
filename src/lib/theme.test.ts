import { describe, expect, test } from "vitest";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  isTheme,
  parseTheme,
  themeInitScript,
} from "@/lib/theme";

describe("parseTheme", () => {
  test.each(["dark", "light"] as const)("keeps the known theme %s", (theme) => {
    expect(parseTheme(theme)).toBe(theme);
  });

  test.each([null, undefined, "", "purple", "Light", " dark", 1, {}])(
    "falls back to dark for the invalid value %j",
    (value) => {
      expect(parseTheme(value)).toBe("dark");
    },
  );
});

describe("isTheme", () => {
  test("accepts only the two themes", () => {
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("light")).toBe(true);
    expect(isTheme("system")).toBe(false);
    expect(isTheme(null)).toBe(false);
  });
});

describe("themeInitScript", () => {
  test("defaults to dark", () => {
    expect(DEFAULT_THEME).toBe("dark");
  });

  test("is valid JavaScript", () => {
    // Parses without running it; a syntax error here would break every page.
    expect(() => new Function(themeInitScript)).not.toThrow();
  });

  test("reads the namespaced storage key", () => {
    expect(themeInitScript).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });
});
