import { expect, test } from "@playwright/test";

// Smoke test for the template's starter page.
// Update these assertions when the homepage gets real content.
test("homepage loads and shows the starter content", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle("Next.js Starter");
  await expect(
    page.getByRole("heading", { level: 1, name: "Next.js Starter" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Where to start" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "View examples" })).toBeVisible();
});
