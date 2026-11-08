import { render, screen, within } from "@testing-library/react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import StudioError from "./error";
import StudioLayout from "./layout";

vi.mock("next/navigation", () => ({ usePathname: vi.fn() }));

beforeEach(() => {
  vi.mocked(usePathname).mockReturnValue("/projects");
  // jsdom has no matchMedia; the drawer uses it to close on a resize to desktop.
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderShell(children: ReactNode) {
  return render(
    <StudioLayout params={Promise.resolve({})}>{children}</StudioLayout>,
  );
}

describe("studio layout", () => {
  test("has the skip link first, then the navigation, header, and one main", () => {
    const { container } = renderShell(<h1>Projects</h1>);

    const firstLink = container.querySelector("a");
    expect(firstLink?.textContent).toBe("Skip to content");
    expect(firstLink?.getAttribute("href")).toBe("#main");
    expect(screen.getAllByRole("navigation", { name: "Main" }).length).toBe(1);
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(screen.getByRole("main").id).toBe("main");
  });

  test("keeps the shell around the studio error page, with a single main", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = renderShell(
      <StudioError error={new Error("boom")} retry={vi.fn()} />,
    );

    // The error is the page content, inside <main>...
    const main = screen.getByRole("main");
    expect(
      within(main).getByRole("heading", {
        level: 1,
        name: "Something went wrong",
      }),
    ).toBeTruthy();
    expect(
      within(main).getByRole("button", { name: "Try again" }),
    ).toBeTruthy();
    // ...while the navigation stays available around it.
    expect(
      screen
        .getByRole("navigation", { name: "Main" })
        .querySelectorAll("a[href]"),
    ).toHaveLength(4);
    expect(container.querySelectorAll("main")).toHaveLength(1);
  });
});
