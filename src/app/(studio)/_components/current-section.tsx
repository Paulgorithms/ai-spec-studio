"use client";

import { usePathname } from "next/navigation";
import { getActiveNavItem } from "@/lib/navigation";

// Names the current section in the header. It isn't a heading: each page
// has its own h1. (Same usePathname note as NavLinks.)
export function CurrentSection() {
  const section = getActiveNavItem(usePathname());
  if (!section) return null;
  return (
    <p className="truncate text-sm font-medium text-foreground">
      {section.label}
    </p>
  );
}
