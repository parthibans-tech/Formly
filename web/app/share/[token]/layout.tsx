import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Shared document",
  description: "A document shared with you via Drive360.",
  robots: { index: false, follow: false, nocache: true },
};

export default function ShareLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
