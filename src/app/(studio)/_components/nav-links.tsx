"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/lib/class-names";
import { NAV_ITEMS, isActiveNavItem, type NavItem } from "@/lib/navigation";
import { NavIcon } from "./icons";

// usePathname resolves during prerendering only while every studio route is
// static. A future dynamic route without generateStaticParams (for example
// /projects/[id]) makes it suspend, and the nearest parent then needs a
// <Suspense> boundary. See the usePathname docs (Cache Components).
export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const primary = NAV_ITEMS.filter((item) => item.group === "primary");
  const secondary = NAV_ITEMS.filter((item) => item.group === "secondary");

  const renderItem = (item: NavItem) => {
    const active = isActiveNavItem(pathname, item.href);
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          aria-current={active ? "page" : undefined}
          onNavigate={onNavigate}
          className={cx(
            "flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-safe:transition-[color,background-color]",
            active
              ? "bg-surface-raised text-foreground"
              : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
          )}
        >
          <NavIcon name={item.icon} className="size-4.5 shrink-0" />
          {item.label}
        </Link>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-0.5">{primary.map(renderItem)}</ul>
      <hr className="border-border" />
      <ul className="flex flex-col gap-0.5">{secondary.map(renderItem)}</ul>
    </div>
  );
}
