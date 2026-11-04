import type { Metadata } from "next";
import { PageContainer } from "@/components/page-container";
import { ThrowErrorButton } from "./_components/throw-error-button";

export const metadata: Metadata = {
  title: "Error boundary",
};

export default function ErrorExamplePage() {
  return (
    <PageContainer>
      <div className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          Error boundary
        </h1>
        <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          The button throws during render. The nearest error.tsx (here, the root
          one) catches it, and &ldquo;Try again&rdquo; recovers with retry().
        </p>
      </div>
      <ThrowErrorButton />
    </PageContainer>
  );
}
