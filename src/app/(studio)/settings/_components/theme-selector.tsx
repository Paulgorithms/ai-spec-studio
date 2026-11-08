"use client";

import { useId, useState, type ReactNode } from "react";
import { InlineScript } from "@/components/inline-script";
import { cx } from "@/lib/class-names";
import { setTheme, themeRadioScript, type Theme } from "@/lib/theme";
import { useCanSaveTheme, useTheme } from "@/lib/use-theme";

const SAVED_MESSAGE =
  "Your choice is saved in this browser and applies to every open tab.";
const NOT_SAVED_MESSAGE =
  "This browser blocks saving, so your choice applies only until you reload.";
import { CheckIcon, MoonIcon, SunIcon } from "@/app/(studio)/_components/icons";

type Option = {
  value: Theme;
  label: string;
  description: string;
  icon: ReactNode;
  // Shows the selected style while this theme is on, using the variant that
  // matches it, so it's right from the first paint, before hydration.
  selectedClasses: string;
  checkClasses: string;
};

const options: Option[] = [
  {
    value: "dark",
    label: "Dark",
    description: "The default. Easy on the eyes in low light.",
    icon: <MoonIcon className="size-5" />,
    selectedClasses: "dark:border-accent dark:bg-surface-raised",
    checkClasses: "dark:flex",
  },
  {
    value: "light",
    label: "Light",
    description: "Dark text on a light background.",
    icon: <SunIcon className="size-5" />,
    selectedClasses: "light:border-accent light:bg-surface-raised",
    checkClasses: "light:flex",
  },
];

// The theme preference as a radio group: Tab moves into the group, the arrow
// keys change the selection, and screen readers announce "Theme, Dark, radio
// button, checked". The radio inputs are visually hidden; each option card is
// their <label>. Changes made in another tab arrive through useTheme.
export function ThemeSelector() {
  const theme = useTheme();
  // null until hydration: the server can't know whether storage works.
  const canSave = useCanSaveTheme();
  // A save can still fail later (for example, storage is full).
  const [saveFailed, setSaveFailed] = useState(false);
  const messageId = useId();

  let message = "";
  if (canSave !== null) {
    message = canSave && !saveFailed ? SAVED_MESSAGE : NOT_SAVED_MESSAGE;
  }

  return (
    <fieldset aria-describedby={messageId} className="flex flex-col gap-3">
      <legend className="mb-3 text-sm font-medium text-foreground">
        Theme
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={cx(
              "flex cursor-pointer items-start gap-3 rounded-lg border border-border-strong p-4 hover:bg-surface-hover has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring",
              option.selectedClasses,
            )}
          >
            <input
              type="radio"
              name="theme"
              value={option.value}
              checked={theme === option.value}
              onChange={() => setSaveFailed(!setTheme(option.value))}
              className="sr-only"
            />
            <span className="mt-0.5 text-muted-foreground">{option.icon}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                {option.label}
              </span>
              <span className="text-sm text-muted-foreground">
                {option.description}
              </span>
            </span>
            {/* A check mark, so the selection isn't shown by color alone. */}
            <span
              aria-hidden="true"
              className={cx(
                "hidden size-5 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent",
                option.checkClasses,
              )}
            >
              <CheckIcon className="size-3.5" />
            </span>
          </label>
        ))}
      </div>
      {/* Checks the radio for the page's theme before the first paint (the
          server HTML always checks Dark), so assistive technology hears the
          right state before React hydrates. */}
      <InlineScript html={themeRadioScript} />
      {/* Whether the choice lasts. Empty until hydration, so it never claims
          either answer before the browser has been checked. It describes the
          fieldset, so screen readers read it when focus enters the group,
          rather than announcing it as it fills in on every page load.
          min-h-5 reserves its first line, to limit the shift when it appears. */}
      <p id={messageId} className="min-h-5 text-sm text-muted-foreground">
        {message}
      </p>
    </fieldset>
  );
}
