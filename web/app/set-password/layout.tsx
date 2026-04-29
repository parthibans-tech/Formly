import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Set your password",
  description: "Set your Drive360 password to finish activating your account.",
  // Token-bearing route — keep it out of the index.
  robots: { index: false, follow: false },
};

export default function SetPasswordLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
