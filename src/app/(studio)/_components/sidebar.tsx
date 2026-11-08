import { Brand } from "./brand";
import { NavLinks } from "./nav-links";

// The persistent desktop navigation, from the lg breakpoint (1024px). Below
// that it's hidden (display: none) and MobileNav takes over. The brand row is
// h-14 so it lines up with the 56px header beside it.
export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-surface lg:flex">
      <div className="flex h-14 shrink-0 items-center px-3">
        <Brand />
      </div>
      <nav aria-label="Main" className="px-3 py-3">
        <NavLinks />
      </nav>
    </aside>
  );
}
