import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Badge — the system's status pill. Two design intents:
//
//   1. Tint, never solid. Stock shadcn ships solid-fill badges in
//      every variant, which makes a row of 5 status badges read like
//      a row of buttons. The system's badges use a 12% tint of the
//      intent colour for the fill and the full intent colour for the
//      text — they read as "labels" instead of "actions."
//
//   2. Two shape modes. Default is the rounded-full pill. The `outline`
//      variant is squared-off and thinner, used for tag-style metadata
//      (file types, owners) where a pill would visually compete with
//      adjacent status pills.
//
// The `dot` variant is the bare-minimum status mark — a 6px dot
// inline with text, no fill, no border. Used in lists where every
// row carries a status and the visual weight of pills would be too
// much (see the inbox + drive list views).
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "rounded-full border-transparent bg-primary/12 text-primary px-2.5 py-0.5",
        secondary:
          "rounded-full border-transparent bg-secondary text-secondary-foreground px-2.5 py-0.5",
        destructive:
          "rounded-full border-transparent bg-destructive/12 text-destructive px-2.5 py-0.5",
        success:
          "rounded-full border-transparent bg-success/12 text-success px-2.5 py-0.5",
        warning:
          "rounded-full border-transparent bg-warning/15 text-warning-foreground px-2.5 py-0.5",
        info:
          "rounded-full border-transparent bg-info/12 text-info px-2.5 py-0.5",
        // Outline = tag-shaped (squared, hairline border, no fill).
        // For metadata that shouldn't compete with status pills.
        outline:
          "rounded-md border border-border text-muted-foreground px-2 py-0.5",
        // Solid = the rare "this is THE state" badge. Used for the
        // primary marker in a list (e.g. "Latest" on a versioned doc).
        solid:
          "rounded-full border-transparent bg-foreground text-background px-2.5 py-0.5",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

// StatusDot — the minimal status mark. Renders a coloured dot inline
// with the surrounding text. Used in dense list views where every row
// shows a status and badges would create visual noise.
//
// Usage:
//   <StatusDot tone="success" /> Active
//   <StatusDot tone="warning" /> Awaiting review
//   <StatusDot tone="destructive" pulse /> Failed
//
// `pulse` adds a subtle breathing animation — reserved for live
// states (in-progress, listening, syncing). Don't use it on resting
// states; the constant motion becomes noise.
export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: "default" | "muted" | "success" | "warning" | "destructive" | "info" | "primary";
  pulse?: boolean;
}

const toneClass: Record<NonNullable<StatusDotProps["tone"]>, string> = {
  default: "bg-foreground",
  muted: "bg-muted-foreground",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  info: "bg-info",
  primary: "bg-primary",
};

function StatusDot({ tone = "default", pulse, className, ...props }: StatusDotProps) {
  return (
    <span
      role="status"
      className={cn(
        "relative inline-block h-1.5 w-1.5 rounded-full align-middle",
        toneClass[tone],
        className
      )}
      {...props}
    >
      {pulse && (
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 rounded-full opacity-60 animate-ping",
            toneClass[tone]
          )}
        />
      )}
    </span>
  );
}

export { Badge, StatusDot, badgeVariants };
