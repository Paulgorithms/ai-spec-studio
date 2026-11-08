"use client";

import { useEffect } from "react";
import { Button } from "@/components/button";
import { PageContainer } from "@/components/page-container";
import { getErrorDigest } from "@/lib/errors";
import { useTheme } from "@/lib/use-theme";
import { ThemeRestore } from "./_components/theme-restore";
import "./globals.css";

// Replaces the root layout when it throws, so it renders its own <html> and
// <body>, imports the global styles, and can't export `metadata`.
export default function GlobalError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => {
    // Replace with an error reporting service when the project has one.
    console.error(error);
  }, [error]);

  const digest = getErrorDigest(error);
  // Keeps the theme already on the page (dark, or a saved light preference)
  // instead of resetting the <html> attribute when this replaces the layout.
  // When this page is the whole document, the root layout's <head> script
  // never ran, so ThemeRestore below re-applies a saved theme before paint
  // and useTheme follows the attribute it sets.
  const theme = useTheme();

  return (
    <html
      lang="en"
      data-theme={theme}
      suppressHydrationWarning
      className="h-full bg-background antialiased"
    >
      <body className="flex min-h-full flex-col font-sans text-foreground">
        <ThemeRestore />
        <title>Something went wrong</title>
        <PageContainer className="justify-center">
          <div className="flex flex-col gap-4">
            <h1 className="text-3xl font-semibold tracking-tight">
              Something went wrong
            </h1>
            <p className="text-lg text-muted-foreground">
              The app failed to load. Try again, and if it keeps happening, let
              us know.
            </p>
            {digest && (
              <p className="text-sm text-muted-foreground">
                Error ID: <code className="font-mono">{digest}</code>
              </p>
            )}
          </div>
          <Button onClick={() => retry()}>Try again</Button>
        </PageContainer>
      </body>
    </html>
  );
}
