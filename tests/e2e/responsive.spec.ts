import { expect, test } from "@playwright/test";

const routes = ["/", "/projects", "/specifications", "/settings"];
const widths = [320, 390, 768, 1024, 1280];

for (const width of widths) {
  for (const theme of ["dark", "light"] as const) {
    test(`all pages fit at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      if (theme === "light") {
        await page.addInitScript(() =>
          localStorage.setItem("ai-spec-studio:theme", "light"),
        );
      }

      for (const path of routes) {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${path} overflows at ${width}px`).toBeLessThanOrEqual(
          0,
        );

        // The sidebar from 1024px up; the menu button below that.
        const desktop = width >= 1024;
        await expect(
          page.getByRole("navigation", { name: "Main" }),
        ).toBeVisible({ visible: desktop });
        await expect(
          page.getByRole("button", { name: "Open navigation" }),
        ).toBeVisible({ visible: !desktop });
      }
    });
  }
}
