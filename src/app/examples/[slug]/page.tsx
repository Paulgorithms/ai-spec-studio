import Link from "next/link";
import { notFound } from "next/navigation";
import { PageContainer } from "@/components/page-container";
import { getExample } from "@/lib/examples";

// Without generateStaticParams, params are request-time data, so this page
// renders inside the Suspense boundary from the sibling loading.tsx.
export default async function ExamplePage({
  params,
}: PageProps<"/examples/[slug]">) {
  const { slug } = await params;
  const example = await getExample(slug);

  if (!example) {
    notFound();
  }

  return (
    <PageContainer>
      <div className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          {example.title}
        </h1>
        <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          {example.summary}
        </p>
      </div>
      <Link
        href="/examples"
        className="w-fit font-medium underline underline-offset-4"
      >
        Back to examples
      </Link>
    </PageContainer>
  );
}
