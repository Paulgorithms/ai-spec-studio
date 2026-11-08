// Summaries the starter pages show. Pure functions over the records passed in,
// so they work the same with sample data and, later, database results.

import type { Project, Specification } from "@/lib/mock-data";
import {
  SPEC_STATUSES,
  SPEC_STATUS_LABELS,
  type SpecStatus,
} from "@/lib/spec-status";

export type StatusCounts = Record<SpecStatus, number>;

export type DashboardStats = {
  projects: number;
  specifications: number;
  statusCounts: StatusCounts;
};

export type ProjectSummary = Project & {
  specificationCount: number;
  statusCounts: StatusCounts;
  // The most recent change to any of its specifications; null when it has none.
  lastUpdatedAt: string | null;
};

export type SpecificationWithProject = Specification & {
  projectName: string;
};

export function countByStatus(
  specifications: readonly Specification[],
): StatusCounts {
  const counts = Object.fromEntries(
    SPEC_STATUSES.map((status) => [status, 0]),
  ) as StatusCounts;
  for (const spec of specifications) counts[spec.status] += 1;
  return counts;
}

// "1 draft, 1 in review, 2 approved", leaving out statuses with no
// specifications. Empty when there are none at all.
export function describeStatusCounts(counts: StatusCounts): string {
  return SPEC_STATUSES.filter((status) => counts[status] > 0)
    .map(
      (status) =>
        `${counts[status]} ${SPEC_STATUS_LABELS[status].toLowerCase()}`,
    )
    .join(", ");
}

export function getDashboardStats(
  projects: readonly Project[],
  specifications: readonly Specification[],
): DashboardStats {
  return {
    projects: projects.length,
    specifications: specifications.length,
    statusCounts: countByStatus(specifications),
  };
}

// Newest first. ISO 8601 UTC strings sort correctly as text; the id breaks ties
// so the order never depends on the input order.
function byNewest(a: { updatedAt: string; id: string }, b: typeof a): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

// Adds each specification's project name, newest first. A specification whose
// project is missing is left out rather than shown with a blank project.
export function getSpecificationsWithProject(
  projects: readonly Project[],
  specifications: readonly Specification[],
  limit?: number,
): SpecificationWithProject[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return specifications
    .flatMap((spec) => {
      const projectName = names.get(spec.projectId);
      return projectName ? [{ ...spec, projectName }] : [];
    })
    .sort(byNewest)
    .slice(0, limit);
}

// Projects with their specification counts, most recently updated first.
// Projects without specifications go last, in their original order.
export function getProjectSummaries(
  projects: readonly Project[],
  specifications: readonly Specification[],
  limit?: number,
): ProjectSummary[] {
  const summaries = projects.map((project) => {
    const specs = specifications.filter(
      (spec) => spec.projectId === project.id,
    );
    const lastUpdatedAt = specs.reduce<string | null>(
      (latest, spec) =>
        latest === null || spec.updatedAt > latest ? spec.updatedAt : latest,
      null,
    );
    return {
      ...project,
      specificationCount: specs.length,
      statusCounts: countByStatus(specs),
      lastUpdatedAt,
    };
  });
  return summaries
    .map((summary, index) => ({ summary, index }))
    .sort((a, b) => {
      const [x, y] = [a.summary.lastUpdatedAt, b.summary.lastUpdatedAt];
      if (x === y) return a.index - b.index;
      if (x === null) return 1;
      if (y === null) return -1;
      return x < y ? 1 : -1;
    })
    .map(({ summary }) => summary)
    .slice(0, limit);
}
