"use client";

// Merge Recipe — Integrate panel.
//
// The "I want to call this from my app" surface. We hit
// /v1/merge-recipes/{id}/schema to get:
//   • the run endpoint URL,
//   • a JSON Schema for the request envelope (data + async + outputName),
//   • a sample example payload,
//   • per-component breakdown so the integrator can see which template
//     reads from which data sub-key.
//
// Then we render copy-paste cURL / fetch / Python snippets, plus a
// small "Try it" form that POSTs the example with the user's session
// JWT so they can prove the recipe works end-to-end before wiring API
// keys in their app.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Clipboard,
  Code2,
  ExternalLink,
  Layers,
  Loader2,
  Play,
  ShieldCheck,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { ApiError, API_URL, api, getToken } from "@/lib/api";
import { useToast } from "@/components/toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";

type ComponentSummary = {
  id: string;
  position: number;
  kind: "file" | "template";
  fileId?: string;
  templateId?: string;
  pages: string;
  dataKey: string;
  required: boolean;
  flatten: boolean;
  label?: string;
  sourceName?: string;
};

type SchemaResp = {
  recipeId: string;
  recipeName: string;
  endpoint: {
    url: string;
    method: string;
    contentType: string;
    authSchemes: string[];
  };
  components: ComponentSummary[];
  jsonSchema: any;
  example: { data: Record<string, any>; outputName?: string };
  notes: string[];
};

type Tab = "curl" | "fetch" | "python";

export default function RecipeIntegratePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();

  const [schema, setSchema] = useState<SchemaResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("curl");
  const [trying, setTrying] = useState(false);
  const [tryResult, setTryResult] = useState<any>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    (async () => {
      setLoading(true);
      try {
        const r = await api<SchemaResp>(
          `/v1/merge-recipes/${params.id}/schema`
        );
        setSchema(r);
      } catch (e: any) {
        toast.show("error", "Couldn't load schema", { description: e.message });
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  const examplePretty = useMemo(
    () => (schema ? JSON.stringify(schema.example, null, 2) : ""),
    [schema]
  );

  const fullURL = useMemo(
    () => (schema ? `${API_URL}${schema.endpoint.url}` : ""),
    [schema]
  );

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(
      () => toast.show("success", `${label} copied`),
      () => toast.show("error", "Copy failed")
    );
  }

  async function tryIt() {
    if (!schema) return;
    setTrying(true);
    setTryResult(null);
    try {
      const r = await api(`/v1/merge-recipes/${schema.recipeId}/run`, {
        method: "POST",
        body: JSON.stringify(schema.example),
      });
      setTryResult(r);
      toast.show("success", "Run succeeded — see result below");
    } catch (e: any) {
      const msg =
        e instanceof ApiError
          ? `${e.code}: ${e.message}`
          : e.message || "request failed";
      setTryResult({ error: msg });
      toast.show("error", "Run failed", { description: msg });
    } finally {
      setTrying(false);
    }
  }

  if (loading) {
    return (
      <AppShell>
        <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6">
          <Skeleton className="h-32 w-full" />
        </div>
      </AppShell>
    );
  }
  if (!schema) return null;

  const curl = curlSnippet(fullURL, schema.example);
  const fetchJS = fetchSnippet(fullURL, schema.example);
  const py = pythonSnippet(fullURL, schema.example);

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6 md:py-8">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/merge-recipes/${params.id}`}>
              <ArrowLeft className="h-4 w-4" />
              Back to recipe
            </Link>
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <Layers className="h-5 w-5 text-primary" />
          <h1 className="text-base font-semibold">{schema.recipeName}</h1>
          <Badge variant="outline" className="text-[10px] uppercase">
            Integrate
          </Badge>
        </div>

        {/* ----- Endpoint ----- */}
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">Endpoint</CardTitle>
            <CardDescription>
              POST this URL with the JSON envelope below to run the recipe.
              The response contains the new file's id, name, and size (or a
              jobId if you flip <code>async:true</code>).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-[10px] uppercase">
                {schema.endpoint.method}
              </Badge>
              <code className="flex-1 rounded bg-muted px-2 py-1 text-xs">
                {fullURL}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => copy(fullURL, "URL")}
              >
                <Clipboard className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="rounded-md border bg-muted/40 p-3 text-xs">
              <div className="font-medium mb-1.5 flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5" />
                Authorization
              </div>
              <ul className="space-y-1 list-disc pl-4 text-muted-foreground">
                {schema.endpoint.authSchemes.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <p className="mt-2 text-muted-foreground">
                Generate API keys in{" "}
                <Link
                  className="underline"
                  href="/settings/api-keys"
                >
                  Settings → API keys
                </Link>{" "}
                with scopes <code>merge:read</code> and{" "}
                <code>merge:write</code>.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ----- Components summary ----- */}
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">What this recipe runs</CardTitle>
            <CardDescription>
              Components are merged in this order. Templates pull data
              from <code>data[dataKey]</code>; static files are appended
              as-is (with optional page subset).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {schema.components.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-2 rounded-md border bg-card p-2 text-sm"
              >
                <Badge variant="outline" className="text-[10px]">
                  #{c.position + 1}
                </Badge>
                <Badge
                  variant={c.kind === "template" ? "default" : "secondary"}
                  className="text-[10px] uppercase"
                >
                  {c.kind}
                </Badge>
                <span
                  className="truncate min-w-0 flex-1"
                  title={c.sourceName || c.fileId || c.templateId}
                >
                  {c.sourceName || c.fileId || c.templateId}
                </span>
                {c.kind === "template" && c.dataKey && (
                  <Badge variant="outline" className="text-[10px]">
                    data.{c.dataKey}
                  </Badge>
                )}
                {c.pages && c.pages !== "all" && (
                  <Badge variant="outline" className="text-[10px]">
                    pages: {c.pages}
                  </Badge>
                )}
                {!c.required && (
                  <Badge variant="outline" className="text-[10px] uppercase">
                    optional
                  </Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* ----- Payload + snippets ----- */}
        <Card className="mt-4">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Request payload</CardTitle>
              <CardDescription>
                Sample, ready to copy. Replace the values with your real
                data when wiring it from your app.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => copy(examplePretty, "Payload")}
            >
              <Clipboard className="h-3.5 w-3.5 mr-1" />
              Copy JSON
            </Button>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
              {examplePretty}
            </pre>
          </CardContent>
        </Card>

        <Card className="mt-4">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Code2 className="h-4 w-4" />
                Snippets
              </CardTitle>
              <CardDescription>
                Plumbing for the most common stacks. Paste the API key
                value where it says <code>fk_…</code>.
              </CardDescription>
            </div>
            <div className="flex gap-1">
              {(["curl", "fetch", "python"] as Tab[]).map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={tab === t ? "default" : "outline"}
                  onClick={() => setTab(t)}
                >
                  {t}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            <div className="relative">
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                {tab === "curl" && curl}
                {tab === "fetch" && fetchJS}
                {tab === "python" && py}
              </pre>
              <Button
                size="sm"
                variant="ghost"
                className="absolute right-2 top-2"
                onClick={() => {
                  const txt =
                    tab === "curl" ? curl : tab === "fetch" ? fetchJS : py;
                  copy(txt, "Snippet");
                }}
              >
                <Clipboard className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ----- Try it ----- */}
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">Try it</CardTitle>
            <CardDescription>
              Runs the example payload against your session — useful for
              proving the recipe works before wiring API keys. The
              resulting file lands in your drive.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button onClick={tryIt} disabled={trying}>
              {trying ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-1.5" />
              )}
              Run with example data
            </Button>
            {tryResult && (
              <div className="rounded-md border bg-muted/40 p-3 text-xs">
                {tryResult.fileId ? (
                  <div className="flex min-w-0 items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    <span className="min-w-0 truncate">
                      Created{" "}
                      <strong title={tryResult.name}>{tryResult.name}</strong>{" "}
                      ({tryResult.size} bytes)
                    </span>
                    <Button asChild size="sm" variant="ghost" className="ml-auto shrink-0">
                      <Link href={`/drive?file=${tryResult.fileId}`}>
                        <ExternalLink className="h-3.5 w-3.5 mr-1" />
                        Open in drive
                      </Link>
                    </Button>
                  </div>
                ) : tryResult.jobId ? (
                  <span>
                    Async — job id <code>{tryResult.jobId}</code>. Poll{" "}
                    <code>GET /v1/merge-jobs/{tryResult.jobId}</code> until
                    status is <code>done</code>.
                  </span>
                ) : (
                  <pre className="overflow-x-auto">
                    {JSON.stringify(tryResult, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ----- Notes ----- */}
        {schema.notes && schema.notes.length > 0 && (
          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="text-base">Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc pl-4 space-y-1 text-sm text-muted-foreground">
                {schema.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}

// =====================================================================
//   Snippet builders — keep them dumb-stringy so a curious integrator
//   can copy without surprises (no smart quotes, no extra escaping).
// =====================================================================

function curlSnippet(url: string, payload: any): string {
  const body = JSON.stringify(payload, null, 2);
  return `curl -X POST '${url}' \\
  -H 'Authorization: Bearer fk_YOUR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '${escapeForShell(body)}'`;
}

function fetchSnippet(url: string, payload: any): string {
  return `// Node 18+ / browser fetch
const res = await fetch('${url}', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer fk_YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(${JSON.stringify(payload, null, 2)}),
});
if (!res.ok) throw new Error(await res.text());
const out = await res.json();
console.log(out.fileId, out.name);`;
}

function pythonSnippet(url: string, payload: any): string {
  return `# pip install requests
import requests

res = requests.post(
    '${url}',
    headers={
        'Authorization': 'Bearer fk_YOUR_API_KEY',
        'Content-Type': 'application/json',
    },
    json=${JSON.stringify(payload, null, 4).replace(/^/gm, "    ").trimStart()},
)
res.raise_for_status()
out = res.json()
print(out['fileId'], out['name'])`;
}

function escapeForShell(s: string): string {
  // Single-quoted shell strings: replace ' with '\''
  return s.replace(/'/g, "'\\''");
}
