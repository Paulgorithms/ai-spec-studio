import Link from "next/link";
import { siteConfig } from "@/lib/site";
import { LogoMark } from "./icons";

// The product name with its mark, linking to the dashboard.
export function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/"
      onNavigate={onNavigate}
      className="flex h-9 items-center gap-2.5 rounded-md px-1 text-sm font-semibold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <LogoMark className="size-6 shrink-0" />
      {siteConfig.name}
    </Link>
  );
}
