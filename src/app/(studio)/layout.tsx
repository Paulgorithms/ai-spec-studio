import { AppHeader } from "./_components/app-header";
import { Sidebar } from "./_components/sidebar";
import { SkipLink } from "./_components/skip-link";

// The application shell for every studio page: the sidebar from lg up, the
// header (with the drawer below lg), and the main content area. Pages render
// inside <main> and must not add their own. Errors in a page are caught by
// error.tsx in this folder, which renders inside <main>, so the navigation
// stays usable.
export default function StudioLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-1">
      <SkipLink />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader />
        {/* tabIndex lets the skip link move focus here, not just scroll. */}
        <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
