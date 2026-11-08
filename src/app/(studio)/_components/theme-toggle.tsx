"use client";

import { InlineScript } from "@/components/inline-script";
import { setTheme, themePressedScript } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";
import { MoonIcon, SunIcon } from "./icons";

// A quick switch in the header. It's a toggle button named "Dark theme" and
// pressed while dark is on. The icon follows the page through CSS (dark: and
// light:). aria-pressed is corrected from the page's theme by the inline
// script right after the button, before the first paint, and then kept in sync
// by useTheme. suppressHydrationWarning lets React accept that corrected
// attribute. Settings has the full choice.
export function ThemeToggle() {
  const theme = useTheme();

  return (
    <>
      <button
        type="button"
        aria-label="Dark theme"
        aria-pressed={theme === "dark"}
        suppressHydrationWarning
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <MoonIcon className="hidden size-5 dark:block" />
        <SunIcon className="hidden size-5 light:block" />
      </button>
      <InlineScript html={themePressedScript} />
    </>
  );
}
