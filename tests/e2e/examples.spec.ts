import { expect, test } from "@playwright/test";

// Covers the disposable /examples routes. Delete this file along with
// src/app/examples when starting a real project.
test("examples index links to each example page", async ({ page }) => {
  await page.goto("/examples");
  await expect(page).toHaveTitle("Examples | Next.js Starter");

  await page.getByRole("link", { name: "Dynamic params" }).click();

  await expect(page).toHaveURL("/examples/dynamic-params");
  await expect(
    page.getByRole("heading", { level: 1, name: "Dynamic params" }),
  ).toBeVisible();
});

test("unknown example slug shows the not-found page", async ({ page }) => {
  // Not asserting a 404: loading.tsx starts streaming before notFound() runs,
  // which fixes the status at 200 (Next.js still adds a noindex meta tag).
  await page.goto("/examples/does-not-exist");

  await expect(
    page.getByRole("heading", { level: 1, name: "Page not found" }),
  ).toBeVisible();
});

test("error boundary catches a thrown error and recovers with retry", async ({
  page,
}) => {
  await page.goto("/examples/error");
  await page.getByRole("button", { name: "Throw an error" }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Something went wrong" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Try again" }).click();

  await expect(
    page.getByRole("button", { name: "Throw an error" }),
  ).toBeVisible();
});
