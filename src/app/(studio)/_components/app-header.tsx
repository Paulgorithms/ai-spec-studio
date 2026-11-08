import { CurrentSection } from "./current-section";
import { MobileNav } from "./mobile-nav";
import { ThemeToggle } from "./theme-toggle";

// The 56px bar above the content. Below lg it holds the menu button; at every
// width it names the current section, with the theme toggle on the right.
export function AppHeader() {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4 sm:px-6 lg:px-8">
      <MobileNav />
      <CurrentSection />
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}
