"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Card — the system's primary container. Three variants, all
// surface-aware: the rest tier ("default") relies on a hairline
// border with no shadow, and only earns elevation when it's been
// genuinely lifted off the page (elevated, interactive).
//
// Why three variants instead of one with prop overrides:
//   - default — the everyday card. No shadow. Border carries the
//     structure. Use this for ~90% of cases.
//   - elevated — for surfaces that genuinely sit above the page
//     plane (sticky filter bars over a scrollable list, hero panels
//     on a dashboard). Carries a single subtle e2 shadow.
//   - interactive — clickable cards in a grid (drive entries, template
//     pickers, dashboard nav tiles). Hover lifts the elevation by one
//     step; the cursor flips to pointer; the press scales by 1% the
//     same way the Button does. This is the only place a card animates.
const cardVariants = cva(
  "rounded-lg border bg-card text-card-foreground transition-[box-shadow,border-color,transform] duration-fast ease-out",
  {
    variants: {
      variant: {
        default: "border-border",
        elevated: "border-border shadow-e2",
        interactive: [
          "border-border cursor-pointer",
          "hover:border-border-strong hover:shadow-e2",
          "active:scale-[0.995] active:duration-instant",
        ].join(" "),
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant, ...props }, ref) => (
    <div ref={ref} className={cn(cardVariants({ variant, className }))} {...props} />
  )
);
Card.displayName = "Card";

// CardHeader keeps the same flex-col + space-y-1.5 rhythm — that
// 6px gap between title and description is the kind of micro-spacing
// that makes UI feel "tuned." Tighter (4px) reads cramped; looser
// (8px) reads disconnected. Don't move it.
const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
  )
);
CardHeader.displayName = "CardHeader";

// Title is sans-semibold per the monochrome hierarchy doctrine — no
// serif face swap. Tracking-tight + leading-none so the title sits
// flush against its description below without extra vertical drift.
const CardTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn("text-base font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
  )
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
  )
);
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
  cardVariants,
};
