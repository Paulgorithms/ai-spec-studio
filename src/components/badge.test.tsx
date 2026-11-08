import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Badge } from "@/components/badge";
import { SpecStatusBadge } from "@/components/spec-status-badge";
import { SPEC_STATUSES } from "@/lib/spec-status";

describe("Badge", () => {
  test("defaults to the neutral tone", () => {
    render(<Badge>Sample data</Badge>);

    expect(screen.getByText("Sample data").className).toContain(
      "text-muted-foreground",
    );
  });

  test.each([
    ["neutral", "text-muted-foreground"],
    ["accent", "text-accent-text"],
    ["success", "text-success"],
    ["warning", "text-warning"],
    ["danger", "text-danger"],
  ] as const)("applies the %s tone", (tone, textClass) => {
    render(<Badge tone={tone}>Label</Badge>);

    expect(screen.getByText("Label").classList.contains(textClass)).toBe(true);
  });

  test("hides the decorative dot from screen readers", () => {
    render(<Badge>Label</Badge>);

    const dot = screen.getByText("Label").querySelector("span");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.textContent).toBe("");
  });
});

describe("SpecStatusBadge", () => {
  test.each([
    ["draft", "Draft", "text-muted-foreground"],
    ["in-review", "In review", "text-warning"],
    ["approved", "Approved", "text-success"],
  ] as const)("shows %s as the text %j", (status, label, textClass) => {
    render(<SpecStatusBadge status={status} />);

    const badge = screen.getByText(label);
    expect(badge.textContent).toBe(label);
    expect(badge.classList.contains(textClass)).toBe(true);
  });

  test("every status has a different visible label", () => {
    const { container } = render(
      <>
        {SPEC_STATUSES.map((status) => (
          <SpecStatusBadge key={status} status={status} />
        ))}
      </>,
    );

    const labels = [...container.children].map((el) => el.textContent);
    expect(labels.every((label) => label && label.trim().length > 0)).toBe(
      true,
    );
    expect(new Set(labels).size).toBe(SPEC_STATUSES.length);
  });
});
