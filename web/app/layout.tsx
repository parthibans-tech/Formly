import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ToastProvider } from "@/components/toast";

// Two font families, monochromatic hierarchy. The system uses Inter
// for everything user-facing and JetBrains Mono for code / IDs /
// tabular numerics. Hierarchy comes from weight + scale, not from
// face changes.
//
// next/font self-hosts and subsets at build time so first paint never
// shows the system fallback face (no FOUT) and we avoid an extra DNS
// round-trip to fonts.googleapis.com on cold sessions. Each export
// produces a CSS variable that tailwind.config.ts references — adding
// or swapping a face later is one import, one variable name, nothing
// else touched.
const fontSans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
  // Three weights cover regular code, emphasis, and the kbd-chip
  // semibold. Loading the full 100..800 range would ship ~60KB of
  // weights we never use.
  weight: ["400", "500", "600"],
});
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/ui/confirm";
import { PromptProvider } from "@/components/ui/prompt";
import { FolderPickerProvider } from "@/components/folder-picker";
import { VaultUnlockProvider } from "@/components/vault-unlock";
import { RUMCollector } from "@/components/rum-collector";
import { siteUrl } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: "Drive360 — Document automation for modern teams",
    template: "%s · Drive360",
  },
  description:
    "Design, fill, sign, and share PDF & HTML documents at scale. Bulk-generate from CSV, embed forms anywhere, and automate the paperwork your team still does by hand.",
  applicationName: "Drive360",
  keywords: [
    "document automation",
    "PDF generation",
    "e-signature",
    "form builder",
    "bulk PDF",
    "document workflow",
    "AcroForm",
    "OCR",
  ],
  authors: [{ name: "Drive360" }],
  creator: "Drive360",
  publisher: "Drive360",
  formatDetection: { email: false, address: false, telephone: false },
  openGraph: {
    type: "website",
    siteName: "Drive360",
    locale: "en_US",
  },
  twitter: { card: "summary_large_image", creator: "@drive360" },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export const viewport: Viewport = {
  // themeColor mirrors the page canvas so mobile browser chrome blends
  // into the surface instead of cutting a stark band above the UI.
  // Hex equivalents of HSL(0 0% 100%) and HSL(224 40% 6%) from
  // app/globals.css's `--background` token — keep them in sync if those
  // tokens move.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0d17" },
  ],
  width: "device-width",
  initialScale: 1,
};

const themeInitScript = `(function(){try{var s=localStorage.getItem('df_theme');var d=(s==='dark')||((!s||s==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      // Font variables propagate down the cascade so every component
      // that reaches for `font-sans` or `font-mono` resolves through
      // next/font's optimized fonts. We attach them to <html> (not
      // <body>) so iframed content and portaled overlays — toasts,
      // dialogs, popovers rendered through Radix Portal — inherit the
      // same stack without a second wiring step.
      className={`${fontSans.variable} ${fontMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {/* Real User Monitoring — Core Web Vitals → /v1/rum.
            Renders nothing; subscribes to LCP/INP/CLS/FCP/TTFB and
            beacons one batch on page-unload. Mounted at the root so
            it sees the very first paint of the very first route. */}
        <RUMCollector />
        <TooltipProvider delayDuration={150}>
          <ConfirmProvider>
            <PromptProvider>
              <FolderPickerProvider>
                <VaultUnlockProvider>
                  <ToastProvider>{children}</ToastProvider>
                </VaultUnlockProvider>
                <Toaster />
              </FolderPickerProvider>
            </PromptProvider>
          </ConfirmProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
