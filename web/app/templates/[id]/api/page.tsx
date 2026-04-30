"use client";

// Standalone per-template API guide page.
//
// This page is now a thin wrapper around <ApiGuide>. The real content
// (endpoint / auth / payload / snippets / responses) lives in
// components/api-guide.tsx and is also embedded in the designer as a
// side drawer — same component, two entry points, zero drift.
//
// The standalone page remains useful for:
//   • shareable URLs (e.g. pasting in a handoff doc or support thread),
//   • the view-only surface that doesn't mount a designer,
//   • a full-width reading experience when an integrator just wants to
//     read the docs without the split-screen editor around them.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, FileCode, Settings, Sparkles } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiGuide } from "@/components/api-guide";

type TemplateHeader = { id: string; name: string; mode: string };

export default function TemplateApiGuidePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [tpl, setTpl] = useState<TemplateHeader | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        // We fetch the template head-row here purely to render the
        // header chrome (name + mode badge + nav). The body component
        // does its own /schema fetch and owns all error / loading
        // states for the guide itself.
        const t = await api<TemplateHeader>(`/v1/templates/${params.id}`);
        setTpl(t);
      } catch {
        // The guide body will surface the same error below — no need
        // to duplicate the UI here.
      }
    })();
  }, [params.id, router]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/templates/${params.id}/designer`}>
                <ArrowLeft className="h-4 w-4" />
                Back to template
              </Link>
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div className="min-w-0">
              {tpl ? (
                <>
                  <h1 className="truncate text-sm font-semibold">{tpl.name}</h1>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {tpl.mode}
                    </Badge>
                    <Badge
                      variant="secondary"
                      className="gap-1 text-[10px] uppercase"
                    >
                      <FileCode className="h-3 w-3" />
                      API
                    </Badge>
                  </div>
                </>
              ) : (
                <Skeleton className="h-4 w-32" />
              )}
            </div>
          </div>
          {tpl && (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/templates/${tpl.id}/settings`}>
                  <Settings className="h-4 w-4" />
                  Output &amp; security
                </Link>
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/templates/${tpl.id}/playground`}>
                  <Sparkles className="h-4 w-4" />
                  Playground
                </Link>
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl">
        <ApiGuide templateId={params.id} />
      </main>
    </div>
  );
}
