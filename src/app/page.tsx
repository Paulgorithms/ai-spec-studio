import { ButtonLink } from "@/components/button";
import { PageContainer } from "@/components/page-container";
import { siteConfig } from "@/lib/site";

const startingPoints = [
  {
    path: "src/app",
    description: "Routes, layouts, and route-private _components.",
  },
  {
    path: "src/components",
    description: "Shared UI used by more than one route.",
  },
  { path: "src/lib", description: "Data access, validation, and utilities." },
  {
    path: "CLAUDE.md",
    description: "Project conventions for people and AI agents.",
  },
];

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
      <section aria-labelledby="start-heading" className="flex flex-col gap-4">
        <h2 id="start-heading" className="text-lg font-medium">
          Where to start
        </h2>
        <ul className="flex flex-col gap-3">
          {startingPoints.map(({ path, description }) => (
            <li key={path} className="flex flex-col gap-1 sm:flex-row sm:gap-3">
              <code className="w-fit rounded bg-black/[.06] px-1.5 py-0.5 font-mono text-sm dark:bg-white/[.08]">
                {path}
              </code>
              <span className="text-zinc-600 dark:text-zinc-400">
                {description}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <ButtonLink href="/examples">View examples</ButtonLink>
    </PageContainer>
  );
}
