"use client";

import { useEffect } from "react";
import { Button } from "@/components/button";
import { PageContainer } from "@/components/page-container";
import { getErrorDigest } from "@/lib/errors";

export default function ErrorPage({
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
    <PageContainer className="justify-center">
      <div className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          Something went wrong
        </h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          An unexpected error occurred. Try again, and if it keeps happening,
          let us know.
        </p>
        {digest && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Error ID: <code className="font-mono">{digest}</code>
          </p>
        )}
      </div>
      {/* retry() re-fetches and re-renders the segment; reset() only re-renders. */}
      <Button onClick={() => retry()}>Try again</Button>
    </PageContainer>
  );
}
