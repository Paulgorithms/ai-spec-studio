"use client";

// A script that runs once, while the browser parses the server HTML, ahead of
// the first paint. The pattern comes from the Next.js guide "Preventing flash
// before hydration".
//
// On the server it's type="text/javascript", so the browser runs it. When
// React renders it in the browser (client-side navigation, or a document
// rendered client-side after a server error), it's type="text/plain", so it
// never runs twice and React doesn't warn about rendering a <script>;
// suppressHydrationWarning covers that intentional type difference. It's a
// Client Component so that check also runs in the browser when a Server
// Component (the root layout) uses it. Only pass constant strings, never user
// data.
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
