import { cn } from "@/lib/utils";

// Skeleton — the loading-state placeholder. Two visual modes available
// via the `variant` prop (default: shimmer wipe; "pulse": opacity fade).
//
// Shimmer is the right default: a gradient that sweeps left-to-right
// reads unambiguously as "loading content" because the motion direction
// implies *progress*, while a pulse reads as "this thing is alive but
// idle" (which is fine for live placeholders, less clear for loading).
// On low-end devices and prefers-reduced-motion the shimmer falls back
// to a steady muted tile via the global `@media (prefers-reduced-motion)`
// override in globals.css.
//
// Use the `pulse` variant for skeletons that are short-lived (under
// ~500ms) where the shimmer wouldn't get to make a full pass.
export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "shimmer" | "pulse";
}

function Skeleton({ className, variant = "shimmer", ...props }: SkeletonProps) {
  return (
    <div
      role="status"
      aria-busy
      aria-live="polite"
      className={cn(
        "rounded-md bg-muted",
        // The shimmer paints a translucent highlight band on top of the
        // muted base via a wide background-image gradient. The
        // `bg-no-repeat` + sized background is what makes the band a
        // discrete sweep rather than a tiled pattern.
        variant === "shimmer" && [
          "relative overflow-hidden",
          "bg-[length:1000px_100%] bg-no-repeat",
          "bg-gradient-to-r from-muted via-muted-foreground/10 to-muted",
          "animate-shimmer",
        ],
        variant === "pulse" && "animate-pulse",
        className
      )}
      {...props}
    />
  );
}

export { Skeleton };
