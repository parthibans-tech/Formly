"use client";

// Merge Recipes — list page.
//
// A recipe is a saved, callable PDF stitching configuration. The list
// here is the entry point: pick an existing recipe to edit, integrate
// (copy snippets), or run; or click "New recipe" to spin up a builder
// at /merge-recipes/<new-id>.
//
// We deliberately don't load components in the list view (the API
// only returns componentCount) — recipes can have dozens of
// components and N+1ing the index would be ugly.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Clock,
  Layers,
  Loader2,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { api, getToken } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/ui/confirm";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

type RecipeListItem = {
  id: string;
  name: string;
  description: string;
  componentCount: number;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
};

export default function MergeRecipesListPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();

  const [loading, setLoading] = useState(true);
  const [recipes, setRecipes] = useState<RecipeListItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const r = await api<{ recipes: RecipeListItem[] }>("/v1/merge-recipes");
      setRecipes(r.recipes ?? []);
    } catch (e: any) {
      toast.show("error", "Couldn't load recipes", { description: e.message });
    } finally {
      setLoading(false);
    }
  }

  async function createNew() {
    setCreating(true);
    try {
      const r = await api<RecipeListItem>("/v1/merge-recipes", {
        method: "POST",
        body: JSON.stringify({
          name: "Untitled recipe",
          description: "",
          components: [],
        }),
      });
      router.push(`/merge-recipes/${r.id}`);
    } catch (e: any) {
      toast.show("error", "Couldn't create recipe", { description: e.message });
      setCreating(false);
    }
  }

  async function remove(r: RecipeListItem) {
    const ok = await confirm({
      title: `Delete "${r.name}"?`,
      description:
        "Deleting a recipe doesn't touch the source files or templates it references — only the saved configuration. This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/merge-recipes/${r.id}`, { method: "DELETE" });
      toast.show("success", `Deleted "${r.name}"`);
      setRecipes((rs) => rs.filter((x) => x.id !== r.id));
    } catch (e: any) {
      toast.show("error", "Couldn't delete recipe", { description: e.message });
    }
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return recipes;
    return recipes.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        r.description.toLowerCase().includes(needle)
    );
  }, [recipes, q]);

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6 md:py-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Layers className="h-5 w-5 text-primary" />
              Merge recipes
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Saved, callable PDF stitching configurations. Pick files and
              templates once, then run the recipe by name from your app —
              same pattern as templates, but for combining multiple
              documents into a single output.
            </p>
          </div>
          <Button onClick={createNew} disabled={creating}>
            {creating ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Plus className="h-4 w-4 mr-1.5" />
            )}
            New recipe
          </Button>
        </div>

        <div className="mt-6 flex items-center gap-2">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by name or description"
              className="pl-8"
            />
          </div>
        </div>

        <div className="mt-4 grid gap-3">
          {loading ? (
            <>
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </>
          ) : filtered.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {recipes.length === 0
                    ? "No recipes yet"
                    : "No recipes match your filter"}
                </CardTitle>
                <CardDescription>
                  {recipes.length === 0
                    ? "Create your first recipe to start merging files and templates as a single API call."
                    : "Clear the filter or try a different keyword."}
                </CardDescription>
              </CardHeader>
              {recipes.length === 0 && (
                <CardContent>
                  <Button onClick={createNew} disabled={creating}>
                    <Plus className="h-4 w-4 mr-1.5" />
                    New recipe
                  </Button>
                </CardContent>
              )}
            </Card>
          ) : (
            filtered.map((r) => (
              <Card
                key={r.id}
                className="transition-colors hover:border-primary/40"
              >
                <CardContent className="flex items-center gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/merge-recipes/${r.id}`}
                      title={r.name}
                      className="block truncate text-sm font-semibold hover:underline"
                    >
                      {r.name}
                    </Link>
                    {r.description && (
                      <p
                        className="mt-0.5 line-clamp-1 text-xs text-muted-foreground"
                        title={r.description}
                      >
                        {r.description}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="text-[10px]">
                        {r.componentCount}{" "}
                        {r.componentCount === 1 ? "component" : "components"}
                      </Badge>
                      {r.lastRunAt && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          Last run {timeAgo(r.lastRunAt)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/merge-recipes/${r.id}/integrate`}>
                        Integrate
                      </Link>
                    </Button>
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/merge-recipes/${r.id}`}>
                        Open
                        <ArrowRight className="h-3.5 w-3.5 ml-1" />
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(r)}
                      title="Delete recipe"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    </AppShell>
  );
}

function timeAgo(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}
