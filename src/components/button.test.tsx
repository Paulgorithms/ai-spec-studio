import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { Button, ButtonLink } from "@/components/button";

describe("Button", () => {
  test("defaults to type=button so it doesn't submit forms", () => {
    render(<Button>Save</Button>);

    expect(
      screen.getByRole("button", { name: "Save" }).getAttribute("type"),
    ).toBe("button");
  });

  test("keeps an explicit type", () => {
    render(<Button type="submit">Send</Button>);

    expect(
      screen.getByRole("button", { name: "Send" }).getAttribute("type"),
    ).toBe("submit");
  });

  test("adds a custom className to the base classes", () => {
    render(<Button className="mt-4">Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });
    expect(button.classList.contains("mt-4")).toBe(true);
    expect(button.classList.contains("rounded-full")).toBe(true);
  });

  test("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("ButtonLink", () => {
  test("renders a link to the given href", () => {
    render(<ButtonLink href="/examples">View examples</ButtonLink>);

    expect(
      screen.getByRole("link", { name: "View examples" }).getAttribute("href"),
    ).toBe("/examples");
  });
});
