"use client";

// ApiExplorer renders a simple "try it out" panel on top of our
// /v1/openapi.json feed. We deliberately don't pull in swagger-ui or
// redoc — the spec is small, the UX is better with our own primitives,
// and we keep the bundle lean.

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Play, Loader2 } from "lucide-react";
import { API_URL, getToken } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Op = {
  summary?: string;
  operationId?: string;
  tags?: string[];
  parameters?: {
    name: string;
    in: "path" | "query";
    required?: boolean;
    description?: string;
  }[];
};

type Spec = {
  info?: { title?: string; version?: string; description?: string };
  paths: Record<string, Record<string, Op>>;
};

type Endpoint = {
  path: string;
  method: string;
  op: Op;
  tag: string;
};

export function ApiExplorer() {
  const [spec, setSpec] = useState<Spec | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API_URL}/v1/openapi.json`);
        if (!r.ok) throw new Error("failed to load spec");
        setSpec(await r.json());
      } catch (e: any) {
        setErr(e.message);
      }
    })();
  }, []);

  const grouped = useMemo(() => {
    if (!spec) return [] as { tag: string; items: Endpoint[] }[];
    const acc: Record<string, Endpoint[]> = {};
    for (const path of Object.keys(spec.paths)) {
      const byMethod = spec.paths[path];
      for (const method of Object.keys(byMethod)) {
        const op = byMethod[method] as Op;
        const tag = (op.tags && op.tags[0]) || "Misc";
        (acc[tag] ||= []).push({
          path,
          method: method.toUpperCase(),
          op,
          tag,
        });
      }
    }
    return Object.entries(acc)
      .map(([tag, items]) => ({
        tag,
        items: items.sort((a, b) => a.path.localeCompare(b.path)),
      }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [spec]);

  if (err) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        Could not load <code className="font-mono">/v1/openapi.json</code> —{" "}
        {err}
      </div>
    );
  }

  if (!spec) {
    return (
      <div className="space-y-1">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-background">
      <div className="border-b px-4 py-3">
        <div className="text-sm font-semibold">
          {spec.info?.title || "API"}{" "}
          <span className="font-normal text-muted-foreground">
            · v{spec.info?.version || "1.0.0"}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {spec.info?.description}
        </p>
      </div>
      <div className="divide-y">
        {grouped.map((group) => (
          <TagGroup key={group.tag} tag={group.tag} items={group.items} />
        ))}
      </div>
    </div>
  );
}

function TagGroup({ tag, items }: { tag: string; items: Endpoint[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium hover:bg-muted/40"
      >
        {open ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        {tag}
        <span className="ml-1 text-xs text-muted-foreground">
          · {items.length}
        </span>
      </button>
      {open && (
        <ul>
          {items.map((e) => (
            <Endpoint key={e.method + e.path} e={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

const METHOD_STYLES: Record<string, string> = {
  GET: "bg-sky-500/10 text-sky-700 border-sky-500/40",
  POST: "bg-emerald-500/10 text-emerald-700 border-emerald-500/40",
  PUT: "bg-amber-500/10 text-amber-700 border-amber-500/40",
  PATCH: "bg-amber-500/10 text-amber-700 border-amber-500/40",
  DELETE: "bg-destructive/10 text-destructive border-destructive/40",
};

function Endpoint({ e }: { e: Endpoint }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-muted/40"
      >
        <Badge
          variant="outline"
          className={cn(
            "font-mono text-[10px] min-w-[52px] justify-center",
            METHOD_STYLES[e.method]
          )}
        >
          {e.method}
        </Badge>
        <code className="font-mono text-xs">{e.path}</code>
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {e.op.summary}
        </span>
      </button>
      {open && <TryIt e={e} />}
    </li>
  );
}

function TryIt({ e }: { e: Endpoint }) {
  const [params, setParams] = useState<Record<string, string>>({});
  const [body, setBody] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{
    status: number;
    ms: number;
    body: string;
  } | null>(null);

  const pathParams = (e.op.parameters || []).filter((p) => p.in === "path");
  const queryParams = (e.op.parameters || []).filter((p) => p.in === "query");
  const canHaveBody = ["POST", "PUT", "PATCH"].includes(e.method);

  async function run() {
    setSending(true);
    setResult(null);
    try {
      let url = e.path;
      for (const p of pathParams) {
        const v = params[p.name];
        if (!v) throw new Error(`missing path param: ${p.name}`);
        url = url.replace(`{${p.name}}`, encodeURIComponent(v));
      }
      const qs = new URLSearchParams();
      for (const p of queryParams) {
        const v = params[p.name];
        if (v) qs.set(p.name, v);
      }
      const qsStr = qs.toString();
      if (qsStr) url += "?" + qsStr;

      const token = getToken();
      const start = Date.now();
      const r = await fetch(`${API_URL}${url}`, {
        method: e.method,
        headers: {
          ...(canHaveBody ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: canHaveBody && body ? body : undefined,
      });
      const ms = Date.now() - start;
      const text = await r.text();
      // Try to pretty-print JSON.
      let out = text;
      try {
        out = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* leave as-is */
      }
      setResult({ status: r.status, ms, body: out });
    } catch (err: any) {
      setResult({ status: 0, ms: 0, body: err.message });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3 border-t bg-muted/20 px-4 py-3">
      {pathParams.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs">Path parameters</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {pathParams.map((p) => (
              <Input
                key={p.name}
                placeholder={`${p.name}${p.description ? " — " + p.description : ""}`}
                value={params[p.name] || ""}
                onChange={(ev) =>
                  setParams((cur) => ({ ...cur, [p.name]: ev.target.value }))
                }
              />
            ))}
          </div>
        </div>
      )}

      {queryParams.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs">Query parameters</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {queryParams.map((p) => (
              <Input
                key={p.name}
                placeholder={`${p.name}${p.description ? " — " + p.description : ""}`}
                value={params[p.name] || ""}
                onChange={(ev) =>
                  setParams((cur) => ({ ...cur, [p.name]: ev.target.value }))
                }
              />
            ))}
          </div>
        </div>
      )}

      {canHaveBody && (
        <div className="space-y-1.5">
          <Label className="text-xs">Request body (JSON)</Label>
          <textarea
            className="min-h-[100px] w-full rounded-md border bg-background px-3 py-2 font-mono text-[11px]"
            value={body}
            onChange={(ev) => setBody(ev.target.value)}
            placeholder={"{ ... }"}
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button onClick={run} disabled={sending} size="sm">
          {sending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Send
        </Button>
        <span className="text-[11px] text-muted-foreground">
          Uses your current session token. API-key testing: sign in as the key
          owner, or call from curl/Postman with <code>Bearer fk_…</code>.
        </span>
      </div>

      {result && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs">
            <Badge
              variant="outline"
              className={cn(
                result.status >= 500
                  ? "text-destructive"
                  : result.status >= 400
                  ? "text-amber-600"
                  : result.status >= 200
                  ? "text-emerald-600"
                  : "text-muted-foreground"
              )}
            >
              {result.status || "ERR"}
            </Badge>
            <span className="text-muted-foreground tabular-nums">
              {result.ms} ms
            </span>
          </div>
          <pre className="max-h-64 overflow-auto rounded-md border bg-background p-3 font-mono text-[11px]">
            {result.body}
          </pre>
        </div>
      )}
    </div>
  );
}
