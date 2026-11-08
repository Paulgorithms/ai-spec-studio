import { expect, test } from "@playwright/test";

test("unmatched URL returns 404 and shows the not-found page", async ({
  page,
}) => {
  const response = await page.goto("/does-not-exist");

  expect(response?.status()).toBe(404);
  await expect(page).toHaveTitle(/Page not found/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Page not found" }),
  ).toBeVisible();
});

test("not-found page links back home", async ({ page }) => {
  await page.goto("/does-not-exist");
  await page.getByRole("link", { name: "Go home" }).click();

  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeVisible();
});
