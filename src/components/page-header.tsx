import type { ReactNode } from "react";
import { cx } from "@/lib/class-names";

type PageHeaderProps = {
  // The page's only h1.
  title: ReactNode;
  description?: ReactNode;
  // Buttons or links for the page, such as "New specification".
  actions?: ReactNode;
  className?: string;
};

// The title block at the top of a page. On narrow screens the actions wrap
// below the title; from the sm breakpoint they sit to the right.
export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cx(
        "flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-balance text-foreground">
          {title}
        </h1>
        {description && (
          <p className="max-w-2xl text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}
