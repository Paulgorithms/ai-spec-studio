import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  canSaveTheme,
  getDocumentTheme,
  getStoredTheme,
  restoreStoredTheme,
  setTheme,
  themeInitScript,
  themePressedScript,
  themeRadioScript,
} from "@/lib/theme";

// Runs in jsdom (.tsx) because the script and setTheme work on the real
// document and localStorage.

const root = document.documentElement;
const storageListeners: EventListenerOrEventListenerObject[] = [];

// Runs the inline script the way the browser does on page load, and keeps
// its `storage` listener so each test can remove it afterwards.
function runInitScript() {
  const addEventListener = vi.spyOn(window, "addEventListener");
  new Function(themeInitScript)();
  for (const [type, listener] of addEventListener.mock.calls) {
    if (type === "storage") storageListeners.push(listener);
  }
  addEventListener.mockRestore();
}

function dispatchStorage(key: string | null) {
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

beforeEach(() => {
  // The server-rendered starting point.
  root.setAttribute(THEME_ATTRIBUTE, "dark");
  localStorage.clear();
});

afterEach(() => {
  for (const listener of storageListeners.splice(0)) {
    window.removeEventListener("storage", listener);
  }
  vi.restoreAllMocks();
});

describe("theme init script", () => {
  test("stays dark with no saved preference", () => {
    runInitScript();

    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
  });

  test("applies a saved light preference", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");

    runInitScript();

    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("light");
  });

  test("falls back to dark for an invalid saved value", () => {
    root.setAttribute(THEME_ATTRIBUTE, "light");
    localStorage.setItem(THEME_STORAGE_KEY, "purple");

    runInitScript();

    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
  });

  test("keeps dark without throwing when storage access is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Access denied", "SecurityError");
    });

    expect(() => runInitScript()).not.toThrow();
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
  });

  test("follows a change made in another tab", () => {
    runInitScript();

    localStorage.setItem(THEME_STORAGE_KEY, "light");
    dispatchStorage(THEME_STORAGE_KEY);
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("light");

    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    dispatchStorage(THEME_STORAGE_KEY);
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
  });

  test("resets to dark when another tab clears storage", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    runInitScript();

    localStorage.clear();
    dispatchStorage(null);

    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
  });

  test("ignores changes to other storage keys", () => {
    runInitScript();
    // Set without an event, then announce an unrelated key.
    localStorage.setItem(THEME_STORAGE_KEY, "light");

    dispatchStorage("some-other-key");

    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
  });
});

describe("setTheme", () => {
  test("applies the theme, saves it, and reports it saved", () => {
    expect(setTheme("light")).toBe(true);

    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  test("still applies the theme when saving fails, and reports it unsaved", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    let saved: boolean | undefined;
    expect(() => {
      saved = setTheme("light");
    }).not.toThrow();
    expect(saved).toBe(false);
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("light");
  });
});

describe("getDocumentTheme", () => {
  test("reads the attribute on <html>", () => {
    root.setAttribute(THEME_ATTRIBUTE, "light");

    expect(getDocumentTheme()).toBe("light");
  });

  test("treats a missing or unknown attribute as dark", () => {
    root.removeAttribute(THEME_ATTRIBUTE);
    expect(getDocumentTheme()).toBe("dark");

    root.setAttribute(THEME_ATTRIBUTE, "sepia");
    expect(getDocumentTheme()).toBe("dark");
  });
});

// The control scripts read document.currentScript, which the browser sets
// while an inline script runs. Here the server HTML is built by hand and
// currentScript is pointed at the script element that follows the control.
function runAfter(html: string, script: string) {
  const container = document.createElement("div");
  container.innerHTML = `${html}<script></script>`;
  document.body.append(container);
  const scriptElement = container.querySelector("script");
  vi.spyOn(document, "currentScript", "get").mockReturnValue(scriptElement);
  new Function(script)();
  return container;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("themePressedScript", () => {
  const serverButton =
    '<button aria-label="Dark theme" aria-pressed="true"></button>';

  test("unpresses the Dark theme toggle when the page is light", () => {
    root.setAttribute(THEME_ATTRIBUTE, "light");

    const container = runAfter(serverButton, themePressedScript);

    expect(
      container.querySelector("button")?.getAttribute("aria-pressed"),
    ).toBe("false");
  });

  test("keeps it pressed when the page is dark", () => {
    const container = runAfter(serverButton, themePressedScript);

    expect(
      container.querySelector("button")?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("does nothing, without throwing, if there's no element before it", () => {
    vi.spyOn(document, "currentScript", "get").mockReturnValue(null);

    expect(() => new Function(themePressedScript)()).not.toThrow();
  });
});

describe("themeRadioScript", () => {
  const serverRadios =
    '<div><input type="radio" name="theme" value="dark" checked><input type="radio" name="theme" value="light"></div>';

  function checkedValue(container: HTMLElement) {
    return container.querySelector<HTMLInputElement>("input:checked")?.value;
  }

  test("checks Light when the page is light", () => {
    root.setAttribute(THEME_ATTRIBUTE, "light");

    expect(checkedValue(runAfter(serverRadios, themeRadioScript))).toBe(
      "light",
    );
  });

  test("leaves Dark checked when the page is dark", () => {
    expect(checkedValue(runAfter(serverRadios, themeRadioScript))).toBe("dark");
  });

  test("treats an unknown page theme as dark", () => {
    root.setAttribute(THEME_ATTRIBUTE, "sepia");

    expect(checkedValue(runAfter(serverRadios, themeRadioScript))).toBe("dark");
  });
});

describe("canSaveTheme", () => {
  test("is true when storage can be written, and leaves nothing behind", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");

    expect(canSaveTheme()).toBe(true);
    expect(Object.keys(localStorage)).toEqual([THEME_STORAGE_KEY]);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  test("is false when writing throws, without throwing itself", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Access denied", "SecurityError");
    });

    expect(canSaveTheme()).toBe(false);
  });
});

describe("getStoredTheme", () => {
  test("reads a saved theme", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(getStoredTheme()).toBe("light");
  });

  test("falls back to dark for nothing saved, an invalid value, or blocked storage", () => {
    expect(getStoredTheme()).toBe("dark");

    localStorage.setItem(THEME_STORAGE_KEY, "purple");
    expect(getStoredTheme()).toBe("dark");

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Access denied", "SecurityError");
    });
    expect(getStoredTheme()).toBe("dark");
  });
});

describe("restoreStoredTheme", () => {
  test("re-applies a saved light theme that the page lost", () => {
    // What a client-side render of the root layout leaves behind.
    root.setAttribute(THEME_ATTRIBUTE, "dark");
    localStorage.setItem(THEME_STORAGE_KEY, "light");

    restoreStoredTheme();

    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("light");
  });

  test("changes nothing when the page already matches", () => {
    root.setAttribute(THEME_ATTRIBUTE, "light");
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    const setAttribute = vi.spyOn(root, "setAttribute");

    restoreStoredTheme();

    expect(setAttribute).not.toHaveBeenCalled();
  });

  test("keeps dark when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Access denied", "SecurityError");
    });

    expect(() => restoreStoredTheme()).not.toThrow();
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
  });
});

describe("control scripts", () => {
  test("are constant strings with no element ids, so a CSP hash stays stable", () => {
    for (const script of [themePressedScript, themeRadioScript]) {
      expect(script).not.toMatch(/getElementById/);
      expect(() => new Function(script)).not.toThrow();
    }
  });
});
