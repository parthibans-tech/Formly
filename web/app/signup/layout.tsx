import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create your account",
  description:
    "Start with Drive360 in minutes. Design templates, embed forms, and bulk-generate PDFs — free to try, no credit card.",
  alternates: { canonical: "/signup" },
  openGraph: { title: "Create your Drive360 account", url: "/signup" },
};

export default function SignupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
