import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import { Analytics } from "@vercel/analytics/next";
import { isRuntimeConfigured } from "@/lib/app-config";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Journal Club",
  description: "Open-source AI research digest and journal club app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const showAppNav = isRuntimeConfigured();

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className={`${inter.className} min-h-full flex flex-col`}>
        <ThemeProvider>
          <nav className="border-b">
            <div className="mx-auto max-w-5xl flex items-center gap-6 px-4 h-14">
              <span className="font-semibold text-lg">AI Journal Club</span>
              {showAppNav ? (
                <div className="flex gap-4">
                  <Link href="/" className="text-sm hover:underline">
                    Dashboard
                  </Link>
                  <Link href="/sources" className="text-sm hover:underline">
                    Sources
                  </Link>
                  <Link href="/digests" className="text-sm hover:underline">
                    Digests
                  </Link>
                </div>
              ) : null}
              <div className="ml-auto">
                <ThemeToggle />
              </div>
            </div>
          </nav>
          {children}
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}
