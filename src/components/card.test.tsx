import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/card";

describe("Card", () => {
  test("composes a header, title, description, and content", () => {
    render(
      <Card data-testid="card">
        <CardHeader>
          <CardTitle>Billing service</CardTitle>
          <CardDescription>4 specifications</CardDescription>
        </CardHeader>
        <p>Updated Nov 2</p>
      </Card>,
    );

    expect(
      screen.getByRole("heading", { level: 3, name: "Billing service" }),
    ).toBeTruthy();
    const card = screen.getByTestId("card");
    expect(card.textContent).toBe(
      "Billing service4 specificationsUpdated Nov 2",
    );
  });

  test("works with content only", () => {
    render(<Card>Just content</Card>);

    expect(screen.getByText("Just content")).toBeTruthy();
  });

  test("uses the surface, border, and 8px radius tokens", () => {
    render(<Card>Content</Card>);

    const { classList } = screen.getByText("Content");
    expect(classList.contains("bg-surface")).toBe(true);
    expect(classList.contains("border-border")).toBe(true);
    expect(classList.contains("rounded-lg")).toBe(true);
  });

  test("lets the title use another heading level", () => {
    render(<CardTitle as="h2">Recent specifications</CardTitle>);

    expect(
      screen.getByRole("heading", { level: 2, name: "Recent specifications" }),
    ).toBeTruthy();
  });

  test("passes through attributes such as aria-labelledby", () => {
    render(
      <Card role="region" aria-labelledby="card-title">
        <CardTitle id="card-title">Projects</CardTitle>
      </Card>,
    );

    expect(screen.getByRole("region", { name: "Projects" })).toBeTruthy();
  });
});
