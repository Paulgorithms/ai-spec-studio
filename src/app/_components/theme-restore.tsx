"use client";

import { useLayoutEffect } from "react";
import { restoreStoredTheme } from "@/lib/theme";

// A fallback for the root layout: when React renders the document in the
// browser instead of hydrating it, the <head> theme script doesn't run, so
// this re-applies the saved theme before the first paint. On normal loads the
// theme is already right and it changes nothing. Renders nothing.
export function ThemeRestore() {
  useLayoutEffect(() => {
    restoreStoredTheme();
  }, []);
  return null;
}
