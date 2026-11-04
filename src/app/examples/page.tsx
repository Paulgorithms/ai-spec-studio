import type { Metadata } from "next";
import Link from "next/link";
import { PageContainer } from "@/components/page-container";
import { getExamples } from "@/lib/examples";

export const metadata: Metadata = {
  title: "Examples",
};

const boundaryDemos = [
  {
    href: "/examples/does-not-exist",
    label: "Unknown example",
    description: "notFound() renders the root not-found page.",
  },
  {
    href: "/examples/error",
    label: "Error boundary",
    description: "error.tsx catches a thrown error and recovers with retry().",
  },
];

export default async function ExamplesPage() {
  const examples = await getExamples();
  const pageDemos = examples.map(({ slug, title, summary }) => ({
    href: `/examples/${slug}`,
    label: title,
    description: summary,
  }));

  return (
    <PageContainer>
      <div className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Examples</h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Working patterns for this template. Delete{" "}
          <code className="font-mono">src/app/examples</code> when you start a
          real project.
        </p>
      </div>
      <ExampleList heading="Pages" items={pageDemos} />
      <ExampleList heading="Boundaries" items={boundaryDemos} />
    </PageContainer>
  );
}

function ExampleList({
  heading,
  items,
}: {
  heading: string;
  items: { href: string; label: string; description: string }[];
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-medium">{heading}</h2>
      <ul className="flex flex-col gap-4">
        {items.map(({ href, label, description }) => (
          <li key={href} className="flex flex-col gap-1">
            <Link
              href={href}
              className="w-fit font-medium underline underline-offset-4"
            >
              {label}
            </Link>
            <span className="text-zinc-600 dark:text-zinc-400">
              {description}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
