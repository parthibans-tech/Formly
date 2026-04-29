"use client";

// StarterApiGuideSheet — pre-wired "API" header button that opens a
// right-side drawer containing <StarterApiGuide> for the given starter.
//
// Mirrors <ApiGuideSheet> for PDF templates; mounted in the starter
// fill-page header so integrators can read the docs without losing
// their place in the editor. The standalone full-page version lives at
// /starters/:id/api for sharing.

import { useState } from "react";
import Link from "next/link";
import { FileCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { StarterApiGuide } from "@/components/starter-api-guide";
import type { Starter } from "@/lib/starters/types";

type Props = {
  starter: Starter;
  /** Override the button label when horizontal space is tight. */
  label?: string;
};

export function StarterApiGuideSheet({ starter, label = "API" }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm">
          <FileCode className="h-4 w-4" />
          {label}
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-full max-w-none overflow-y-auto p-0 sm:max-w-3xl"
      >
        <SheetHeader className="sticky top-0 z-10 bg-background">
          <SheetTitle className="flex items-center gap-2">
            <FileCode className="h-4 w-4" />
            API integration guide
          </SheetTitle>
          <SheetDescription>
            Copy-paste endpoint, auth, payload shape, and runnable snippets
            for <em>{starter.name}</em>.{" "}
            <Link
              href={`/starters/${starter.id}/api`}
              className="underline underline-offset-2"
            >
              Open full page
            </Link>
          </SheetDescription>
        </SheetHeader>
        <StarterApiGuide starter={starter} compact />
      </SheetContent>
    </Sheet>
  );
}
