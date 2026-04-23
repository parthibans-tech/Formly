import Link from "next/link";
import { Boxes, FileSignature, Sparkles, ShieldCheck } from "lucide-react";

export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-gradient-to-br from-emerald-600 via-emerald-500 to-teal-600 p-12 text-white">
        <div
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 10%, rgba(255,255,255,.5) 0%, transparent 40%), radial-gradient(circle at 80% 90%, rgba(255,255,255,.35) 0%, transparent 45%)",
          }}
        />
        <div className="relative">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-lg font-semibold"
          >
            <span className="grid h-9 w-9 place-items-center rounded-md bg-white/15 backdrop-blur">
              <FileSignature className="h-5 w-5" />
            </span>
            Formly
          </Link>
        </div>
        <div className="relative space-y-6">
          <h2 className="text-3xl font-semibold leading-tight">
            Design, fill, and share documents — at scale.
          </h2>
          <p className="text-white/85 leading-relaxed">
            Upload AcroForm PDFs, HTML templates, or flat documents. Map data,
            generate filled outputs one by one or in batches, and share them
            securely with time-limited links.
          </p>
          <ul className="space-y-3 text-white/90">
            <Feature icon={Boxes}>AcroForm, static PDF, and HTML modes</Feature>
            <Feature icon={Sparkles}>Real-time designer & playground</Feature>
            <Feature icon={ShieldCheck}>
              Role-based share links with expiry
            </Feature>
          </ul>
        </div>
        <div className="relative text-xs text-white/70">
          © {new Date().getFullYear()} Formly. All rights reserved.
        </div>
      </aside>
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}

function Feature({
  icon: Icon,
  children,
}: {
  icon: typeof Boxes;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 grid h-6 w-6 place-items-center rounded-full bg-white/15">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="text-sm">{children}</span>
    </li>
  );
}
