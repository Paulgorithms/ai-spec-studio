import type { ComponentProps } from "react";
import { cx } from "@/lib/class-names";

// A bordered panel on the surface color. Children stack with consistent
// spacing; CardHeader, CardTitle, and CardDescription are optional pieces.
export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cx(
        "flex flex-col gap-4 rounded-lg border border-border bg-surface p-5",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("flex flex-col gap-1", className)} {...props} />;
}

type HeadingLevel = "h2" | "h3" | "h4";

// Defaults to h3, for cards under a page's h1 and a section's h2. Pass `as`
// to keep the heading order correct where a card sits elsewhere.
export function CardTitle({
  as: Heading = "h3",
  className,
  ...props
}: ComponentProps<"h3"> & { as?: HeadingLevel }) {
  return (
    <Heading
      className={cx(
        "text-lg font-semibold tracking-tight text-balance text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p className={cx("text-sm text-muted-foreground", className)} {...props} />
  );
}
