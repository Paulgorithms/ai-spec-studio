// The review states a specification moves through, and the labels people see.

export const SPEC_STATUSES = ["draft", "in-review", "approved"] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

export const SPEC_STATUS_LABELS: Record<SpecStatus, string> = {
  draft: "Draft",
  "in-review": "In review",
  approved: "Approved",
};
