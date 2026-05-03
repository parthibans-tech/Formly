"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

// Tooltip — inverted surface (foreground on background-foreground) so
// it visually pops without competing with menus or popovers, which use
// the standard popover surface. shadow-e2 keeps it floating but quiet.
// The 6px radius (rounded-md) is intentionally tighter than menus —
// tooltips are quick disposable hints, smaller corners read as "less
// permanent" than the larger radii of dialogs and dropdowns.
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      "z-50 overflow-hidden rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background shadow-e2",
      "animate-in fade-in-0 zoom-in-95 duration-fast",
      "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:duration-instant",
      className
    )}
    {...props}
  />
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
