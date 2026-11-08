"use client";

import { useEffect } from "react";
import { Button } from "@/components/button";
import { PageHeader } from "@/components/page-header";
import { getErrorDigest } from "@/lib/errors";

// Catches errors in studio pages. It renders inside the studio layout's
// <main>, so the sidebar and header stay usable; errors in the layout itself
// still reach the root error.tsx.
export default function StudioError({
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

  return (
    <div className="flex flex-col items-start gap-6">
      <PageHeader
        title="Something went wrong"
        description="This page couldn't be loaded. Try again, and if it keeps happening, let us know."
      />
      {digest && (
        <p className="text-sm text-muted-foreground">
          Error ID: <code className="font-mono">{digest}</code>
        </p>
      )}
      {/* retry() re-fetches and re-renders the segment; reset() only re-renders. */}
      <Button onClick={() => retry()}>Try again</Button>
    </div>
  );
}
