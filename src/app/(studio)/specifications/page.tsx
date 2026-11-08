import type { Metadata } from "next";
import { Badge } from "@/components/badge";
import { Card } from "@/components/card";
import { PageHeader } from "@/components/page-header";
import { SpecificationList } from "@/components/specification-list";
import {
  countByStatus,
  describeStatusCounts,
  getSpecificationsWithProject,
} from "@/lib/dashboard";
import { pluralize } from "@/lib/format";
import { getProjects, getSpecifications } from "@/lib/mock-data";

export const metadata: Metadata = { title: "Specifications" };

export default function SpecificationsPage() {
  const specifications = getSpecificationsWithProject(
    getProjects(),
    getSpecifications(),
  );
  const statuses = describeStatusCounts(countByStatus(specifications));

  return (
    <>
      <PageHeader
        title="Specifications"
        description="Every specification across your projects, most recently updated first."
        actions={<Badge tone="accent">Sample data</Badge>}
      />
      <Card>
        {specifications.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {pluralize(specifications.length, "specification")}: {statuses}
          </p>
        )}
        <SpecificationList specifications={specifications} showSummary />
      </Card>
    </>
  );
}
