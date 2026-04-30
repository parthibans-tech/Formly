"use client";

// ApiGuideSheet — a pre-wired "API" header button that opens a
// right-side drawer containing <ApiGuide> for the given template.
//
// Every designer (static / html / markdown / acroform) mounts one of
// these in its header, so integration docs are one click away from
// whatever surface the user is in. Centralising the Sheet plumbing
// here means the four designers stay dumb — they just drop the
// component in next to their existing "Playground" button.

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
import { ApiGuide } from "@/components/api-guide";

type Props = {
  templateId: string;
  templateName?: string;
  /**
   * Override the button label when horizontal space is tight (e.g.
   * designers with dense toolbars). Defaults to "API".
   */
  label?: string;
};

export function ApiGuideSheet({ templateId, templateName, label = "API" }: Props) {
  const [open, setOpen] = useState(false);
  // Bumped on every open so <ApiGuide> re-fetches /schema — the user
  // may have just hit Save, in which case the previously-cached schema
  // is stale (missing a new mapping, stale validation rule, etc.).
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setRefreshKey((n) => n + 1);
      }}
    >
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
            Copy-paste endpoint, auth, payload shape, and runnable snippets —
            all derived from{" "}
            {templateName ? <em>{templateName}</em> : "this template"}.{" "}
            <Link
              href={`/templates/${templateId}/api`}
              className="underline underline-offset-2"
            >
              Open full page
            </Link>
            {" · "}
            <Link
              href={`/templates/${templateId}/settings`}
              className="underline underline-offset-2"
            >
              Output &amp; security
            </Link>
          </SheetDescription>
        </SheetHeader>
        <ApiGuide templateId={templateId} refreshKey={refreshKey} compact />
      </SheetContent>
    </Sheet>
  );
}
