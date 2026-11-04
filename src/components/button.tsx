import Link from "next/link";
import type { ComponentProps } from "react";

const buttonClasses =
  "inline-flex h-11 w-fit items-center justify-center rounded-full bg-foreground px-5 font-medium text-background transition-colors hover:bg-foreground/80";

export function Button({
  className,
  type = "button",
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      type={type}
      className={className ? `${buttonClasses} ${className}` : buttonClasses}
      {...props}
    />
  );
}

export function ButtonLink({
  className,
  ...props
}: ComponentProps<typeof Link>) {
  return (
    <Link
      className={className ? `${buttonClasses} ${className}` : buttonClasses}
      {...props}
    />
  );
}
