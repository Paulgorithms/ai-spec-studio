type ClassValue = string | false | null | undefined;

// Joins class names and skips falsy values, so conditions read inline:
// cx("base", isActive && "active", className).
//
// It doesn't resolve Tailwind conflicts: "px-4" and "px-2" both stay, and the
// stylesheet decides which wins. Components therefore accept `className` for
// layout and spacing around them (margins, width, grid placement), not to
// override their own styles.
export function cx(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(" ");
}
