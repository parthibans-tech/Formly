"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// Dialog — the system's modal primitive. Uses Radix Dialog under the
// hood for focus trap, escape-to-close, scroll lock, and a11y
// attributes. The visual treatment is this system's own.
//
// Two pieces of design intent worth preserving when editing:
//
//   1. Backdrop is glass, not flat black. Stock shadcn ships
//      `bg-black/60` which feels like a movie cinema; this system
//      uses `bg-foreground/40 backdrop-blur-sm` so the surface behind
//      the modal stays legible (people scan it for context) but visibly
//      recedes. This is the one place glass earns its complexity cost.
//
//   2. Content carries e4 elevation — a stacked 3-layer shadow tuned
//      to look like the modal is genuinely raised off the page.
//      Combined with the 12px radius (--radius-xl) it reads as a
//      "raised paper" affordance.
//
//   3. Motion: enter is duration-slow (300ms) with ease-out; exit is
//      duration-fast (150ms) with ease-in-out. Modals should be
//      thoughtful arriving and quick to leave.
const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      "data-[state=open]:duration-slow data-[state=closed]:duration-fast",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Position
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%]",
        // Surface — popover token + 12px radius + e4 elevation, no
        // border (the e4 stack already includes a 1px ring layer)
        "gap-4 rounded-xl bg-popover p-6 text-popover-foreground shadow-e4",
        // Motion — system's tuned dialog enter/exit (defined in
        // tailwind.config). Ditches the stock-shadcn slide-in direction
        // soup in favor of a single scale + fade that feels intentional.
        "data-[state=open]:animate-dialog-enter data-[state=closed]:animate-dialog-exit",
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className={cn(
          "absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-md",
          "text-muted-foreground transition-colors duration-fast ease-out",
          "hover:bg-accent hover:text-accent-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
          "disabled:pointer-events-none"
        )}
      >
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

// pr-8 reserves a fixed gutter on the right so DialogPrimitive.Close
// (absolutely positioned at right-4 top-4 inside DialogContent) never
// overlaps the title or description text. Long titles / descriptions
// could otherwise run under the X icon — visually noisy and the X
// becomes hard to hit. This is the single fix for every dialog in the
// app, instead of every caller remembering to add their own padding.
const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col space-y-1.5 pr-8 text-left", className)}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3",
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      // 18px / 24px / semibold matches the .text-h3 helper. Keep it
      // explicit here so a custom heading inside DialogTitle inherits
      // the right size without depending on the global h3 cascade
      // (Radix renders this as a div by default).
      "text-lg font-semibold leading-6 tracking-tight",
      className
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm leading-[1.4rem] text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
