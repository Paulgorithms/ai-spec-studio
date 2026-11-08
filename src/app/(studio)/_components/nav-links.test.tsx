import { render, screen } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CurrentSection } from "./current-section";
import { NavLinks } from "./nav-links";

vi.mock("next/navigation", () => ({ usePathname: vi.fn() }));

function atPath(pathname: string) {
  vi.mocked(usePathname).mockReturnValue(pathname);
}

afterEach(() => {
  vi.mocked(usePathname).mockReset();
});

describe("NavLinks", () => {
  test("links to every studio section", () => {
    atPath("/");
    render(<NavLinks />);

    expect(
      screen
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Dashboard", "/"],
      ["Projects", "/projects"],
      ["Specifications", "/specifications"],
      ["Settings", "/settings"],
    ]);
  });

  test.each([
    ["/", "Dashboard"],
    ["/projects", "Projects"],
    ["/projects/abc", "Projects"],
    ["/specifications", "Specifications"],
    ["/settings", "Settings"],
  ])("at %s marks only %s as the current page", (pathname, label) => {
    atPath(pathname);
    render(<NavLinks />);

    const current = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual([label]);
    expect(current[0].className).toContain("bg-surface-raised");
  });

  test("doesn't mark Projects as current at /projects-x", () => {
    atPath("/projects-x");
    render(<NavLinks />);

    expect(
      screen
        .getByRole("link", { name: "Projects" })
        .hasAttribute("aria-current"),
    ).toBe(false);
  });

  test("keeps the icons out of the accessible names", () => {
    atPath("/");
    render(<NavLinks />);

    for (const svg of document.querySelectorAll("svg")) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeTruthy();
  });

  test("gives every link a visible keyboard focus outline", () => {
    atPath("/");
    render(<NavLinks />);

    for (const link of screen.getAllByRole("link")) {
      expect(link.className).toContain("focus-visible:outline-ring");
    }
  });
});

describe("CurrentSection", () => {
  test("names the current section", () => {
    atPath("/specifications");
    render(<CurrentSection />);

    expect(screen.getByText("Specifications")).toBeTruthy();
  });

  test("renders nothing outside the studio sections", () => {
    atPath("/projects-x");
    const { container } = render(<CurrentSection />);

    expect(container.textContent).toBe("");
  });
});
