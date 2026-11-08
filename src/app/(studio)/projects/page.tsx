import type { Metadata } from "next";
import { Badge } from "@/components/badge";
import { Card } from "@/components/card";
import { PageHeader } from "@/components/page-header";
import { ProjectCard } from "@/components/project-card";
import { getProjectSummaries } from "@/lib/dashboard";
import { getProjects, getSpecifications } from "@/lib/mock-data";

export const metadata: Metadata = { title: "Projects" };

export default function ProjectsPage() {
  const projects = getProjectSummaries(getProjects(), getSpecifications());

  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project groups the specifications for one product area, most recently updated first."
        actions={<Badge tone="accent">Sample data</Badge>}
      />
      {projects.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} headingLevel="h2" />
          ))}
        </div>
      ) : (
        <Card>
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        </Card>
      )}
    </>
  );
}
