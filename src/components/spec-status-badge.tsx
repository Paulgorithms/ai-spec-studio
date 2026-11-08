import { Badge, type BadgeTone } from "@/components/badge";
import { SPEC_STATUS_LABELS, type SpecStatus } from "@/lib/spec-status";

const statusTones: Record<SpecStatus, BadgeTone> = {
  draft: "neutral",
  "in-review": "warning",
  approved: "success",
};

// Always shows the status as text, so it doesn't depend on color.
export function SpecStatusBadge({
  status,
  className,
}: {
  status: SpecStatus;
  className?: string;
}) {
  return (
    <Badge tone={statusTones[status]} className={className}>
      {SPEC_STATUS_LABELS[status]}
    </Badge>
  );
}
