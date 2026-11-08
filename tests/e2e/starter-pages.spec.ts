import { expect, test } from "@playwright/test";

test("Projects lists the sample projects without dead controls", async ({
  page,
}) => {
  await page.goto("/projects");
  const main = page.getByRole("main");

  await expect(page).toHaveTitle("Projects | AI Specification Studio");
  await expect(main.getByText("Sample data")).toBeVisible();
  await expect(main.getByRole("heading", { level: 2 })).toHaveText([
    "Developer Platform API",
    "Billing Service Redesign",
    "Mobile Onboarding",
  ]);
  // Each card shows its count next to the "Specifications" term.
  await expect(
    main.getByRole("term").filter({ hasText: "Specifications" }),
  ).toHaveCount(3);
  await expect(
    main.getByRole("definition").filter({ hasText: /^4$/ }),
  ).toHaveCount(3);
  // No create, edit, or delete actions exist yet, so none are shown.
  await expect(main.getByRole("button")).toHaveCount(0);
  await expect(main.getByRole("link")).toHaveCount(0);
});

test("Specifications lists all sample specifications with their projects and statuses", async ({
  page,
}) => {
  await page.goto("/specifications");
  const main = page.getByRole("main");

  await expect(main.getByText("Sample data")).toBeVisible();
  await expect(main.getByRole("listitem")).toHaveCount(12);
  await expect(
    main.getByText("12 specifications: 2 draft, 4 in review, 6 approved"),
  ).toBeVisible();

  const rotation = main.getByRole("listitem").filter({ hasText: "SPEC-009" });
  await expect(rotation).toContainText("API key rotation");
  await expect(rotation).toContainText("Developer Platform API");
  await expect(rotation).toContainText("Approved");
  await expect(main.getByRole("button")).toHaveCount(0);
});

test("Settings shows the Appearance section with the theme choice", async ({
  page,
}) => {
  await page.goto("/settings");

  await expect(
    page.getByRole("heading", { level: 2, name: "Appearance" }),
  ).toBeVisible();
  const group = page.getByRole("group", { name: "Theme" });
  await expect(group.getByRole("radio")).toHaveCount(2);
  await expect(group.getByRole("radio", { name: /^Dark/ })).toBeChecked();
});
