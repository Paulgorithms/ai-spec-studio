import { describe, expect, test } from "vitest";
import { NAV_ITEMS, getActiveNavItem, isActiveNavItem } from "@/lib/navigation";

describe("NAV_ITEMS", () => {
  test("lists the four studio sections in order", () => {
    expect(NAV_ITEMS.map((item) => [item.label, item.href])).toEqual([
      ["Dashboard", "/"],
      ["Projects", "/projects"],
      ["Specifications", "/specifications"],
      ["Settings", "/settings"],
    ]);
  });

  test("has unique labels and hrefs", () => {
    expect(new Set(NAV_ITEMS.map((item) => item.label)).size).toBe(
      NAV_ITEMS.length,
    );
    expect(new Set(NAV_ITEMS.map((item) => item.href)).size).toBe(
      NAV_ITEMS.length,
    );
  });

  test("puts only Settings in the secondary group", () => {
    expect(
      NAV_ITEMS.filter((item) => item.group === "secondary").map(
        (item) => item.label,
      ),
    ).toEqual(["Settings"]);
  });
});

describe("isActiveNavItem", () => {
  test.each([
    ["/", "/", true],
    ["/projects", "/", false],
    ["/projects", "/projects", true],
    ["/projects/", "/projects", true],
    ["/projects/abc", "/projects", true],
    ["/projects/abc/specs", "/projects", true],
    ["/projects-x", "/projects", false],
    ["/projectsx", "/projects", false],
    ["/specifications", "/projects", false],
    ["/settings", "/settings", true],
    ["/settings-old", "/settings", false],
  ])("pathname %s against %s is %s", (pathname, href, expected) => {
    expect(isActiveNavItem(pathname, href)).toBe(expected);
  });
});

describe("getActiveNavItem", () => {
  test.each([
    ["/", "Dashboard"],
    ["/projects", "Projects"],
    ["/projects/abc", "Projects"],
    ["/specifications", "Specifications"],
    ["/settings", "Settings"],
  ])("finds the section for %s", (pathname, label) => {
    expect(getActiveNavItem(pathname)?.label).toBe(label);
  });

  test("finds nothing for a path outside the studio sections", () => {
    expect(getActiveNavItem("/projects-x")).toBeUndefined();
    expect(getActiveNavItem("/unknown")).toBeUndefined();
  });

  test("never marks more than one section active", () => {
    for (const pathname of [
      "/",
      "/projects",
      "/specifications/1",
      "/settings",
    ]) {
      expect(
        NAV_ITEMS.filter((item) => isActiveNavItem(pathname, item.href)),
      ).toHaveLength(1);
    }
  });
});
