import "./globals.css";
import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/toast";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/ui/confirm";
import { PromptProvider } from "@/components/ui/prompt";
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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1020" },
  ],
  width: "device-width",
  initialScale: 1,
};

const themeInitScript = `(function(){try{var s=localStorage.getItem('df_theme');var d=(s==='dark')||((!s||s==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
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
              <VaultUnlockProvider>
                <ToastProvider>{children}</ToastProvider>
              </VaultUnlockProvider>
              <Toaster />
            </PromptProvider>
          </ConfirmProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
