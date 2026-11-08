import { expect, test, type Page } from "@playwright/test";

// Dark is the default whatever the OS prefers, so every test here runs with a
// light OS preference to prove the page doesn't follow it.
test.use({ colorScheme: "light" });

const STORAGE_KEY = "ai-spec-studio:theme";

function html(page: Page) {
  return page.locator("html");
}

function themeRadio(page: Page, name: "Dark" | "Light") {
  return page
    .getByRole("group", { name: "Theme" })
    .getByRole("radio", { name: new RegExp(`^${name}`) });
}

function headerToggle(page: Page) {
  return page.getByRole("button", { name: "Dark theme" });
}

test("dark is the default, even when the OS prefers light", async ({
  page,
}) => {
  await page.goto("/");

  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await expect(html(page)).toHaveCSS("background-color", "rgb(9, 9, 11)");
  await expect(headerToggle(page)).toHaveAttribute("aria-pressed", "true");
});

test("Settings switches to light, and the choice survives a reload", async ({
  page,
}) => {
  await page.goto("/settings");

  // Click the option's text; the radio input itself is visually hidden.
  await page.getByText("Dark text on a light background.").click();

  await expect(html(page)).toHaveAttribute("data-theme", "light");
  await expect(html(page)).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(themeRadio(page, "Light")).toBeChecked();

  await page.reload();

  await expect(html(page)).toHaveAttribute("data-theme", "light");
  await expect(themeRadio(page, "Light")).toBeChecked();
  await expect(headerToggle(page)).toHaveAttribute("aria-pressed", "false");
});

test("the theme choice works from the keyboard", async ({ page }) => {
  await page.goto("/settings");
  const dark = themeRadio(page, "Dark");

  // Tab into the radio group: skip link, brand, 4 nav links, theme toggle, then
  // the checked radio.
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  await expect(dark).toBeFocused();
  // The focused option shows a visible outline on its card (the radio's label).
  const darkCard = page
    .getByRole("group", { name: "Theme" })
    .locator("label")
    .filter({ has: page.getByRole("radio", { name: /^Dark/ }) });
  await expect(darkCard).toHaveCSS("outline-style", "solid");

  await page.keyboard.press("ArrowDown");
  await expect(themeRadio(page, "Light")).toBeChecked();
  await expect(themeRadio(page, "Light")).toBeFocused();
  await expect(html(page)).toHaveAttribute("data-theme", "light");

  await page.keyboard.press("ArrowUp");
  await expect(dark).toBeChecked();
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
});

test("the header toggle switches the theme and Settings follows", async ({
  page,
}) => {
  await page.goto("/settings");

  await headerToggle(page).click();

  await expect(html(page)).toHaveAttribute("data-theme", "light");
  await expect(headerToggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(themeRadio(page, "Light")).toBeChecked();

  await headerToggle(page).click();
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await expect(themeRadio(page, "Dark")).toBeChecked();
});

test("the theme stays put during client-side navigation", async ({ page }) => {
  await page.goto("/settings");
  await page.getByText("Dark text on a light background.").click();

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Projects" })
    .click();

  await expect(page).toHaveURL("/projects");
  await expect(html(page)).toHaveAttribute("data-theme", "light");
});

test("another open tab follows a theme change", async ({ context }) => {
  const settingsTab = await context.newPage();
  const otherTab = await context.newPage();
  await settingsTab.goto("/settings");
  await otherTab.goto("/settings");

  await settingsTab.getByText("Dark text on a light background.").click();

  await expect(html(otherTab)).toHaveAttribute("data-theme", "light");
  await expect(themeRadio(otherTab, "Light")).toBeChecked();
  await expect(headerToggle(otherTab)).toHaveAttribute("aria-pressed", "false");

  await headerToggle(settingsTab).click();
  await expect(html(otherTab)).toHaveAttribute("data-theme", "dark");
  await expect(themeRadio(otherTab, "Dark")).toBeChecked();
});

test("a saved light theme is applied before the first paint", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "light");
    // The first animation frame runs before the first paint.
    requestAnimationFrame(() => {
      (window as unknown as { firstFrameTheme?: string }).firstFrameTheme =
        document.documentElement.getAttribute("data-theme") ?? undefined;
    });
  }, STORAGE_KEY);

  await page.goto("/");

  const firstFrame = await page.evaluate(
    () => (window as unknown as { firstFrameTheme?: string }).firstFrameTheme,
  );
  expect(firstFrame).toBe("light");
});

test("before hydration, the theme controls already report a saved light theme", async ({
  page,
}) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, "light"),
    STORAGE_KEY,
  );
  // Block the app bundles so React never hydrates: this is what assistive
  // technology sees while JavaScript is still loading. The server HTML and
  // its inline scripts still run.
  await page.route(/\/_next\/static\/chunks\/.*\.js/, (route) => route.abort());

  await page.goto("/settings", { waitUntil: "domcontentloaded" });

  await expect(html(page)).toHaveAttribute("data-theme", "light");
  await expect(headerToggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(themeRadio(page, "Light")).toBeChecked();
  await expect(themeRadio(page, "Dark")).not.toBeChecked();
});

test("an invalid saved value falls back to dark", async ({ page }) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, "purple"),
    STORAGE_KEY,
  );

  await page.goto("/settings");

  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await expect(themeRadio(page, "Dark")).toBeChecked();
});

test("with storage blocked, the page is dark and switching still works for the visit", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access denied", "SecurityError");
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/settings");
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  // Before any choice, Settings already says the choice won't be saved.
  const group = page.getByRole("group", { name: "Theme" });
  await expect(group).toHaveAccessibleDescription(
    "This browser blocks saving, so your choice applies only until you reload.",
  );

  await page.getByText("Dark text on a light background.").click();

  await expect(html(page)).toHaveAttribute("data-theme", "light");
  await expect(group).toHaveAccessibleDescription(
    "This browser blocks saving, so your choice applies only until you reload.",
  );
  expect(errors).toEqual([]);
});

test("with storage available, Settings says the choice is saved", async ({
  page,
}) => {
  await page.goto("/settings");

  await expect(
    page.getByRole("group", { name: "Theme" }),
  ).toHaveAccessibleDescription(
    "Your choice is saved in this browser and applies to every open tab.",
  );
});
