// Standalone per-starter API integration guide page.
//
// Same component as the drawer in the fill-page header (so authors and
// integrators see identical copy), but rendered full-width for sharing
// and reading without the editor chrome around it.
//
// The starter content lives in the client bundle (`web/lib/starters/*.ts`),
// so this page is a server component that just looks up the starter and
// hands it to <StarterApiGuide>. No API call required.

import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, FileCode, Pencil } from "lucide-react";
import { STARTERS } from "@/lib/starters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { StarterApiGuide } from "@/components/starter-api-guide";

interface Props {
  params: { id: string };
}

export default function StarterApiGuidePage({ params }: Props) {
  const starter = STARTERS.find((s) => s.id === params.id);
  if (!starter) notFound();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/starters/${starter.id}`}>
                <ArrowLeft className="h-4 w-4" />
                Back to template
              </Link>
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">{starter.name}</h1>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] uppercase">
                  {starter.category}
                </Badge>
                <Badge
                  variant="secondary"
                  className="gap-1 text-[10px] uppercase"
                >
                  <FileCode className="h-3 w-3" />
                  API
                </Badge>
              </div>
            </div>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/starters/${starter.id}`}>
              <Pencil className="h-4 w-4" />
              Edit
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl">
        <StarterApiGuide starter={starter} />
      </main>
    </div>
  );
}
