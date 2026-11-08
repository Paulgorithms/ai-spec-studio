// Theme state lives in one place: the `data-theme` attribute on <html>.
// The server always renders "dark"; the inline script below switches to a
// saved "light" preference before the first paint, and the same attribute
// drives the CSS tokens in globals.css and Tailwind's `dark:` variant.

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "dark";
export const THEME_ATTRIBUTE = "data-theme";
// Namespaced because localStorage is shared per origin, so other projects
// served on the same localhost port would otherwise read the same key.
export const THEME_STORAGE_KEY = "ai-spec-studio:theme";

export function isTheme(value: unknown): value is Theme {
  return (
    typeof value === "string" && (THEMES as readonly string[]).includes(value)
  );
}

// Anything that isn't a known theme (missing, empty, tampered) falls back to dark.
export function parseTheme(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_THEME;
}

// Runs synchronously in <head> during HTML parsing, before the first paint.
// - Applies the saved preference; with no storage access it leaves the
//   server-rendered "dark" in place.
// - Listens for `storage` events so other open tabs follow a change. The
//   event fires only in the tabs that didn't make the change, and with
//   key === null when storage is cleared, which resets to dark.
// It is plain ES5 with no dependencies because it runs before any bundle.
//
// Content Security Policy: this is an inline script, so a future CSP with a
// strict `script-src` blocks it unless it is allowed explicitly. A nonce
// requires dynamic rendering, which Next.js documents as incompatible with
// the prerendered static shell this project uses (Cache Components), so prefer
// a hash: the script is a constant, and adding its 'sha256-…' value to
// `script-src` keeps pages static. Regenerate the hash whenever this string
// changes. Never use 'unsafe-inline' to unblock it. If the script is blocked,
// pages still render correctly in dark; only the saved light preference and
// cross-tab sync stop working. The two control scripts below need the same
// treatment. CLAUDE.md has the full CSP notes.
export const themeInitScript = `(function(){var k=${JSON.stringify(THEME_STORAGE_KEY)},d=document.documentElement;function a(){try{d.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},localStorage.getItem(k)==="light"?"light":"dark")}catch(e){}}a();window.addEventListener("storage",function(e){if(e.key===k||e.key===null)a()})})()`;

// The theme controls' server HTML always describes dark, because the server
// can't see the saved preference. With a saved light theme, assistive
// technology would hear the wrong state until React hydrates. These scripts
// run right after a control is parsed (see InlineScript) and set its state
// from the page's theme, before the first paint. Each reads the element just
// before it (document.currentScript.previousElementSibling), so the strings are
// constant and a future CSP can allow them by hash, like themeInitScript.

// Corrects aria-pressed on the "Dark theme" toggle button just before it.
export const themePressedScript = `(function(){var s=document.currentScript,b=s&&s.previousElementSibling;if(b)b.setAttribute("aria-pressed",document.documentElement.getAttribute(${JSON.stringify(THEME_ATTRIBUTE)})==="light"?"false":"true")})()`;

// Checks the radio for the current theme inside the element just before it.
export const themeRadioScript = `(function(){var s=document.currentScript,g=s&&s.previousElementSibling,t=document.documentElement.getAttribute(${JSON.stringify(THEME_ATTRIBUTE)})==="light"?"light":"dark",r=g&&g.querySelector('input[type="radio"][value="'+t+'"]');if(r)r.checked=true})()`;

export function getDocumentTheme(): Theme {
  return parseTheme(document.documentElement.getAttribute(THEME_ATTRIBUTE));
}

// The saved preference, the same way themeInitScript reads it: anything other
// than a valid theme, or storage that can't be read, means dark.
export function getStoredTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

// Re-applies the saved preference when the page shows something else. That
// happens only when React renders the whole document in the browser instead
// of hydrating server HTML (for example the error fallback after a server
// rendering error), because the inline script in <head> never runs then and
// the layout's data-theme="dark" default wins. On normal loads it does nothing.
export function restoreStoredTheme(): void {
  const stored = getStoredTheme();
  if (getDocumentTheme() !== stored) {
    document.documentElement.setAttribute(THEME_ATTRIBUTE, stored);
  }
}

// Applies a theme to this tab right away and saves it for reloads and other
// tabs. Saving can fail (private mode, blocked storage); the theme still
// applies for this page view. Returns whether it was saved, so the UI can say
// when the choice won't last.
export function setTheme(theme: Theme): boolean {
  document.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    // Storage unavailable: keep the in-page theme only.
    return false;
  }
}

// Whether this browser lets the page save the theme. Blocked storage throws
// when it's read or written (private modes, site-data settings), so this tries
// a throwaway write. Browser only: the server can't know, so callers must not
// claim either answer before hydration (see useCanSaveTheme).
const STORAGE_PROBE_KEY = `${THEME_STORAGE_KEY}:probe`;

export function canSaveTheme(): boolean {
  try {
    localStorage.setItem(STORAGE_PROBE_KEY, "1");
    localStorage.removeItem(STORAGE_PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}
