import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Wordmark } from "@/components/marketing/wordmark";

// Auth surfaces share one layout: a centered glass card on an animated
// gradient backdrop. No marketing copy — the landing page handles the
// pitch. The form is the entire stage.
export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative isolate flex min-h-screen flex-col bg-background text-foreground">
      <AuthBackdrop />

      <header className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-10">
        <Link href="/" className="inline-flex items-center">
          <Wordmark />
        </Link>
        <Link
          href="/"
          className="group inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-3 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
          Back to home
        </Link>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-16 pt-4 sm:px-6">
        <div className="w-full max-w-[420px]">
          <div className="relative">
            {/* Gradient frame */}
            <div
              aria-hidden
              className="absolute -inset-px rounded-2xl bg-gradient-to-br from-primary/40 via-cyan-400/20 to-fuchsia-400/30 opacity-70 blur-[1px]"
            />
            <div className="relative rounded-2xl border border-border/70 bg-card/80 p-7 shadow-elevated backdrop-blur-xl sm:p-8">
              {children}
            </div>
          </div>

          <p className="mt-6 text-center text-[11px] text-muted-foreground/80">
            Protected by industry-standard encryption.
          </p>
        </div>
      </main>
    </div>
  );
}

function AuthBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.18),transparent_55%)]" />
      <div className="absolute -left-32 top-0 h-[28rem] w-[28rem] rounded-full bg-primary/20 blur-3xl animate-blob-1" />
      <div className="absolute -right-24 top-1/4 h-[24rem] w-[24rem] rounded-full bg-cyan-400/20 blur-3xl dark:bg-cyan-300/10 animate-blob-2" />
      <div className="absolute bottom-[-10rem] left-1/3 h-[22rem] w-[22rem] rounded-full bg-fuchsia-400/15 blur-3xl dark:bg-fuchsia-300/10 animate-blob-3" />
      <svg
        className="absolute inset-0 h-full w-full opacity-[0.18] dark:opacity-[0.10]"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern
            id="auth-grid"
            width="56"
            height="56"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 56 0 L 0 0 0 56"
              fill="none"
              stroke="hsl(var(--foreground))"
              strokeOpacity="0.15"
              strokeWidth="1"
            />
          </pattern>
          <radialGradient id="auth-mask" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="white" stopOpacity="1" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </radialGradient>
          <mask id="auth-grid-mask">
            <rect width="100%" height="100%" fill="url(#auth-mask)" />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="url(#auth-grid)"
          mask="url(#auth-grid-mask)"
        />
      </svg>
    </div>
  );
}
