import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Review document",
  description: "Review and respond to a document via Drive360.",
  robots: { index: false, follow: false, nocache: true },
};

export default function ReviewLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
