// The studio's primary navigation. The sidebar, the mobile drawer, and the
// header's page label all read this list, so a section is added in one place.

export type NavIconName =
  "dashboard" | "projects" | "specifications" | "settings";

export type NavItem = {
  label: string;
  href: string;
  icon: NavIconName;
  // "secondary" items sit below a divider, apart from the main sections.
  group: "primary" | "secondary";
};

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Dashboard", href: "/", icon: "dashboard", group: "primary" },
  { label: "Projects", href: "/projects", icon: "projects", group: "primary" },
  {
    label: "Specifications",
    href: "/specifications",
    icon: "specifications",
    group: "primary",
  },
  {
    label: "Settings",
    href: "/settings",
    icon: "settings",
    group: "secondary",
  },
];

// "/" matches only itself. Other items match their own path and anything
// below it, on a segment boundary: "/projects/abc" is in Projects, but
// "/projects-x" is not.
export function isActiveNavItem(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function getActiveNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => isActiveNavItem(pathname, item.href));
}
