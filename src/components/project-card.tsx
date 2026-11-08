import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/card";
import { describeStatusCounts, type ProjectSummary } from "@/lib/dashboard";
import { formatDate } from "@/lib/format";

// A project's name, description, and specification summary. It isn't a link:
// project pages don't exist yet, and a card that looks clickable but goes
// nowhere would mislead.
export function ProjectCard({
  project,
  headingLevel = "h3",
}: {
  project: ProjectSummary;
  headingLevel?: "h2" | "h3";
}) {
  const statuses = describeStatusCounts(project.statusCounts);

  return (
    <Card>
      <CardHeader>
        <CardTitle as={headingLevel}>{project.name}</CardTitle>
        <CardDescription>{project.description}</CardDescription>
      </CardHeader>
      <dl className="mt-auto flex flex-col gap-2 border-t border-border pt-4 text-sm">
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Specifications</dt>
          <dd className="text-foreground tabular-nums">
            {project.specificationCount > 0
              ? project.specificationCount
              : "None yet"}
          </dd>
        </div>
        {statuses && (
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Status</dt>
            <dd className="text-foreground">{statuses}</dd>
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Last updated</dt>
          <dd className="text-foreground">
            {project.lastUpdatedAt ? (
              <time dateTime={project.lastUpdatedAt}>
                {formatDate(project.lastUpdatedAt)}
              </time>
            ) : (
              "Not yet"
            )}
          </dd>
        </div>
      </dl>
    </Card>
  );
}
