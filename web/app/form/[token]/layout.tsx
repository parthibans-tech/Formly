import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Submit form",
  description: "A document form powered by Drive360.",
  // Public token URLs are unguessable but personal — never index them.
  robots: { index: false, follow: false, nocache: true },
};

export default function FormLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
