import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { InlineScript } from "@/components/inline-script";
import { siteConfig } from "@/lib/site";
import { DEFAULT_THEME, themeInitScript } from "@/lib/theme";
import { ThemeRestore } from "./_components/theme-restore";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: siteConfig.name,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The server always renders dark. The inline script may switch it to a
    // saved light preference before React hydrates, so React is told to
    // accept the attribute it finds in the DOM.
    <html
      lang="en"
      data-theme={DEFAULT_THEME}
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full bg-background antialiased`}
    >
      <head>
        <InlineScript html={themeInitScript} />
      </head>
      <body className="flex min-h-full flex-col font-sans text-foreground">
        <ThemeRestore />
        {children}
      </body>
    </html>
  );
}
