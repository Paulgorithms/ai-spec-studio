import { expect, test } from "@playwright/test";

test("the dashboard loads with its title, heading, and sample data label", async ({
  page,
}) => {
  const response = await page.goto("/");

  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle("Dashboard | AI Specification Studio");
  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboard" }),
  ).toBeVisible();
  await expect(page.getByRole("main").getByText("Sample data")).toBeVisible();
});

test("the summary shows the sample totals", async ({ page }) => {
  await page.goto("/");
  const summary = page.getByRole("region", { name: "Summary" });

  // Terms and their values, in matching order.
  await expect(summary.getByRole("term")).toHaveText([
    "Projects",
    "Specifications",
    "In review",
    "Approved",
  ]);
  await expect(summary.getByRole("definition")).toHaveText([
    "3",
    "12",
    "4",
    "6",
  ]);
});

test("recent specifications show the five newest, with status text", async ({
  page,
}) => {
  await page.goto("/");
  const section = page.getByRole("region", { name: "Recent specifications" });

  await expect(section.getByRole("listitem")).toHaveCount(5);
  await expect(section.getByRole("listitem").first()).toContainText("SPEC-012");
  await expect(section.getByRole("listitem").first()).toContainText(
    "In review",
  );
});

test("recent projects show each sample project", async ({ page }) => {
  await page.goto("/");
  const section = page.getByRole("region", { name: "Recent projects" });

  for (const name of [
    "Developer Platform API",
    "Billing Service Redesign",
    "Mobile Onboarding",
  ]) {
    await expect(
      section.getByRole("heading", { level: 3, name }),
    ).toBeVisible();
  }
});

test("View all specifications opens the Specifications page", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("link", { name: "View all specifications" }).click();

  await expect(page).toHaveURL("/specifications");
  await expect(
    page.getByRole("heading", { level: 1, name: "Specifications" }),
  ).toBeVisible();
});

test("View all projects opens the Projects page", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("link", { name: "View all projects" }).click();

  await expect(page).toHaveURL("/projects");
  await expect(
    page.getByRole("heading", { level: 1, name: "Projects" }),
  ).toBeVisible();
});
