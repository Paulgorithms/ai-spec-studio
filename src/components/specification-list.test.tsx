import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SpecificationList } from "@/components/specification-list";
import type { SpecificationWithProject } from "@/lib/dashboard";

const specs: SpecificationWithProject[] = [
  {
    id: "SPEC-012",
    title: "Partner sandbox environments",
    summary: "Give each partner an isolated sandbox.",
    projectId: "developer-platform",
    projectName: "Developer Platform API",
    status: "in-review",
    updatedAt: "2026-11-06T10:05:00Z",
  },
  {
    id: "SPEC-001",
    title: "Invoice PDF export",
    summary: "Generate a PDF for every invoice.",
    projectId: "billing-service",
    projectName: "Billing Service Redesign",
    status: "approved",
    updatedAt: "2026-10-06T14:20:00Z",
  },
];

describe("SpecificationList", () => {
  test("lists each specification with its ID, title, project, date, and status", () => {
    render(<SpecificationList specifications={specs} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const first = within(items[0]);
    expect(first.getByText("SPEC-012")).toBeTruthy();
    expect(first.getByText("Partner sandbox environments")).toBeTruthy();
    expect(first.getByText(/Developer Platform API/)).toBeTruthy();
    expect(first.getByText("Nov 6, 2026").getAttribute("datetime")).toBe(
      "2026-11-06T10:05:00Z",
    );
    expect(first.getByText("In review")).toBeTruthy();
    expect(within(items[1]).getByText("Approved")).toBeTruthy();
  });

  test("keeps the given order", () => {
    render(<SpecificationList specifications={specs} />);

    expect(
      screen
        .getAllByRole("listitem")
        .map((item) => item.querySelector(".font-mono")?.textContent),
    ).toEqual(["SPEC-012", "SPEC-001"]);
  });

  test("shows summaries only when asked", () => {
    const { rerender } = render(<SpecificationList specifications={specs} />);
    expect(
      screen.queryByText("Give each partner an isolated sandbox."),
    ).toBeNull();

    rerender(<SpecificationList specifications={specs} showSummary />);
    expect(
      screen.getByText("Give each partner an isolated sandbox."),
    ).toBeTruthy();
  });

  test("shows an empty message instead of an empty list", () => {
    render(
      <SpecificationList specifications={[]} emptyMessage="Nothing here." />,
    );

    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText("Nothing here.")).toBeTruthy();
  });

  test("has no links or buttons, since specification pages don't exist yet", () => {
    render(<SpecificationList specifications={specs} />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
