import { useId, type ComponentProps, type ReactNode } from "react";
import { cx } from "@/lib/class-names";

// The border uses border-input, which meets 3:1 against every surface, so the
// field's edge is visible without relying on its fill.
const inputClasses =
  "h-9 w-full min-w-0 rounded-md border border-border-input bg-surface-raised px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger";

// A bare text input. Prefer Field, which adds the label and messages; use
// Input directly only when the label is provided another way.
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cx(inputClasses, className)} {...props} />;
}

type FieldProps = Omit<ComponentProps<"input">, "children"> & {
  label: ReactNode;
  // Help text shown under the input and read with it by screen readers.
  description?: ReactNode;
  // Shown under the help text. Also marks the input as invalid.
  error?: ReactNode;
};

// A labeled input with optional help text and an error message. useId gives
// each field its own ids (also in Server Components), so several fields can
// share a page; pass `id` to choose one yourself.
export function Field({
  label,
  description,
  error,
  id,
  className,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...inputProps
}: FieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = description ? `${inputId}-description` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = cx(ariaDescribedBy, descriptionId, errorId) || undefined;

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={inputId} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <Input
        id={inputId}
        aria-describedby={describedBy}
        aria-invalid={error ? true : ariaInvalid}
        {...inputProps}
      />
      {description && (
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
