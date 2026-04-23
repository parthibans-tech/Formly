import "./globals.css";
import type { Metadata } from "next";
import { ToastProvider } from "@/components/toast";

export const metadata: Metadata = { title: "DocForge", description: "PDF generation platform" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
