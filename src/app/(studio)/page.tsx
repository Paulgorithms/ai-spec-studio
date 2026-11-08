import type { Metadata } from "next";
import { Badge } from "@/components/badge";
import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { PageHeader } from "@/components/page-header";
import { ProjectCard } from "@/components/project-card";
import { SpecificationList } from "@/components/specification-list";
import {
  getDashboardStats,
  getProjectSummaries,
  getSpecificationsWithProject,
} from "@/lib/dashboard";
import { getProjects, getSpecifications } from "@/lib/mock-data";

export const metadata: Metadata = { title: "Dashboard" };

const RECENT_SPECIFICATIONS = 5;
const RECENT_PROJECTS = 3;

export default function DashboardPage() {
  const projects = getProjects();
  const specifications = getSpecifications();
  const stats = getDashboardStats(projects, specifications);
  const recentSpecifications = getSpecificationsWithProject(
    projects,
    specifications,
    RECENT_SPECIFICATIONS,
  );
  const recentProjects = getProjectSummaries(
    projects,
    specifications,
    RECENT_PROJECTS,
  );

  const summary = [
    { label: "Projects", value: stats.projects },
    { label: "Specifications", value: stats.specifications },
    { label: "In review", value: stats.statusCounts["in-review"] },
    { label: "Approved", value: stats.statusCounts.approved },
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="An overview of your projects and their specifications."
        actions={<Badge tone="accent">Sample data</Badge>}
      />

      <section aria-labelledby="summary-heading">
        <h2 id="summary-heading" className="sr-only">
          Summary
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {summary.map(({ label, value }) => (
            <Card key={label}>
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">
                {value}
              </dd>
            </Card>
          ))}
        </dl>
      </section>

      <section
        aria-labelledby="recent-specifications-heading"
        className="flex flex-col gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            id="recent-specifications-heading"
            className="text-lg font-semibold tracking-tight text-foreground"
          >
            Recent specifications
          </h2>
          <ButtonLink href="/specifications" variant="secondary" size="sm">
            View all specifications
          </ButtonLink>
        </div>
        <Card>
          <SpecificationList specifications={recentSpecifications} />
        </Card>
      </section>

      <section
        aria-labelledby="recent-projects-heading"
        className="flex flex-col gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            id="recent-projects-heading"
            className="text-lg font-semibold tracking-tight text-foreground"
          >
            Recent projects
          </h2>
          <ButtonLink href="/projects" variant="secondary" size="sm">
            View all projects
          </ButtonLink>
        </div>
        {recentProjects.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {recentProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                headingLevel="h3"
              />
            ))}
          </div>
        ) : (
          <Card>
            <p className="text-sm text-muted-foreground">No projects yet.</p>
          </Card>
        )}
      </section>
    </>
  );
}
