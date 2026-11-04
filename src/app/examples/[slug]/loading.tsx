import { PageContainer } from "@/components/page-container";

export default function Loading() {
  return (
    <PageContainer>
      <p role="status" className="text-lg text-zinc-600 dark:text-zinc-400">
        Loading example…
      </p>
    </PageContainer>
  );
}
