import { expect, test, type Page } from "@playwright/test";

// Below 1024px the sidebar is replaced by a menu button and a modal <dialog>.
test.use({ viewport: { width: 390, height: 844 } });

function drawer(page: Page) {
  return page.getByRole("dialog", { name: "Navigation" });
}

function menuButton(page: Page) {
  return page.getByRole("button", { name: "Open navigation" });
}

test("shows a menu button instead of the sidebar", async ({ page }) => {
  await page.goto("/");

  await expect(menuButton(page)).toBeVisible();
  await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  await expect(drawer(page)).toBeHidden();
});

test("the menu button opens the drawer and moves focus into it", async ({
  page,
}) => {
  await page.goto("/");

  await menuButton(page).click();

  await expect(drawer(page)).toBeVisible();
  await expect(
    drawer(page).getByRole("navigation", { name: "Main" }),
  ).toBeVisible();
  // Read the attribute directly: the button is inert while the modal is open.
  await expect(page.locator('[aria-haspopup="dialog"]')).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const focusInDrawer = await page.evaluate(() =>
    Boolean(document.activeElement?.closest("dialog[open]")),
  );
  expect(focusInDrawer).toBe(true);
});

test("Escape closes the drawer and returns focus to the menu button", async ({
  page,
}) => {
  await page.goto("/");
  await menuButton(page).click();
  await expect(drawer(page)).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(drawer(page)).toBeHidden();
  await expect(menuButton(page)).toBeFocused();
  await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
});

test("the close button closes the drawer and returns focus", async ({
  page,
}) => {
  await page.goto("/");
  await menuButton(page).click();

  await drawer(page).getByRole("button", { name: "Close navigation" }).click();

  await expect(drawer(page)).toBeHidden();
  await expect(menuButton(page)).toBeFocused();
});

test("clicking the backdrop closes the drawer", async ({ page }) => {
  await page.goto("/");
  await menuButton(page).click();
  await expect(drawer(page)).toBeVisible();

  // The drawer panel is 288px wide; the backdrop covers the rest.
  await page.mouse.click(370, 420);

  await expect(drawer(page)).toBeHidden();
});

test("clicking inside the drawer panel doesn't close it", async ({ page }) => {
  await page.goto("/");
  await menuButton(page).click();

  // Empty space below the links, inside the panel.
  await page.mouse.click(140, 700);

  await expect(drawer(page)).toBeVisible();
});

test("keyboard focus stays inside the open drawer", async ({ page }) => {
  await page.goto("/");
  await menuButton(page).click();
  await expect(drawer(page)).toBeVisible();

  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    // Focus may leave the page for the browser's own UI, which shows here as
    // <body>; it must never land on anything behind the modal.
    const outsideDrawer = await page.evaluate(() => {
      const el = document.activeElement;
      return Boolean(el && el !== document.body && !el.closest("dialog[open]"));
    });
    expect(outsideDrawer).toBe(false);
  }
});

test("the page behind the open drawer is inert", async ({ page }) => {
  await page.goto("/");
  await menuButton(page).click();
  await expect(drawer(page)).toBeVisible();

  const mainTookFocus = await page.evaluate(() => {
    const main = document.getElementById("main");
    main?.focus();
    return document.activeElement === main;
  });

  expect(mainTookFocus).toBe(false);
});

test("choosing a section navigates and closes the drawer", async ({ page }) => {
  await page.goto("/");
  await menuButton(page).click();

  await drawer(page).getByRole("link", { name: "Specifications" }).click();

  await expect(page).toHaveURL("/specifications");
  await expect(drawer(page)).toBeHidden();
  await expect(
    page.getByRole("heading", { level: 1, name: "Specifications" }),
  ).toBeVisible();
  await expect(page.getByRole("banner").getByRole("paragraph")).toHaveText(
    "Specifications",
  );

  await menuButton(page).click();
  await expect(
    drawer(page).getByRole("link", { name: "Specifications" }),
  ).toHaveAttribute("aria-current", "page");
});

test("widening the window to desktop closes the drawer", async ({ page }) => {
  await page.goto("/");
  await menuButton(page).click();
  await expect(drawer(page)).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 844 });

  await expect(drawer(page)).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

// Overflow at every width, in both themes, is checked in responsive.spec.ts.
