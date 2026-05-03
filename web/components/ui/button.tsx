"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Button — the system's primary call-to-action primitive.
//
// Treatment is restrained: solid primary in deep indigo, hairline
// outline for secondaries, ghost for tertiary actions. Every variant
// shares the same motion vocabulary:
//
//   - Hover: 150ms color shift, very subtle (no elevation change).
//   - Press: 100ms scale to 0.98 with the spring easing — this is
//     the single piece of "playful" motion in the system, justified
//     because press feedback is the moment the user most needs the UI
//     to confirm it heard them.
//   - Focus: 2px ring with offset, animated in over 100ms.
//
// Sizes follow an 8px-grid ladder: 32 / 36 / 40 / 44. The default is
// 36 because that's the height a standalone button needs to look right
// against 14px body text without dominating; toolbars use sm (32) and
// hero CTAs use lg (44).
const buttonVariants = cva(
  [
    // Layout + typography baseline
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded-md text-sm font-medium",
    // SVG icon sizing — works for any lucide-react icon used as a child
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    // Motion — color/border under fast easing, transform under spring
    "transition-[background-color,border-color,color,box-shadow,transform] duration-fast ease-out",
    "active:scale-[0.98] active:duration-instant active:ease-spring",
    // Focus + disabled
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50",
  ].join(" "),
  {
    variants: {
      variant: {
        // Solid primary — indigo. Hover darkens by ~6% (the /90 step).
        // No shadow on rest; pressed state's scale carries the
        // affordance.
        default:
          "bg-primary text-primary-foreground hover:bg-primary/92 active:bg-primary/85",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/92 active:bg-destructive/85",
        // Outline = the secondary action. Hairline border, transparent
        // fill so it sits flush against any surface (toolbar, card,
        // dialog footer). On hover it picks up the accent fill.
        outline:
          "border border-border bg-transparent text-foreground hover:bg-accent hover:border-border-strong",
        // Secondary fill = a quiet "another option" button. Reads as
        // a chip at sm size, as a button at default+.
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-accent",
        // Ghost = no chrome at rest. Used in toolbars where multiple
        // adjacent buttons would otherwise create visual noise.
        ghost:
          "text-foreground hover:bg-accent hover:text-accent-foreground",
        // Link = inline-text affordance, no padding, no height. Used
        // sparingly inside body copy.
        link:
          "h-auto p-0 text-primary underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        // Default 36px — the workhorse. Pairs with 14px body text.
        default: "h-9 px-3.5 py-2",
        // sm 32px — toolbars, table-row actions, dense panels.
        sm: "h-8 rounded-md px-3 text-xs",
        // lg 44px — hero CTAs, modal primary actions.
        lg: "h-11 rounded-md px-6 text-[0.9375rem]",
        // icon = square at default height so icon-only buttons line up
        // with text buttons in the same row.
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading, disabled, children, ...props },
    ref
  ) => {
    const Comp = asChild ? Slot : "button";
    // When `asChild` is true, Radix Slot requires exactly one child element,
    // so we can't add the spinner overlay. Fall back to the simple swap.
    if (asChild) {
      return (
        <Comp
          className={cn(buttonVariants({ variant, size, className }))}
          ref={ref}
          disabled={disabled || loading}
          {...props}
        >
          {children}
        </Comp>
      );
    }
    // Hide the original content and overlay a centered spinner. Keeps
    // the button's width, height, and content alignment stable so the
    // icon doesn't visibly jump when `loading` flips.
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }), "relative")}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        <span
          className={cn(
            "inline-flex items-center justify-center gap-2",
            loading && "invisible"
          )}
        >
          {children}
        </span>
        {loading && (
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center"
          >
            <Loader2 className="animate-spin" />
          </span>
        )}
      </Comp>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
