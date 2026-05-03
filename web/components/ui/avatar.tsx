"use client";

import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Avatar — sized to match the Button height ladder (h-7 / h-9 / h-11)
// so a row of "<Avatar/> <Button/>" lines up without per-context tuning.
// The fallback uses `bg-muted` + `text-muted-foreground` rather than a
// tinted primary so a row of 8 user avatars doesn't read as "8 indigo
// circles" — initials are content, not branding.
const avatarVariants = cva(
  "relative inline-flex shrink-0 overflow-hidden rounded-full ring-1 ring-inset ring-border/40",
  {
    variants: {
      size: {
        xs: "h-6 w-6 text-[0.6875rem]",
        sm: "h-7 w-7 text-xs",
        default: "h-9 w-9 text-sm",
        lg: "h-11 w-11 text-base",
        xl: "h-14 w-14 text-lg",
      },
    },
    defaultVariants: { size: "default" },
  }
);

export interface AvatarProps
  extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>,
    VariantProps<typeof avatarVariants> {}

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  AvatarProps
>(({ className, size, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(avatarVariants({ size }), className)}
    {...props}
  />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn("aspect-square h-full w-full object-cover", className)}
    {...props}
  />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      "flex h-full w-full items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground",
      className
    )}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

// AvatarGroup — overlapping avatars with consistent stacking. The
// negative margin scales with size so a group of `xs` avatars overlaps
// 8px while `lg` overlaps 16px, keeping the visual rhythm.
export interface AvatarGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Cap how many to render; the rest become a "+N" tile. */
  max?: number;
}

const AvatarGroup = React.forwardRef<HTMLDivElement, AvatarGroupProps>(
  ({ className, children, max, ...props }, ref) => {
    const items = React.Children.toArray(children);
    const visible = max ? items.slice(0, max) : items;
    const extra = max ? items.length - max : 0;
    return (
      <div
        ref={ref}
        className={cn(
          // The negative-margin trick is what creates the overlap; the
          // `[&>*]:ring-2 [&>*]:ring-background` ring re-establishes the
          // gap between stacked avatars so they stay individually
          // legible.
          "flex -space-x-2 [&>*]:ring-2 [&>*]:ring-background",
          className
        )}
        {...props}
      >
        {visible}
        {extra > 0 && (
          <span
            className={cn(
              avatarVariants({ size: "default" }),
              "items-center justify-center bg-muted font-semibold text-muted-foreground"
            )}
          >
            +{extra}
          </span>
        )}
      </div>
    );
  }
);
AvatarGroup.displayName = "AvatarGroup";

export { Avatar, AvatarImage, AvatarFallback, AvatarGroup, avatarVariants };
