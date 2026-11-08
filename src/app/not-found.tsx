import type { Metadata } from "next";
import { ButtonLink } from "@/components/button";
import { PageContainer } from "@/components/page-container";

export const metadata: Metadata = {
  title: "Page not found",
};

// Handles notFound() calls and every URL that doesn't match a route.
export default function NotFound() {
  return (
    <PageContainer className="justify-center">
      <div className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          Page not found
        </h1>
        <p className="text-lg text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>
      </div>
      <ButtonLink href="/">Go home</ButtonLink>
    </PageContainer>
  );
}
