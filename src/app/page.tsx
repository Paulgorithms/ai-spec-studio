import { PageContainer } from "@/components/page-container";
import { siteConfig } from "@/lib/site";

export default function Home() {
  return (
    <PageContainer className="justify-center">
      <div className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          {siteConfig.name}
        </h1>
        <p className="max-w-xl text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          {siteConfig.description}
        </p>
      </div>
    </PageContainer>
  );
}
