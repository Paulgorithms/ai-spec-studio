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
    expect(button.classList.contains("rounded-md")).toBe(true);
  });

  test("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  test("defaults to the primary variant at medium size", () => {
    render(<Button>Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });
    expect(button.classList.contains("bg-accent")).toBe(true);
    expect(button.classList.contains("text-on-accent")).toBe(true);
    expect(button.classList.contains("h-9")).toBe(true);
  });

  test.each([
    ["primary", "bg-accent", "not-disabled:hover:bg-accent-hover"],
    ["secondary", "bg-surface", "not-disabled:hover:bg-surface-hover"],
    ["ghost", "text-foreground", "not-disabled:hover:bg-surface-hover"],
    ["danger", "bg-danger-solid", "not-disabled:hover:bg-danger-solid-hover"],
  ] as const)(
    "applies the %s variant's fill and hover",
    (variant, fill, hover) => {
      render(<Button variant={variant}>Action</Button>);

      const button = screen.getByRole("button", { name: "Action" });
      expect(button.classList.contains(fill)).toBe(true);
      expect(button.classList.contains(hover)).toBe(true);
    },
  );

  test("only the secondary variant has a border", () => {
    render(
      <>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
      </>,
    );

    expect(
      screen
        .getByRole("button", { name: "Secondary" })
        .classList.contains("border"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Ghost" })
        .classList.contains("border"),
    ).toBe(false);
  });

  test.each([
    ["sm", "h-8", "px-3"],
    ["md", "h-9", "px-4"],
  ] as const)("applies the %s size", (size, height, padding) => {
    render(<Button size={size}>Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });
    expect(button.classList.contains(height)).toBe(true);
    expect(button.classList.contains(padding)).toBe(true);
  });

  test("has a visible keyboard focus outline in the ring color", () => {
    render(<Button>Save</Button>);

    const { classList } = screen.getByRole("button", { name: "Save" });
    expect(classList.contains("focus-visible:outline-2")).toBe(true);
    expect(classList.contains("focus-visible:outline-offset-2")).toBe(true);
    expect(classList.contains("focus-visible:outline-ring")).toBe(true);
  });

  test("when disabled, can't be clicked and shows the disabled styles", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    fireEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.classList.contains("disabled:opacity-50")).toBe(true);
    expect(button.classList.contains("disabled:cursor-not-allowed")).toBe(true);
  });

  test("is removed from the tab order when disabled", () => {
    render(<Button disabled>Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });
    button.focus();

    expect(document.activeElement).not.toBe(button);
  });
});

describe("ButtonLink", () => {
  test("renders a link to the given href", () => {
    render(<ButtonLink href="/examples">View examples</ButtonLink>);

    expect(
      screen.getByRole("link", { name: "View examples" }).getAttribute("href"),
    ).toBe("/examples");
  });

  test("stays a link, with no button role or type attribute", () => {
    render(<ButtonLink href="/examples">View examples</ButtonLink>);

    const link = screen.getByRole("link", { name: "View examples" });
    expect(link.tagName).toBe("A");
    expect(link.hasAttribute("type")).toBe(false);
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("accepts the same variants and sizes as Button", () => {
    render(
      <ButtonLink href="/examples" variant="secondary" size="sm">
        View examples
      </ButtonLink>,
    );

    const link = screen.getByRole("link", { name: "View examples" });
    expect(link.classList.contains("bg-surface")).toBe(true);
    expect(link.classList.contains("h-8")).toBe(true);
  });

  test("doesn't pass the style props through to the DOM", () => {
    render(
      <ButtonLink href="/examples" variant="ghost" size="sm">
        View examples
      </ButtonLink>,
    );

    const link = screen.getByRole("link", { name: "View examples" });
    expect(link.hasAttribute("variant")).toBe(false);
    expect(link.hasAttribute("size")).toBe(false);
  });
});
