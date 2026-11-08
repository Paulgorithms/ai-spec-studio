import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ProjectCard } from "@/components/project-card";
import type { ProjectSummary } from "@/lib/dashboard";

const project: ProjectSummary = {
  id: "billing-service",
  name: "Billing Service Redesign",
  description: "Move invoicing onto one service.",
  specificationCount: 4,
  statusCounts: { draft: 1, "in-review": 1, approved: 2 },
  lastUpdatedAt: "2026-11-05T11:15:00Z",
};

describe("ProjectCard", () => {
  test("shows the name as a heading, the description, and the summary", () => {
    render(<ProjectCard project={project} />);

    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "Billing Service Redesign",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Move invoicing onto one service.")).toBeTruthy();
    // The term already says "Specifications", so the value is just the count.
    const term = screen
      .getAllByRole("term")
      .find((element) => element.textContent === "Specifications");
    expect(term?.nextElementSibling?.textContent).toBe("4");
    expect(screen.getByText("1 draft, 1 in review, 2 approved")).toBeTruthy();
  });

  test("shows the last update as a machine-readable date", () => {
    render(<ProjectCard project={project} />);

    const time = screen.getByText("Nov 5, 2026");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("datetime")).toBe("2026-11-05T11:15:00Z");
  });

  test("uses the heading level it's given", () => {
    render(<ProjectCard project={project} headingLevel="h2" />);

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Billing Service Redesign",
      }),
    ).toBeTruthy();
  });

  test("isn't a link or a button, since project pages don't exist yet", () => {
    render(<ProjectCard project={project} />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("handles a project without specifications", () => {
    render(
      <ProjectCard
        project={{
          ...project,
          specificationCount: 0,
          statusCounts: { draft: 0, "in-review": 0, approved: 0 },
          lastUpdatedAt: null,
        }}
      />,
    );

    expect(screen.getByText("None yet")).toBeTruthy();
    expect(screen.getByText("Not yet")).toBeTruthy();
    expect(screen.queryByText("Status")).toBeNull();
  });
});
