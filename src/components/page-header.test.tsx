import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ButtonLink } from "@/components/button";
import { PageHeader } from "@/components/page-header";

describe("PageHeader", () => {
  test("renders the title as the page's h1", () => {
    render(<PageHeader title="Specifications" />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Specifications" }),
    ).toBeTruthy();
  });

  test("shows the description when given", () => {
    render(
      <PageHeader
        title="Specifications"
        description="Every specification across your projects."
      />,
    );

    expect(
      screen.getByText("Every specification across your projects."),
    ).toBeTruthy();
  });

  test("renders the actions", () => {
    render(
      <PageHeader
        title="Projects"
        actions={<ButtonLink href="/projects">View all</ButtonLink>}
      />,
    );

    expect(screen.getByRole("link", { name: "View all" })).toBeTruthy();
  });

  test("leaves out the description and actions when not given", () => {
    const { container } = render(<PageHeader title="Settings" />);

    expect(container.querySelectorAll("p")).toHaveLength(0);
    // The wrapper holds only the title block.
    expect(container.firstElementChild?.children).toHaveLength(1);
  });

  test("stacks on small screens and sits side by side from sm", () => {
    const { container } = render(<PageHeader title="Settings" />);

    const { classList } = container.firstElementChild as HTMLElement;
    expect(classList.contains("flex-col")).toBe(true);
    expect(classList.contains("sm:flex-row")).toBe(true);
  });
});
