"use client";

// Smart Search — semantic file search powered by the backend's
// /v1/files/search endpoint (vector embeddings against file_chunks).
//
// Why a dedicated page instead of folding into the global header search:
//
//   - The header search is instant filename match across the user's
//     drive — sub-100ms, no model call. Smart Search is a model round
//     trip per query, so it earns its own surface where the latency
//     and the cost (when an SLA matters) is visible to the user.
//   - Result shape differs. Header search returns "files whose name
//     contains X"; Smart Search returns "files whose CONTENT is
//     semantically related to X" with a per-result snippet. They
//     answer different questions.
//
// The whole page is wrapped in <AIFeature feature="smartSearch"> so it
// disappears entirely when AI is off (or the active provider lacks the
// Embed capability — Anthropic-only deployments hit this branch). When
// it does render, the off-state default returned by useAIConfig keeps
// it hidden until the config fetch resolves, so we don't flash the
// search UI to a viewer who'll never see it.

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api";
import { AppShell } from "@/components/app-shell";
import { AIFeature } from "@/components/ai-feature";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/toast";

type Hit = {
  fileId: string;
  name: string;
  mime: string;
  snippet: string;
  score: number;
  chunkIdx: number;
  updatedAt: string;
};

type SearchResponse = {
  query: string;
  results: Hit[];
};

export default function SmartSearchPage() {
  return (
    <AIFeature
      feature="smartSearch"
      fallback={
        <AppShell>
          <DisabledState />
        </AppShell>
      }
    >
      <SmartSearchInner />
    </AIFeature>
  );
}

function SmartSearchInner() {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [loading, setLoading] = useState(false);

  const runSearch = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      setLoading(true);
      setSubmitted(trimmed);
      try {
        const params = new URLSearchParams({ q: trimmed, limit: "20" });
        const res = await api<SearchResponse>(
          `/v1/files/search?${params.toString()}`,
        );
        setHits(res.results || []);
      } catch (e: any) {
        // 503 ai_disabled bubbles up here too — but the AIFeature gate
        // above should have hidden the page already. Treat it as a
        // user-visible toast rather than a silent swallow.
        const msg = e?.message || "Search failed";
        toast.show("error", msg);
        setHits([]);
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="space-y-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-semibold">Smart search</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Search by meaning, not just filename. Type a question or phrase and
            we&rsquo;ll surface files whose contents look semantically related.
          </p>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSearch(query);
          }}
          className="flex gap-2"
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. 'invoices from last quarter that mention renewal'"
              className="pl-9"
              autoFocus
              maxLength={1024}
              aria-label="Search query"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Button type="submit" disabled={loading || !query.trim()}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Searching
              </>
            ) : (
              "Search"
            )}
          </Button>
        </form>

        <Results
          loading={loading}
          submitted={submitted}
          hits={hits}
          onOpen={(fileId) => router.push(`/drive?focus=${fileId}`)}
        />
      </div>
    </AppShell>
  );
}

function Results({
  loading,
  submitted,
  hits,
  onOpen,
}: {
  loading: boolean;
  submitted: string;
  hits: Hit[] | null;
  onOpen: (fileId: string) => void;
}) {
  if (loading) {
    return (
      <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        Embedding your query and ranking matches…
      </div>
    );
  }
  if (hits === null) {
    return (
      <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        Results will appear here.
      </div>
    );
  }
  if (hits.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        No matches for <span className="font-medium">{submitted}</span>. Try
        rephrasing — Smart Search reads file contents, so describe what the
        file is <em>about</em> rather than the filename.
      </div>
    );
  }
  return (
    <ul className="divide-y rounded-md border bg-card">
      {hits.map((hit) => (
        <li key={`${hit.fileId}-${hit.chunkIdx}`}>
          <button
            type="button"
            onClick={() => onOpen(hit.fileId)}
            className="flex w-full flex-col gap-1 px-4 py-3 text-left transition hover:bg-accent/40"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium">{hit.name}</span>
              <span
                className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
                title={`Cosine similarity ${hit.score.toFixed(3)}`}
              >
                {(hit.score * 100).toFixed(0)}%
              </span>
            </div>
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {hit.snippet}
            </p>
            <div className="text-[11px] text-muted-foreground/80">
              {hit.mime || "unknown type"} · updated{" "}
              {new Date(hit.updatedAt).toLocaleDateString()}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function DisabledState() {
  return (
    <div className="rounded-md border border-dashed p-10 text-center">
      <h1 className="text-lg font-semibold">Smart search isn&rsquo;t enabled</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Ask your administrator to enable AI features for this workspace, or
        switch the active provider to one that supports embeddings (Ollama or
        vLLM).
      </p>
    </div>
  );
}
