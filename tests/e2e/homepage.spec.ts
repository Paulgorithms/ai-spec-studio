import { expect, test } from "@playwright/test";

// Smoke test for the home page.
// Update these assertions when the homepage gets real content.
test("homepage loads and shows the project name and description", async ({
  page,
}) => {
  const response = await page.goto("/");

  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle("AI Specification Studio");
  await expect(
    page.getByRole("heading", { level: 1, name: "AI Specification Studio" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "A standalone, AI-powered, specification-driven software development platform.",
    ),
  ).toBeVisible();
});
