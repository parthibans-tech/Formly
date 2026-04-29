"use client";

// StarterApiGuide — per-starter API integration docs.
//
// Parallel to <ApiGuide> (which serves PDF templates), but for the
// TypeScript-defined starter templates. The big architectural
// difference: starter HTML lives in the client bundle and is sent
// inline on every export request, so we don't need a /schema fetch —
// every section here is synthesised from the `Starter` prop on render.
//
// Two entry points mount this:
//   1. /starters/:id/api      — standalone shareable page
//   2. The fill-page header   — wrapped in <StarterApiGuideSheet>
//
// Sections rendered:
//   1. Endpoint  (POST /v1/starters/:id/export and /save-to-drive)
//   2. Authentication (Bearer JWT or API key fk_…)
//   3. Request body (table derived from formSchema, falling back to
//      a flat dump of sampleData keys)
//   4. Example payload (shape: { html, data, customize, format, filename })
//   5. Code snippets (cURL / JS / Python — pre-filled with sampleData)
//   6. Responses (200, 400, 401, 413)
//   7. Notes — including the "fetch HTML once, POST many" pattern that
//      callers should adopt to keep the wire payload small.

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Check,
  Copy,
  ExternalLink,
  FileCode,
  Info,
  KeyRound,
  Shield,
  Terminal,
} from "lucide-react";
import { API_URL } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/toast";
import type { FormGroup, FormSchema, Starter } from "@/lib/starters/types";

type Lang = "curl" | "js" | "python";

type Props = {
  starter: Starter;
  /** Compact mode tightens spacing for the in-page drawer. */
  compact?: boolean;
};

// A row in the request-body table.
type FieldRow = {
  path: string;
  label: string;
  type: string;
  required: boolean;
  group?: string;
};

export function StarterApiGuide({ starter, compact = false }: Props) {
  const toast = useToast();
  const [lang, setLang] = useState<Lang>("curl");

  const exportEndpoint = `${API_URL}/v1/starters/${starter.id}/export`;
  const driveEndpoint = `${API_URL}/v1/starters/${starter.id}/save-to-drive`;

  const fields = useMemo(() => deriveFieldRows(starter), [starter]);

  // Three example payloads we render in the docs:
  //   - examplePayload:       full payload as it would go on the wire
  //                           (html truncated for display only)
  //   - displayData:          pretty-printed sampleData
  //   - htmlByteSize:         informs the "fetch HTML once" advice
  const htmlByteSize = useMemo(
    () => new Blob([starter.html]).size,
    [starter.html],
  );

  const displayData = useMemo(
    () => JSON.stringify(starter.sampleData, null, 2),
    [starter.sampleData],
  );

  const examplePayload = useMemo(
    () => buildExamplePayload(starter),
    [starter],
  );

  const snippets = useMemo(
    () => buildSnippets(exportEndpoint, starter),
    [exportEndpoint, starter],
  );

  function copy(label: string, text: string) {
    navigator.clipboard.writeText(text).then(
      () => toast.show("success", `${label} copied`),
      () => toast.show("error", "Couldn't copy to clipboard"),
    );
  }

  const sectionSpacing = compact ? "space-y-6" : "space-y-8";
  const padding = compact ? "p-4" : "p-6";

  return (
    <div className={sectionSpacing + " " + padding}>
      <section>
        <p className="text-sm text-muted-foreground">
          Generate <em>{starter.name}</em> documents from your own backend.
          Starter HTML lives in your bundle (or can be fetched once and
          cached) and is POSTed inline along with the runtime{" "}
          <code className="font-mono">data</code>. The endpoint validates,
          renders, and returns a presigned URL for the rendered file.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge variant="outline" className="text-[10px] uppercase">
            {starter.category}
          </Badge>
          {starter.tags.slice(0, 4).map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px]">
              {t}
            </Badge>
          ))}
        </div>
      </section>

      {/* --- Endpoint ------------------------------------------------- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          1. Endpoints
        </h3>

        <EndpointRow
          method="POST"
          url={exportEndpoint}
          label="Render &amp; download"
          note="Returns a presigned URL pointing at the rendered file."
          onCopy={() => copy("Export endpoint", exportEndpoint)}
        />
        <EndpointRow
          method="POST"
          url={driveEndpoint}
          label="Render &amp; save to Drive"
          note="Same payload — the rendered file lands in the caller's Drive instead of being returned directly."
          onCopy={() => copy("Save-to-drive endpoint", driveEndpoint)}
        />
        <p className="text-xs text-muted-foreground">
          Content-Type:{" "}
          <code className="font-mono">application/json</code>
        </p>
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
                Send an <code className="font-mono">Authorization</code>{" "}
                header on every request:
              </p>
              <ul className="ml-4 list-disc space-y-1 text-xs">
                <li className="font-mono">Bearer &lt;jwt&gt;</li>
                <li className="font-mono">Bearer fk_&lt;api_key&gt;</li>
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

      {/* --- Request body ------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            3. Request body
          </h3>
          <span className="text-xs text-muted-foreground">
            {fields.length} field{fields.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Path</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Req.</th>
                <th className="px-3 py-2 text-left">Group</th>
              </tr>
            </thead>
            <tbody>
              {fields.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-6 text-center text-xs text-muted-foreground"
                  >
                    This starter has no declared fields — send an empty
                    <code className="mx-1 font-mono">{"{}"}</code> for
                    <code className="mx-1 font-mono">data</code>.
                  </td>
                </tr>
              ) : (
                fields.map((f) => (
                  <tr
                    key={f.path}
                    className="border-b align-top last:border-b-0"
                  >
                    <td className="px-3 py-2 font-mono text-xs">{f.path}</td>
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
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {f.group ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border bg-sky-50/60 p-3 text-xs text-sky-900 dark:bg-sky-500/10 dark:text-sky-200">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">Wire-format options</p>
              <ul className="ml-4 list-disc space-y-1">
                <li>
                  <code className="font-mono">html</code> — the starter
                  template source. Required on every call. The full bundle
                  for this starter is{" "}
                  <strong>{(htmlByteSize / 1024).toFixed(1)} KB</strong>.
                  Cache it once and reuse — see notes below.
                </li>
                <li>
                  <code className="font-mono">data</code> — the value tree
                  consumed by the template (Mustache / Go-template tokens).
                  Schema shown above.
                </li>
                <li>
                  <code className="font-mono">customize</code> — optional{" "}
                  <code className="font-mono">{"{ primary, accent, font, density }"}</code>{" "}
                  — visual overrides applied at render time.
                </li>
                <li>
                  <code className="font-mono">format</code> —{" "}
                  <code className="font-mono">"pdf"</code> (default) or{" "}
                  <code className="font-mono">"html"</code>.
                </li>
                <li>
                  <code className="font-mono">filename</code> — the
                  download name; defaults to{" "}
                  <code className="font-mono">{starter.id}.pdf</code>.
                </li>
              </ul>
            </div>
          </div>
        </div>

        <CodeBlock
          title="Example request body"
          onCopy={() => copy("Payload", examplePayload)}
        >
          {examplePayload}
        </CodeBlock>

        <details className="rounded-lg border bg-muted/10">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            Sample <code className="font-mono">data</code> only — paste
            into your own validator / fixtures
          </summary>
          <div className="border-t">
            <CodeBlock onCopy={() => copy("Sample data", displayData)}>
              {displayData}
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
        <p className="text-xs text-muted-foreground">
          The snippets ship the HTML inline so they&rsquo;re self-contained.
          For production, fetch the HTML once at deploy time and reuse the
          string — see the production pattern below.
        </p>
      </section>

      {/* --- Responses ---------------------------------------------- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          5. Responses
        </h3>

        <ResponseCard
          status="200 OK"
          tone="success"
          title="Render succeeded"
          body={`{
  "outputFileId": "b7e2…",
  "outputName": "${starter.id}-20260430-103412.pdf",
  "downloadUrl": "https://…presigned URL, 10-minute TTL…",
  "bytes": 48213
}`}
          note="Fetch `downloadUrl` within the TTL to retrieve the rendered file. Save-to-Drive returns the same envelope plus the Drive `fileId`."
        />

        <ResponseCard
          status="400 Bad Request"
          tone="warn"
          title="Malformed request"
          body={`{ "error": { "code": "invalid_body", "message": "html is required" } }`}
          note="Returned when `html` is missing/empty, the JSON is unparseable, or `data` is not an object. Check the field table above before retrying."
        />

        <ResponseCard
          status="401 / 403"
          tone="error"
          title="Auth problem"
          body={`{ "error": { "code": "unauthorized", "message": "missing or invalid token" } }`}
          note="Missing / expired token (401), or the API key doesn't have the `generate:write` scope (403)."
        />

        <ResponseCard
          status="413 Payload Too Large"
          tone="warn"
          title="Body exceeds the size cap"
          body={`{ "error": { "code": "payload_too_large", "message": "request body exceeds 512KB" } }`}
          note="The export endpoint caps inbound bodies at 512 KB. If your `html` + `data` exceed that, strip unused branches from the HTML or split a list across multiple calls."
        />
      </section>

      {/* --- Production pattern ------------------------------------- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          6. Production pattern
        </h3>
        <div className="rounded-lg border bg-muted/30 p-4 text-sm">
          <p className="text-muted-foreground">
            Sending the HTML on every call is wasteful at scale. The
            recommended pattern is:
          </p>
          <ol className="mt-2 ml-5 list-decimal space-y-1 text-xs text-muted-foreground">
            <li>
              At deploy time, vendor the starter HTML into your codebase
              (or fetch once from a known URL and cache the string in
              memory / Redis).
            </li>
            <li>
              On each generate request, build{" "}
              <code className="font-mono">{"{ html: cached, data: …, format: \"pdf\" }"}</code>{" "}
              and POST it to the export endpoint.
            </li>
            <li>
              Stream the rendered file from the returned{" "}
              <code className="font-mono">downloadUrl</code> — or skip the
              extra hop and call <code className="font-mono">/save-to-drive</code>{" "}
              with the same body.
            </li>
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">
            This keeps each wire payload small (just the runtime{" "}
            <code className="font-mono">data</code> per request), and your
            integration stays pinned to a known-good HTML revision.
          </p>
        </div>
      </section>
    </div>
  );
}

// ---- helpers --------------------------------------------------------------

function EndpointRow({
  method,
  url,
  label,
  note,
  onCopy,
}: {
  method: string;
  url: string;
  label: string;
  note: string;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="bg-emerald-600 font-mono text-[11px] uppercase text-white hover:bg-emerald-700">
          {method}
        </Badge>
        <code className="flex-1 break-all font-mono text-xs">{url}</code>
        <Button size="sm" variant="outline" onClick={onCopy}>
          <Copy className="h-3.5 w-3.5" />
          Copy
        </Button>
      </div>
      <div
        className="mt-2 text-xs text-muted-foreground"
        // label is a static prop from this file (e.g. "Render &amp; download").
        dangerouslySetInnerHTML={{ __html: `<strong>${label}</strong> — ${note}` }}
      />
    </div>
  );
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

// deriveFieldRows produces the request-body field table. It prefers
// the starter's declared formSchema when present (richer types and
// labels) and falls back to a flat dump of sampleData keys so every
// starter still gets a usable table.
function deriveFieldRows(starter: Starter): FieldRow[] {
  if (starter.formSchema) {
    return rowsFromFormSchema(starter.formSchema);
  }
  return rowsFromSampleData(starter.sampleData, "");
}

function rowsFromFormSchema(schema: FormSchema): FieldRow[] {
  const rows: FieldRow[] = [];
  for (const g of schema.groups) {
    rows.push(...rowsFromGroup(g));
  }
  return rows;
}

function rowsFromGroup(g: FormGroup): FieldRow[] {
  switch (g.kind) {
    case "scalar":
      return [
        {
          path: g.path,
          label: g.label,
          type: g.type,
          required: !((g as any).optional ?? false),
          group: g.label,
        },
      ];
    case "object": {
      const out: FieldRow[] = [];
      for (const f of g.fields) {
        out.push({
          path: `${g.path}.${f.id}`,
          label: f.label,
          type: f.type,
          required: !f.optional,
          group: g.label,
        });
      }
      return out;
    }
    case "string-list":
      return [
        {
          path: `${g.path}[]`,
          label: g.label,
          type: "string[]",
          required: false,
          group: g.label,
        },
      ];
    case "object-list": {
      const out: FieldRow[] = [];
      for (const f of g.fields) {
        if ((f as any).type === "string-list") {
          out.push({
            path: `${g.path}[].${f.id}[]`,
            label: f.label,
            type: "string[]",
            required: false,
            group: g.label,
          });
        } else {
          const sf = f as { id: string; label: string; type: string; optional?: boolean };
          out.push({
            path: `${g.path}[].${sf.id}`,
            label: sf.label,
            type: sf.type,
            required: !sf.optional,
            group: g.label,
          });
        }
      }
      return out;
    }
  }
}

function rowsFromSampleData(
  obj: unknown,
  prefix: string,
  out: FieldRow[] = [],
): FieldRow[] {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && typeof obj[0] === "object" && obj[0] !== null) {
      rowsFromSampleData(obj[0], `${prefix}[]`, out);
    } else {
      out.push({
        path: prefix,
        label: prefix.split(".").pop() || prefix,
        type: arrayElementType(obj),
        required: false,
      });
    }
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        rowsFromSampleData(v, path, out);
      } else if (Array.isArray(v)) {
        rowsFromSampleData(v, path, out);
      } else {
        out.push({
          path,
          label: k,
          type: scalarTypeOf(v),
          required: true,
        });
      }
    }
    return out;
  }
  out.push({
    path: prefix,
    label: prefix.split(".").pop() || prefix,
    type: scalarTypeOf(obj),
    required: true,
  });
  return out;
}

function scalarTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return "date";
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "email";
    return "string";
  }
  return "string";
}

function arrayElementType(arr: unknown[]): string {
  if (arr.length === 0) return "any[]";
  return `${scalarTypeOf(arr[0])}[]`;
}

// buildExamplePayload renders the wire payload with HTML truncated for
// readability. The full HTML still goes on real requests — this is just
// for display.
function buildExamplePayload(starter: Starter): string {
  const previewHtml =
    starter.html.length > 200
      ? starter.html.slice(0, 200) + "\n  …truncated for display — send full HTML on real requests…\n"
      : starter.html;
  return JSON.stringify(
    {
      html: previewHtml,
      data: starter.sampleData,
      customize: { primary: "#0F172A", accent: "#2563EB" },
      format: "pdf",
      filename: `${starter.id}.pdf`,
    },
    null,
    2,
  );
}

// buildSnippets produces three runnable snippets — pre-filled with the
// starter's sampleData. The HTML is sent inline as a placeholder string
// so the snippets compile/run; in production callers replace it with a
// cached copy of the starter HTML.
function buildSnippets(endpoint: string, starter: Starter) {
  const data = starter.sampleData;
  const filename = `${starter.id}.pdf`;
  const htmlPlaceholder = `/* paste the contents of ${starter.id}.html here */`;

  // For cURL we want a one-liner, but real HTML is huge — show the
  // structure with a placeholder so users see exactly which fields go
  // where.
  const curlBody = JSON.stringify(
    {
      html: "<<TEMPLATE_HTML>>",
      data,
      format: "pdf",
      filename,
    },
    null,
    2,
  );
  const curl = `# 1. Save the starter HTML next to your script:
#    curl -o ${starter.id}.html https://your-cdn/starters/${starter.id}.html
#
# 2. Generate a document from it:
HTML=$(cat ${starter.id}.html)
PAYLOAD=$(jq -n --arg html "$HTML" --argjson data '${JSON.stringify(data)}' \\
  '{html:$html, data:$data, format:"pdf", filename:"${filename}"}')

curl -X POST '${endpoint}' \\
  -H 'Authorization: Bearer YOUR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -d "$PAYLOAD"

# Reference payload shape (HTML omitted for brevity):
# ${curlBody.replace(/\n/g, "\n# ")}`;

  const js = `// Cache the starter HTML at boot — don't re-fetch per request.
import templateHtml from "./${starter.id}.html?raw"; // Vite/webpack raw import
// or: const templateHtml = await fs.promises.readFile("./${starter.id}.html", "utf8");

const data = ${JSON.stringify(data, null, 2).replace(/\n/g, "\n  ")};

const res = await fetch(${JSON.stringify(endpoint)}, {
  method: "POST",
  headers: {
    Authorization: "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    html: templateHtml,
    data,
    format: "pdf",
    filename: ${JSON.stringify(filename)},
  }),
});

if (!res.ok) {
  const err = await res.json();
  throw new Error(err.error?.message || res.statusText);
}

const { downloadUrl, outputFileId } = await res.json();
console.log("Generated:", outputFileId, downloadUrl);`;

  const python = `import json, pathlib, requests

# Cache the HTML on disk and load once at boot.
TEMPLATE_HTML = pathlib.Path("${starter.id}.html").read_text()

data = ${toPythonLiteral(data)}

resp = requests.post(
    ${JSON.stringify(endpoint)},
    headers={
        "Authorization": "Bearer YOUR_API_KEY",
        "Content-Type": "application/json",
    },
    json={
        "html": TEMPLATE_HTML,
        "data": data,
        "format": "pdf",
        "filename": ${JSON.stringify(filename)},
    },
)
resp.raise_for_status()

result = resp.json()
print("Generated:", result["outputFileId"], result["downloadUrl"])`;

  // Suppress unused-binding warnings for the placeholder var while
  // keeping it close to where it would be referenced.
  void htmlPlaceholder;

  return { curl, js, python };
}

function toPythonLiteral(v: unknown, indent = 0): string {
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
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return (
      "{\n" +
      entries
        .map(
          ([k, val]) =>
            padInner +
            JSON.stringify(k) +
            ": " +
            toPythonLiteral(val, indent + 1),
        )
        .join(",\n") +
      "\n" +
      pad +
      "}"
    );
  }
  return JSON.stringify(v);
}
