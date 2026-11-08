import Link from "next/link";
import type { ComponentProps } from "react";
import { cx } from "@/lib/class-names";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

type ButtonStyleProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

// `w-fit` keeps a button from stretching in a flex column. Hover and active
// styles sit behind `not-disabled:` so a disabled button doesn't react. Links
// never match :disabled, so they always get them. The focus outline uses an
// offset, so it sits on the surface around the button and stays visible
// against every fill. The transition leaves out outline-color on purpose:
// `transition-colors` would fade the outline in from the text color, which
// starts white-on-white for a primary button in light mode.
const baseClasses =
  "inline-flex w-fit shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 motion-safe:transition-[color,background-color,border-color]";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent not-disabled:hover:bg-accent-hover not-disabled:active:bg-accent-active",
  secondary:
    "border border-border-strong bg-surface text-foreground not-disabled:hover:bg-surface-hover not-disabled:active:bg-border",
  ghost:
    "text-foreground not-disabled:hover:bg-surface-hover not-disabled:active:bg-border",
  danger:
    "bg-danger-solid text-on-accent not-disabled:hover:bg-danger-solid-hover not-disabled:active:bg-danger-solid-active",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-9 px-4 text-sm",
};

function buttonClassName(
  variant: ButtonVariant,
  size: ButtonSize,
  className: string | undefined,
) {
  return cx(baseClasses, variantClasses[variant], sizeClasses[size], className);
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & ButtonStyleProps) {
  return (
    <button
      type={type}
      className={buttonClassName(variant, size, className)}
      {...props}
    />
  );
}

// A link styled as a button, for navigation. Links can't be disabled; render
// a disabled <Button> or plain text instead when the destination isn't
// available.
export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & ButtonStyleProps) {
  return (
    <Link className={buttonClassName(variant, size, className)} {...props} />
  );
}
