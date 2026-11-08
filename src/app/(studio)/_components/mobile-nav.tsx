"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Brand } from "./brand";
import { CloseIcon, MenuIcon } from "./icons";
import { NavLinks } from "./nav-links";

// Matches Tailwind's lg breakpoint, where the sidebar takes over.
const DESKTOP_QUERY = "(min-width: 64rem)";

const iconButtonClasses =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// Navigation below the lg breakpoint: a menu button that opens the same links
// in a modal <dialog>. showModal() provides the modal behavior natively: focus
// moves into the dialog and stays there, the rest of the page is inert,
// Escape closes it, and focus returns to the menu button on close.
export function MobileNav() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const dialogId = useId();

  const close = () => dialogRef.current?.close();

  // If the window widens to desktop while the drawer is open, close it so a
  // modal doesn't sit over the sidebar layout.
  useEffect(() => {
    const desktop = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => {
      if (desktop.matches) dialogRef.current?.close();
    };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, []);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        className={iconButtonClasses}
        aria-label="Open navigation"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        onClick={() => {
          dialogRef.current?.showModal();
          setOpen(true);
        }}
      >
        <MenuIcon className="size-5" />
      </button>

      <dialog
        ref={dialogRef}
        id={dialogId}
        aria-label="Navigation"
        // Fires for every way the dialog closes: Escape, the close button,
        // a backdrop click, navigation, or a resize to desktop.
        onClose={() => setOpen(false)}
        // A click on the backdrop targets the <dialog> itself; clicks inside
        // land on the panel below, which fills the dialog.
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        className="m-0 h-dvh max-h-none w-72 max-w-[calc(100vw-3rem)] border-0 border-r border-border bg-surface p-0 text-foreground backdrop:bg-background/80"
      >
        <div className="flex h-full flex-col">
          {/* Same 56px row height as the header and the sidebar's brand row. */}
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-3">
            <Brand onNavigate={close} />
            <button
              type="button"
              className={iconButtonClasses}
              aria-label="Close navigation"
              onClick={close}
            >
              <CloseIcon className="size-5" />
            </button>
          </div>
          <nav aria-label="Main" className="px-3 py-3">
            <NavLinks onNavigate={close} />
          </nav>
        </div>
      </dialog>
    </div>
  );
}
