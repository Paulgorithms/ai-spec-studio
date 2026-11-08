// SAMPLE DATA. Fictional projects and specifications for the starter pages,
// until workspaces are backed by a database. Every page that shows these
// records labels them "Sample data".
//
// To replace it, keep the types and change getProjects() and
// getSpecifications() to read from the real source; pages only call these
// functions and the helpers in dashboard.ts. Dates are fixed ISO strings, never
// generated from the clock, so prerendered pages stay identical between builds.

import type { SpecStatus } from "@/lib/spec-status";

export type Project = {
  id: string;
  name: string;
  description: string;
};

export type Specification = {
  // Stable, human-readable key shown in lists, such as "SPEC-007".
  id: string;
  title: string;
  summary: string;
  projectId: Project["id"];
  status: SpecStatus;
  updatedAt: string; // ISO 8601, UTC
};

const SAMPLE_PROJECTS: readonly Project[] = [
  {
    id: "billing-service",
    name: "Billing Service Redesign",
    description:
      "Move invoicing and payment retries onto one event-driven service.",
  },
  {
    id: "mobile-onboarding",
    name: "Mobile Onboarding",
    description: "A guided first-run flow for the iOS and Android apps.",
  },
  {
    id: "developer-platform",
    name: "Developer Platform API",
    description: "Public REST API, webhooks, and API keys for partners.",
  },
];

const SAMPLE_SPECIFICATIONS: readonly Specification[] = [
  {
    id: "SPEC-001",
    title: "Invoice PDF export",
    summary: "Generate a downloadable PDF for every finalized invoice.",
    projectId: "billing-service",
    status: "approved",
    updatedAt: "2026-10-06T14:20:00Z",
  },
  {
    id: "SPEC-002",
    title: "Payment retry schedule",
    summary: "Retry failed card payments on days 1, 3, and 7 before dunning.",
    projectId: "billing-service",
    status: "approved",
    updatedAt: "2026-10-09T09:05:00Z",
  },
  {
    id: "SPEC-003",
    title: "Proration on plan changes",
    summary: "Credit unused time when a customer upgrades mid-cycle.",
    projectId: "billing-service",
    status: "in-review",
    updatedAt: "2026-11-02T16:40:00Z",
  },
  {
    id: "SPEC-004",
    title: "Tax calculation by region",
    summary: "Apply VAT, GST, and US sales tax from the billing address.",
    projectId: "billing-service",
    status: "draft",
    updatedAt: "2026-11-05T11:15:00Z",
  },
  {
    id: "SPEC-005",
    title: "Welcome checklist",
    summary: "Five setup tasks shown on first launch, with progress saved.",
    projectId: "mobile-onboarding",
    status: "approved",
    updatedAt: "2026-10-14T10:30:00Z",
  },
  {
    id: "SPEC-006",
    title: "Push notification opt-in",
    summary: "Ask for notification permission after the first saved item.",
    projectId: "mobile-onboarding",
    status: "approved",
    updatedAt: "2026-10-17T13:00:00Z",
  },
  {
    id: "SPEC-007",
    title: "Profile setup flow",
    summary: "Collect name, role, and team size in three short screens.",
    projectId: "mobile-onboarding",
    status: "in-review",
    updatedAt: "2026-10-29T15:45:00Z",
  },
  {
    id: "SPEC-008",
    title: "Offline first launch",
    summary: "Let the app open and show cached content without a connection.",
    projectId: "mobile-onboarding",
    status: "draft",
    updatedAt: "2026-11-04T08:50:00Z",
  },
  {
    id: "SPEC-009",
    title: "API key rotation",
    summary: "Issue a new key while the old one keeps working for 24 hours.",
    projectId: "developer-platform",
    status: "approved",
    updatedAt: "2026-10-21T12:10:00Z",
  },
  {
    id: "SPEC-010",
    title: "Webhook retry policy",
    summary: "Retry failed deliveries with backoff for up to three days.",
    projectId: "developer-platform",
    status: "in-review",
    updatedAt: "2026-11-03T17:25:00Z",
  },
  {
    id: "SPEC-011",
    title: "Rate limit headers",
    summary: "Return remaining quota and reset time on every response.",
    projectId: "developer-platform",
    status: "approved",
    updatedAt: "2026-10-24T09:40:00Z",
  },
  {
    id: "SPEC-012",
    title: "Partner sandbox environments",
    summary: "Give each partner an isolated sandbox with test data.",
    projectId: "developer-platform",
    status: "in-review",
    updatedAt: "2026-11-06T10:05:00Z",
  },
];

export function getProjects(): readonly Project[] {
  return SAMPLE_PROJECTS;
}

export function getSpecifications(): readonly Specification[] {
  return SAMPLE_SPECIFICATIONS;
}
