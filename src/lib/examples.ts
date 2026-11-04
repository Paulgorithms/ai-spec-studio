// Example data for the /examples routes. Delete this file along with
// src/app/examples when starting a real project.
export type Example = {
  slug: string;
  title: string;
  summary: string;
};

const examples: Example[] = [
  {
    slug: "dynamic-params",
    title: "Dynamic params",
    summary:
      "This page awaits its params at request time. The loading.tsx next to it is the Suspense boundary that Cache Components requires for that.",
  },
  {
    slug: "shared-components",
    title: "Shared components",
    summary:
      "Pages and error boundaries share Button, ButtonLink, and PageContainer from src/components instead of repeating class lists.",
  },
];

export async function getExamples(): Promise<Example[]> {
  return examples;
}

export async function getExample(slug: string): Promise<Example | undefined> {
  return examples.find((example) => example.slug === slug);
}
