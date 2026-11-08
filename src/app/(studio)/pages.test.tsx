import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import DashboardPage from "./page";
import ProjectsPage from "./projects/page";
import SpecificationsPage from "./specifications/page";

// These pages are synchronous Server Components that only read sample data,
// so they render in jsdom. Browser behavior is covered by the E2E tests.

describe("Dashboard", () => {
  test("has a Dashboard heading and a sample data label", () => {
    render(<DashboardPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Dashboard" }),
    ).toBeTruthy();
    expect(screen.getByText("Sample data")).toBeTruthy();
  });

  test("shows the summary values from the sample data", () => {
    render(<DashboardPage />);

    const summary = screen.getByRole("region", { name: "Summary" });
    const values = Object.fromEntries(
      within(summary)
        .getAllByRole("term")
        .map((term) => [
          term.textContent,
          term.nextElementSibling?.textContent,
        ]),
    );
    expect(values).toEqual({
      Projects: "3",
      Specifications: "12",
      "In review": "4",
      Approved: "6",
    });
  });

  test("lists the five most recent specifications", () => {
    render(<DashboardPage />);

    const section = screen.getByRole("region", {
      name: "Recent specifications",
    });
    expect(within(section).getAllByRole("listitem")).toHaveLength(5);
    expect(
      within(section).getByText("Partner sandbox environments"),
    ).toBeTruthy();
  });

  test("shows the recent projects as h3 cards", () => {
    render(<DashboardPage />);

    const section = screen.getByRole("region", { name: "Recent projects" });
    expect(
      within(section)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "Developer Platform API",
      "Billing Service Redesign",
      "Mobile Onboarding",
    ]);
  });

  test("links to the full lists with descriptive names", () => {
    render(<DashboardPage />);

    expect(
      screen
        .getByRole("link", { name: "View all specifications" })
        .getAttribute("href"),
    ).toBe("/specifications");
    expect(
      screen
        .getByRole("link", { name: "View all projects" })
        .getAttribute("href"),
    ).toBe("/projects");
  });

  test("keeps the heading order h1, then h2, then h3", () => {
    render(<DashboardPage />);

    const levels = screen
      .getAllByRole("heading")
      .map((heading) => Number(heading.tagName.slice(1)));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
    }
  });
});

describe("Projects page", () => {
  test("shows every sample project as an h2 card, labeled as sample data", () => {
    render(<ProjectsPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Projects" }),
    ).toBeTruthy();
    expect(screen.getByText("Sample data")).toBeTruthy();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual([
      "Developer Platform API",
      "Billing Service Redesign",
      "Mobile Onboarding",
    ]);
    // Each card's "Specifications" term is followed by its count.
    expect(
      screen
        .getAllByRole("term")
        .filter((term) => term.textContent === "Specifications")
        .map((term) => term.nextElementSibling?.textContent),
    ).toEqual(["4", "4", "4"]);
  });

  test("offers no create, edit, or delete controls", () => {
    render(<ProjectsPage />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("Specifications page", () => {
  test("lists all twelve sample specifications with a status summary", () => {
    render(<SpecificationsPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Specifications" }),
    ).toBeTruthy();
    expect(screen.getByText("Sample data")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(12);
    expect(
      screen.getByText("12 specifications: 2 draft, 4 in review, 6 approved"),
    ).toBeTruthy();
  });

  test("shows each status as text", () => {
    render(<SpecificationsPage />);

    expect(screen.getAllByText("Approved")).toHaveLength(6);
    expect(screen.getAllByText("In review")).toHaveLength(4);
    expect(screen.getAllByText("Draft")).toHaveLength(2);
  });

  test("shows each specification's summary and project", () => {
    render(<SpecificationsPage />);

    const item = screen
      .getAllByRole("listitem")
      .find((li) => li.textContent?.includes("SPEC-009"));
    expect(item?.textContent).toContain("API key rotation");
    expect(item?.textContent).toContain("Developer Platform API");
    expect(item?.textContent).toContain(
      "Issue a new key while the old one keeps working for 24 hours.",
    );
  });
});
