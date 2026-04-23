"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, History, RotateCcw } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm";
import { cn } from "@/lib/utils";

type Version = {
  version: number;
  authorId?: string;
  createdAt: string;
  config: any;
};

type Template = { id: string; name: string; mode: string; version: number };

export default function VersionsPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const toast = useToast();
  const confirm = useConfirm();
  const [tpl, setTpl] = useState<Template | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [selectedA, setSelectedA] = useState<number | null>(null);
  const [selectedB, setSelectedB] = useState<number | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id, router]);

  async function load() {
    try {
      const [t, v] = await Promise.all([
        api<Template>(`/v1/templates/${params.id}`),
        api<{ versions: Version[] }>(
          `/v1/templates/${params.id}/versions`
        ),
      ]);
      setTpl(t);
      setVersions(v.versions);
      if (v.versions.length >= 2) {
        setSelectedA(v.versions[1].version);
        setSelectedB(v.versions[0].version);
      } else if (v.versions.length === 1) {
        setSelectedB(v.versions[0].version);
      }
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function restore(v: number) {
    const ok = await confirm({
      title: `Restore v${v}?`,
      description: "This creates a new current version from the selected snapshot.",
      confirmLabel: "Restore",
    });
    if (!ok) return;
    try {
      const res = await api<{ version: number }>(
        `/v1/templates/${params.id}/versions/${v}/restore`,
        { method: "POST" }
      );
      toast.show("success", `Restored — now at v${res.version}`);
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  const a = versions.find((v) => v.version === selectedA) || null;
  const b = versions.find((v) => v.version === selectedB) || null;

  if (!tpl) {
    return (
      <div className="mx-auto max-w-7xl space-y-4 px-6 py-10">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 px-4 md:px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/templates/${tpl.id}/designer`}>
                <ArrowLeft className="h-4 w-4" />
                Designer
              </Link>
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">{tpl.name}</h1>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="uppercase text-[10px]">
                  <History className="h-3 w-3" />
                  Versions
                </Badge>
                <span className="text-xs text-muted-foreground">
                  current v{tpl.version}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside className="w-72 shrink-0 overflow-y-auto border-r">
          {versions.length === 0 ? (
            <EmptyState
              className="m-4 border-0"
              icon={History}
              title="No saved versions yet"
              description="Save the config in the designer to create your first version."
            />
          ) : (
            <ul className="divide-y">
              {versions.map((v) => {
                const isB = selectedB === v.version;
                const isA = selectedA === v.version;
                return (
                  <li key={v.version} className="p-3">
                    <div className="flex items-center gap-2 text-sm">
                      <button
                        onClick={() => setSelectedB(v.version)}
                        className={cn(
                          "flex-1 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent",
                          isB && "bg-primary/10 text-primary"
                        )}
                      >
                        <span className="font-semibold">v{v.version}</span>
                        <span className="block text-xs text-muted-foreground">
                          {new Date(v.createdAt).toLocaleString()}
                        </span>
                      </button>
                      <Button
                        size="sm"
                        variant={isA ? "default" : "outline"}
                        className="h-7 w-7 p-0"
                        onClick={() => setSelectedA(v.version)}
                        title="Compare as base"
                      >
                        A
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => restore(v.version)}
                        title={`Restore v${v.version}`}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="grid flex-1 grid-cols-2 gap-0 min-h-0">
          <Pane title={`v${a?.version ?? "—"} (base)`} config={a?.config} />
          <Pane title={`v${b?.version ?? "—"}`} config={b?.config} />
        </section>
      </div>
    </div>
  );
}

function Pane({ title, config }: { title: string; config: any }) {
  return (
    <div className="flex min-h-0 flex-col border-r last:border-r-0 bg-muted/30">
      <div className="border-b bg-background px-4 py-2 text-sm font-medium">
        {title}
      </div>
      <pre className="flex-1 overflow-auto bg-background p-4 font-mono text-xs">
        {config ? JSON.stringify(config, null, 2) : "—"}
      </pre>
    </div>
  );
}
