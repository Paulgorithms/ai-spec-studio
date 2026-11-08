// The first tab stop on every studio page. Hidden until focused, then shown
// in the top-left corner; it moves focus past the navigation to <main>.
export function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      Skip to content
    </a>
  );
}
