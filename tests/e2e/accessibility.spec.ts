import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Automated WCAG 2.2 A/AA checks with axe. They catch a useful subset of
// problems (contrast, names, roles, ARIA, landmarks, target size), not all of
// them: keyboard flow, focus order, and screen reader announcements are
// covered by the other specs and by manual checks.

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const pages = [
  { name: "Dashboard", path: "/" },
  { name: "Projects", path: "/projects" },
  { name: "Specifications", path: "/specifications" },
  { name: "Settings", path: "/settings" },
];

async function useTheme(page: Page, theme: "dark" | "light") {
  if (theme === "light") {
    await page.addInitScript(() =>
      localStorage.setItem("ai-spec-studio:theme", "light"),
    );
  }
}

async function scan(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  // One readable line per failing element, so a failure says what to fix.
  const violations = results.violations.flatMap((violation) =>
    violation.nodes.map(
      (node) =>
        `${violation.id} (${violation.impact}): ${node.target.join(" ")} - ${node.failureSummary?.split("\n").join(" ")}`,
    ),
  );
  const ranRules = [
    ...results.passes,
    ...results.incomplete,
    ...results.violations,
  ].map((rule) => rule.id);
  return { violations, ranRules };
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} theme`, () => {
    for (const { name, path } of pages) {
      test(`${name} has no WCAG 2.2 AA violations`, async ({ page }) => {
        await useTheme(page, theme);
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        const { violations, ranRules } = await scan(page);

        expect(violations).toEqual([]);
        // Contrast and WCAG 2.2 target size actually ran on this page.
        expect(ranRules).toContain("color-contrast");
        expect(ranRules).toContain("target-size");
      });
    }

    test("the open mobile drawer has no WCAG 2.2 AA violations", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await useTheme(page, theme);
      await page.goto("/");
      await page.getByRole("button", { name: "Open navigation" }).click();
      await expect(
        page.getByRole("dialog", { name: "Navigation" }),
      ).toBeVisible();

      const { violations } = await scan(page);

      expect(violations).toEqual([]);
    });
  });
}
