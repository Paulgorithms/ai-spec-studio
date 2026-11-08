import { SpecStatusBadge } from "@/components/spec-status-badge";
import type { SpecificationWithProject } from "@/lib/dashboard";
import { formatDate } from "@/lib/format";

// Specifications as a list: ID, title, project, last update, and status as a
// labeled badge. Rows stack on narrow screens. Like ProjectCard, rows aren't
// links until specification pages exist.
export function SpecificationList({
  specifications,
  showSummary = false,
  emptyMessage = "No specifications yet.",
}: {
  specifications: readonly SpecificationWithProject[];
  showSummary?: boolean;
  emptyMessage?: string;
}) {
  if (specifications.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {specifications.map((spec) => (
        <li
          key={spec.id}
          className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-mono text-xs text-muted-foreground">
                {spec.id}
              </span>
              <span className="text-sm font-medium text-foreground">
                {spec.title}
              </span>
            </p>
            {showSummary && (
              <p className="text-sm text-muted-foreground">{spec.summary}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {spec.projectName} · Updated{" "}
              <time dateTime={spec.updatedAt}>
                {formatDate(spec.updatedAt)}
              </time>
            </p>
          </div>
          <SpecStatusBadge status={spec.status} className="sm:mt-0.5" />
        </li>
      ))}
    </ul>
  );
}
