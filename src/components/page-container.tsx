import type { ComponentProps } from "react";

const containerClasses =
  "mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-6 py-24 font-sans sm:px-16";

export function PageContainer({ className, ...props }: ComponentProps<"main">) {
  return (
    <main
      className={
        className ? `${containerClasses} ${className}` : containerClasses
      }
      {...props}
    />
  );
}
