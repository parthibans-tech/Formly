"use client";

import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Progress — three sizes, three tones. The bar uses an inline-style
// translateX rather than a width transition so progress jumps are
// composited on the GPU and never trigger layout. The transition is
// `ease-out duration-base` (200ms) — fast enough that completed work
// feels acknowledged, slow enough to be readable.
const progressVariants = cva(
  "relative w-full overflow-hidden rounded-full bg-muted",
  {
    variants: {
      size: {
        sm: "h-1",
        default: "h-2",
        lg: "h-3",
      },
    },
    defaultVariants: { size: "default" },
  }
);

const indicatorVariants = cva(
  "h-full w-full flex-1 transition-transform duration-base ease-out",
  {
    variants: {
      tone: {
        default: "bg-primary",
        success: "bg-success",
        warning: "bg-warning",
        destructive: "bg-destructive",
      },
    },
    defaultVariants: { tone: "default" },
  }
);

export interface ProgressProps
  extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>,
    VariantProps<typeof progressVariants> {
  tone?: VariantProps<typeof indicatorVariants>["tone"];
  /**
   * When true, applies a slow stripe-shimmer animation. Use for
   * indeterminate-feeling work where progress is real but staggered
   * (large file uploads, batch jobs). Don't pair with a frequently-
   * updating value — the shimmer competes with the bar movement.
   */
  indeterminate?: boolean;
}

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(({ className, value, size, tone, indeterminate, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(progressVariants({ size }), className)}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn(
        indicatorVariants({ tone }),
        indeterminate && "animate-pulse"
      )}
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
