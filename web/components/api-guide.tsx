"use client";

// ApiGuide — the reusable body of the per-template integration docs.
//
// Two entry points render this component:
//
//   1. /templates/:id/api — the standalone page (full-screen, sharable
//      URL). Useful for linking directly in support replies, a viewer
//      who doesn't have the designer, or anyone who wants the guide
//      without the designer chrome around it.
//
//   2. The designer header's "API" button — mounts this inside a Sheet
//      so the editor can see the integration contract next to the
//      template they're editing, without losing their place. Changing
//      a mapping's required flag / validation rule and immediately
//      watching the guide reflect it is the fast-feedback loop we
//      want for authors.
//
// Everything rendered here is derived from GET /v1/templates/:id/schema.
// The component re-fetches on templateId change AND when `refreshKey`
// increments, so the designer can force a refresh after a save.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  FileCode,
  KeyRound,
  Shield,
  Terminal,
} from "lucide-react";
import { API_URL, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/toast";

export type SchemaField = {
  key: string;
  label?: string;
  type: string;
  required: boolean;
  default?: string;
  description?: string;
  constraints?: Record<string, any>;
  options?: string[];
  page?: number;
};

export type SchemaResp = {
  templateId: string;
  templateName: string;
  mode: string;
  endpoint: {
    url: string;
    method: string;
    contentType: string;
    authSchemes: string[];
  };
  fields: SchemaField[];
  jsonSchema: Record<string, any>;
  example: Record<string, any>;
  notes?: string[];
};

type Lang = "curl" | "js" | "python";

type Props = {
  templateId: string;
  /**
   * Bump to force a re-fetch. The designer increments this after a
   * successful save so the guide picks up new mappings / validation
   * rules without the user having to close and reopen the drawer.
   */
  refreshKey?: number;
  /**
   * Compact mode tightens spacing for the in-designer drawer (where
   * vertical space is tighter). The standalone page leaves it off.
   */
  compact?: boolean;
};

export function ApiGuide({ templateId, refreshKey = 0, compact = false }: Props) {
  const toast = useToast();
  const [schema, setSchema] = useState<SchemaResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>("curl");

  useEffect(() => {
    let cancelled = false;
    setSchema(null);
    setErr(null);
    (async () => {
      try {
        const s = await api<SchemaResp>(`/v1/templates/${templateId}/schema`);
        if (!cancelled) setSchema(s);
      } catch (e: any) {
        if (!cancelled) setErr(e.message || "Failed to load template schema");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [templateId, refreshKey]);

  // The schema's endpoint.url is relative (/v1/templates/:id/generate);
  // concatenating the configured API_URL gives a runnable absolute URL
  // so every copy-paste snippet works out of the box.
  const fullEndpoint = useMemo(() => {
    if (!schema) return "";
    return `${API_URL}${schema.endpoint.url}`;
  }, [schema]);

  const examplePayload = useMemo(() => {
    if (!schema) return "";
    return JSON.stringify({ data: schema.example, flatten: false }, null, 2);
  }, [schema]);

  const snippets = useMemo(() => {
    if (!schema) return { curl: "", js: "", python: "" };
    return buildSnippets(fullEndpoint, schema.example);
  }, [schema, fullEndpoint]);

  function copy(label: string, text: string) {
    navigator.clipboard.writeText(text).then(
      () => toast.show("success", `${label} copied`),
      () => toast.show("error", "Couldn't copy to clipboard")
    );
  }

  if (err) {
    return (
      <div className={compact ? "p-4" : "p-6"}>
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <div className="flex items-center gap-2 font-medium">
            <AlertCircle className="h-4 w-4" />
            Couldn&rsquo;t load API guide
          </div>
          <p className="mt-1 text-xs text-destructive/80">{err}</p>
        </div>
      </div>
    );
  }

  if (!schema) {
    return (
      <div className={(compact ? "p-4" : "p-6") + " space-y-4"}>
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const sectionSpacing = compact ? "space-y-6" : "space-y-8";
  const padding = compact ? "p-4" : "p-6";

  return (
    <div className={sectionSpacing + " " + padding}>
      <section>
        <p className="text-sm text-muted-foreground">
          Use this guide to wire document generation into your own system.
          Everything below is scoped to <em>this</em> template — the endpoint,
          the payload shape, validation rules, and copy-paste snippets are
          all derived from the template&rsquo;s current configuration.
        </p>
      </section>

      {/* --- Endpoint ------------------------------------------------- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          1. Endpoint
        </h3>
        <div className="rounded-lg border bg-muted/30 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="bg-emerald-600 font-mono text-[11px] uppercase text-white hover:bg-emerald-700">
              {schema.endpoint.method}
            </Badge>
            <code className="flex-1 break-all font-mono text-xs">
              {fullEndpoint}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => copy("Endpoint", fullEndpoint)}
            >
              <Copy className="h-3.5 w-3.5" />
              Copy
            </Button>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            Content-Type:{" "}
            <code className="font-mono">{schema.endpoint.contentType}</code>
          </div>
        </div>
      </section>

      {/* --- Auth ---------------------------------------------------- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          2. Authentication
        </h3>
        <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
          <div className="flex items-start gap-3">
            <Shield className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="space-y-1">
              <p>
                Send an <code className="font-mono">Authorization</code> header
                on every request. Two schemes are supported:
              </p>
              <ul className="ml-4 list-disc space-y-1 text-xs">
                {schema.endpoint.authSchemes.map((s) => (
                  <li key={s} className="font-mono">
                    {s}
                  </li>
                ))}
              </ul>
              <p className="pt-1 text-xs text-muted-foreground">
                For server-to-server calls use an API key (prefix{" "}
                <code className="font-mono">fk_</code>) — they don&rsquo;t
                expire with the user session and can be scoped to a single
                permission like{" "}
                <code className="font-mono">generate:write</code>.
              </p>
            </div>
          </div>
          <Separator />
          <Button size="sm" variant="outline" asChild>
            <Link href="/settings/api-keys">
              <KeyRound className="h-3.5 w-3.5" />
              Manage API keys
              <ExternalLink className="h-3 w-3 opacity-60" />
            </Link>
          </Button>
        </div>
      </section>

      {/* --- Payload ------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            3. Request body
          </h3>
          <span className="text-xs text-muted-foreground">
            {schema.fields.length} field
            {schema.fields.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Key</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Req.</th>
                <th className="px-3 py-2 text-left">Constraints</th>
                <th className="px-3 py-2 text-left">Notes</th>
              </tr>
            </thead>
            <tbody>
              {schema.fields.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-6 text-center text-xs text-muted-foreground"
                  >
                    No mappable fields — send an empty{" "}
                    <code className="font-mono">{`{}`}</code> for{" "}
                    <code className="font-mono">data</code>.
                  </td>
                </tr>
              ) : (
                schema.fields.map((f) => (
                  <tr
                    key={f.key}
                    className="border-b align-top last:border-b-0"
                  >
                    <td className="px-3 py-2 font-mono text-xs">{f.key}</td>
                    <td className="px-3 py-2 text-xs">
                      <Badge variant="outline" className="text-[10px]">
                        {f.type}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {f.required ? (
                        <span className="text-destructive">required</span>
                      ) : (
                        <span className="text-muted-foreground">optional</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{renderConstraints(f)}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {f.description ||
                        (f.label ? `PDF field: ${f.label}` : "—")}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <CodeBlock
          title="Example request body"
          onCopy={() => copy("Payload", examplePayload)}
        >
          {examplePayload}
        </CodeBlock>

        <details className="rounded-lg border bg-muted/10">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            JSON Schema (draft-07) — copy-paste for your own validator
          </summary>
          <div className="border-t">
            <CodeBlock
              onCopy={() =>
                copy("JSON Schema", JSON.stringify(schema.jsonSchema, null, 2))
              }
            >
              {JSON.stringify(schema.jsonSchema, null, 2)}
            </CodeBlock>
          </div>
        </details>
      </section>

      {/* --- Code snippets ------------------------------------------ */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          4. Code examples
        </h3>
        <div className="flex gap-1 rounded-lg border bg-muted/30 p-1">
          {(["curl", "js", "python"] as Lang[]).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              className={
                "rounded-md px-3 py-1.5 text-xs font-medium transition " +
                (lang === l
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {labelForLang(l)}
            </button>
          ))}
        </div>
        <CodeBlock
          icon={<Terminal className="h-3.5 w-3.5" />}
          onCopy={() => copy(labelForLang(lang), snippets[lang])}
        >
          {snippets[lang]}
        </CodeBlock>
      </section>

      {/* --- Responses ----------------------------------------------- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          5. Responses
        </h3>

        <ResponseCard
          status="200 OK"
          tone="success"
          title="Sync generation succeeded"
          body={`{
  "outputFileId": "b7e2…",
  "outputName": "${schema.templateName.replace(/[^\w-]/g, "_")}-filled-20250115-103412.pdf",
  "downloadUrl": "https://…presigned URL, 10-minute TTL…",
  "bytes": 48213
}`}
          note="Fetch `downloadUrl` within the TTL to retrieve the rendered PDF. The file is persisted under Drive → Outputs."
        />

        <ResponseCard
          status="202 Accepted"
          tone="info"
          title="Async mode"
          body={`{ "jobId": "a5c1…", "status": "queued" }`}
          note="Set `async: true` for long-running renders. Poll `GET /v1/jobs/:id` until `status === 'succeeded'`."
        />

        <ResponseCard
          status="422 Unprocessable Entity"
          tone="warn"
          title="Validation failed"
          body={`{
  "error": "validation_error",
  "fields": [
    { "field": "email", "dataKey": "email", "message": "must be a valid email" },
    { "field": "age",   "dataKey": "age",   "message": "must be ≥ 0" }
  ]
}`}
          note="Every failing field is returned in one response — fix them all before retrying. Schema-derived checks run before rendering, so these are cheap and deterministic."
        />

        <ResponseCard
          status="400 Bad Request"
          tone="warn"
          title="Malformed request"
          body={`{ "error": "invalid_body", "message": "…" }`}
          note="Returned on unparseable JSON or missing `data` object."
        />

        <ResponseCard
          status="401 / 403"
          tone="error"
          title="Auth problem"
          body={`{ "error": "unauthorized" }`}
          note="Missing / expired token (401), or the API key doesn't have the `generate:write` scope or the caller can't access this template (403)."
        />
      </section>

      {/* --- Optional fields + per-mode notes ----------------------- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          6. Request options
        </h3>
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <tbody className="divide-y">
              <tr>
                <td className="w-32 px-3 py-2 font-mono text-xs">flatten</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  boolean — flatten AcroForm fields into page content so the
                  output PDF can&rsquo;t be edited. Ignored on non-AcroForm
                  modes.
                </td>
              </tr>
              <tr>
                <td className="w-32 px-3 py-2 font-mono text-xs">async</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  boolean — queue the render and return a 202 with a{" "}
                  <code className="font-mono">jobId</code>. Poll{" "}
                  <code className="font-mono">/v1/jobs/:id</code>.
                </td>
              </tr>
              <tr>
                <td className="w-32 px-3 py-2 font-mono text-xs">preview</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  boolean — render without persisting to Drive. Returns an
                  inline-disposition presigned URL for embedding.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {schema.notes && schema.notes.length > 0 && (
        <section className="space-y-2 rounded-lg border border-amber-300/60 bg-amber-50/70 p-4 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
            <FileCode className="h-3.5 w-3.5" />
            Mode notes
          </h3>
          <ul className="list-disc pl-4 text-xs text-amber-900/90 dark:text-amber-200/90">
            {schema.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---- helpers --------------------------------------------------------------

function renderConstraints(f: SchemaField) {
  const parts: string[] = [];
  const c = f.constraints || {};
  if (c.minLength != null) parts.push(`min ${c.minLength} chars`);
  if (c.maxLength != null) parts.push(`max ${c.maxLength} chars`);
  if (c.pattern) parts.push(`pattern /${c.pattern}/`);
  if (c.min != null) parts.push(`≥ ${c.min}`);
  if (c.max != null) parts.push(`≤ ${c.max}`);
  if (c.minDate) parts.push(`≥ ${c.minDate}`);
  if (c.maxDate) parts.push(`≤ ${c.maxDate}`);
  if (f.options && f.options.length > 0) {
    parts.push(
      `one of: ${f.options.slice(0, 4).join(" | ")}${f.options.length > 4 ? "…" : ""}`
    );
  }
  if (parts.length === 0)
    return <span className="text-muted-foreground">—</span>;
  return <span className="font-mono text-[11px]">{parts.join("  •  ")}</span>;
}

function CodeBlock({
  children,
  onCopy,
  icon,
  title,
}: {
  children: string;
  onCopy: () => void;
  icon?: React.ReactNode;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative overflow-hidden rounded-lg border bg-slate-950 text-slate-100">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-xs">
        <div className="flex items-center gap-2 text-white/70">
          {icon}
          <span>{title || "Code"}</span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-white/80 hover:bg-white/10 hover:text-white"
          onClick={() => {
            onCopy();
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </>
          )}
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre px-4 py-3 font-mono text-[12px] leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

function ResponseCard({
  status,
  tone,
  title,
  body,
  note,
}: {
  status: string;
  tone: "success" | "info" | "warn" | "error";
  title: string;
  body: string;
  note: string;
}) {
  const color =
    tone === "success"
      ? "border-emerald-500/40 bg-emerald-500/5"
      : tone === "info"
      ? "border-sky-500/40 bg-sky-500/5"
      : tone === "warn"
      ? "border-amber-500/40 bg-amber-500/5"
      : "border-destructive/40 bg-destructive/5";
  return (
    <div className={"rounded-lg border p-4 " + color}>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <code className="font-mono text-xs">{status}</code>
        <span>{title}</span>
      </div>
      <pre className="overflow-x-auto rounded-md bg-slate-950 px-3 py-2 font-mono text-[12px] text-slate-100">
        {body}
      </pre>
      <p className="mt-2 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function labelForLang(l: Lang) {
  return l === "curl" ? "cURL" : l === "js" ? "JavaScript" : "Python";
}

// buildSnippets produces three ready-to-run snippets — cURL, JavaScript
// (fetch), and Python (requests) — pre-filled with the template's example
// payload.
function buildSnippets(endpoint: string, example: Record<string, any>) {
  const body = JSON.stringify({ data: example, flatten: false }, null, 2);
  const singleLine = JSON.stringify({ data: example, flatten: false });

  const curl = `curl -X POST '${endpoint}' \\
  -H 'Authorization: Bearer YOUR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '${singleLine.replace(/'/g, "'\\''")}'`;

  const js = `const res = await fetch(${JSON.stringify(endpoint)}, {
  method: "POST",
  headers: {
    Authorization: "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(${body.replace(/\n/g, "\n  ")}),
});

if (!res.ok) {
  const err = await res.json();
  throw new Error(err.error || res.statusText);
}

const { downloadUrl, outputFileId } = await res.json();
console.log("Generated:", outputFileId, downloadUrl);`;

  const python = `import requests

resp = requests.post(
    ${JSON.stringify(endpoint)},
    headers={
        "Authorization": "Bearer YOUR_API_KEY",
        "Content-Type": "application/json",
    },
    json=${toPythonLiteral({ data: example, flatten: false })},
)
resp.raise_for_status()

result = resp.json()
print("Generated:", result["outputFileId"], result["downloadUrl"])`;

  return { curl, js, python };
}

function toPythonLiteral(v: any, indent = 0): string {
  const pad = "    ".repeat(indent);
  const padInner = "    ".repeat(indent + 1);
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return (
      "[\n" +
      v.map((x) => padInner + toPythonLiteral(x, indent + 1)).join(",\n") +
      "\n" +
      pad +
      "]"
    );
  }
  if (typeof v === "object") {
    const entries = Object.entries(v);
    if (entries.length === 0) return "{}";
    return (
      "{\n" +
      entries
        .map(
          ([k, val]) =>
            padInner +
            JSON.stringify(k) +
            ": " +
            toPythonLiteral(val, indent + 1)
        )
        .join(",\n") +
      "\n" +
      pad +
      "}"
    );
  }
  return JSON.stringify(v);
}
