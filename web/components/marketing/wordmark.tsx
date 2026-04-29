export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={"flex items-center gap-2 " + (className ?? "")}>
      <span
        aria-hidden
        className="relative inline-flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-primary to-primary/60 shadow-card"
      >
        <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.7),transparent_55%)] opacity-70" />
        <svg
          viewBox="0 0 24 24"
          className="relative h-4 w-4 text-primary-foreground"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 6.5a2 2 0 0 1 2-2h7l5 5v8.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />
          <path d="M14 4.5V10h5" />
          <path d="M9 13h6M9 16h4" />
        </svg>
      </span>
      <span className="text-base font-semibold tracking-tight text-foreground">
        Drive360
      </span>
    </span>
  );
}
