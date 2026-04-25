import "./globals.css";
import type { Metadata } from "next";
import { ToastProvider } from "@/components/toast";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/ui/confirm";
import { PromptProvider } from "@/components/ui/prompt";
import { VaultUnlockProvider } from "@/components/vault-unlock";

export const metadata: Metadata = {
  title: "Drive360 — Document automation platform",
  description:
    "Design, fill, and share PDF & HTML documents. Upload forms, map fields, generate in bulk.",
};

const themeInitScript = `(function(){try{var s=localStorage.getItem('df_theme');var d=(s==='dark')||((!s||s==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
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
