import { expect, test } from "@playwright/test";

for (const viewport of [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("the first Tab shows a skip link that moves focus to the content", async ({
      page,
    }) => {
      await page.goto("/projects");
      const skipLink = page.getByRole("link", { name: "Skip to content" });

      await page.keyboard.press("Tab");
      await expect(skipLink).toBeFocused();
      await expect(skipLink).toBeVisible();

      await page.keyboard.press("Enter");
      await expect(page.getByRole("main")).toBeFocused();
      await expect(page).toHaveURL("/projects#main");
    });
  });
}
