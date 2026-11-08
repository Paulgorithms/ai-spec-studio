import { expect, test } from "@playwright/test";

// Desktop (1280px wide by default): the sidebar is the navigation.

const sections = [
  { label: "Projects", path: "/projects", heading: "Projects" },
  {
    label: "Specifications",
    path: "/specifications",
    heading: "Specifications",
  },
  { label: "Settings", path: "/settings", heading: "Settings" },
  { label: "Dashboard", path: "/", heading: "Dashboard" },
];

test("the sidebar lists every section and the menu button is hidden", async ({
  page,
}) => {
  await page.goto("/");

  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav).toBeVisible();
  for (const { label } of sections) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeHidden();
});

for (const { label, path, heading } of sections) {
  test(`the sidebar navigates to ${label}`, async ({ page }) => {
    // Start somewhere else so each click is a real client-side navigation.
    await page.goto(path === "/settings" ? "/projects" : "/settings");
    const nav = page.getByRole("navigation", { name: "Main" });

    await nav.getByRole("link", { name: label }).click();

    await expect(page).toHaveURL(path);
    await expect(
      page.getByRole("heading", { level: 1, name: heading }),
    ).toBeVisible();
    await expect(nav.getByRole("link", { name: label })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    // getByRole skips the closed drawer's links, which share the header's DOM.
    await expect(page.getByRole("banner").getByRole("paragraph")).toHaveText(
      label,
    );
  });
}

test("a direct visit marks the current section and sets the page title", async ({
  page,
}) => {
  await page.goto("/specifications");

  await expect(page).toHaveTitle("Specifications | AI Specification Studio");
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Specifications" }),
  ).toHaveAttribute("aria-current", "page");
});

test("the brand links to the dashboard", async ({ page }) => {
  await page.goto("/settings");

  await page.getByRole("link", { name: "AI Specification Studio" }).click();

  await expect(page).toHaveURL("/");
});

test("keyboard users can reach every sidebar link", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });

  // Skip link, brand, then the four sections in order.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  for (const label of ["Dashboard", "Projects", "Specifications", "Settings"]) {
    await page.keyboard.press("Tab");
    await expect(nav.getByRole("link", { name: label })).toBeFocused();
  }

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/settings");
});
