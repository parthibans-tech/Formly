import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Sign in to Drive360 to design templates, generate documents in bulk, and manage your team's document workflow.",
  alternates: { canonical: "/login" },
  openGraph: { title: "Sign in to Drive360", url: "/login" },
};

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
