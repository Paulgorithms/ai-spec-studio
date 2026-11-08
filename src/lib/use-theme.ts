import { useSyncExternalStore } from "react";
import {
  DEFAULT_THEME,
  THEME_ATTRIBUTE,
  canSaveTheme,
  getDocumentTheme,
  type Theme,
} from "@/lib/theme";

// The <html> attribute is the single source of truth, so watching it keeps
// React in step with every way the theme can change: the inline script on
// load, setTheme() in this tab, and `storage` events from other tabs.
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [THEME_ATTRIBUTE],
  });
  return () => observer.disconnect();
}

// The server can't see the saved preference, so it renders the default. During
// hydration React uses this value, then re-renders with the document's theme,
// which avoids a hydration mismatch. Prefer CSS (`dark:` variants) for what's
// visible on first paint, and use this hook for state such as aria labels.
function getServerSnapshot(): Theme {
  return DEFAULT_THEME;
}

// Call only from Client Components.
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getDocumentTheme, getServerSnapshot);
}

// Storage access doesn't change while a page is open, so there's nothing to
// subscribe to.
function subscribeToNothing(): () => void {
  return () => {};
}

// Whether the theme can be saved: true or false in the browser, and null on
// the server and during hydration, when it isn't known yet. Show nothing that
// depends on it while it's null.
export function useCanSaveTheme(): boolean | null {
  return useSyncExternalStore(subscribeToNothing, canSaveTheme, () => null);
}
