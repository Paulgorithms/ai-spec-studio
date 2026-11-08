import type { ComponentProps } from "react";
import { cx } from "@/lib/class-names";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

// Tone colors the text and the dot. The badge has no fill, so the text sits
// directly on the surface behind it; every tone meets 4.5:1 on all surfaces.
const toneClasses: Record<BadgeTone, string> = {
  neutral: "text-muted-foreground",
  accent: "text-accent-text",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

// A short label. Color only reinforces it: the text inside must say what the
// badge means on its own.
export function Badge({
  tone = "neutral",
  className,
  children,
  ...props
}: ComponentProps<"span"> & { tone?: BadgeTone }) {
  return (
    <span
      className={cx(
        "inline-flex w-fit items-center gap-1.5 rounded-full border border-border-strong px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-current"
      />
      {children}
    </span>
  );
}
