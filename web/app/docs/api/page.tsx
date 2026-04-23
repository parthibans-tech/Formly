"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  FileSignature,
  KeyRound,
  Terminal,
} from "lucide-react";
import { API_URL, getToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/ui/theme-toggle";

export default function ApiDocsPage() {
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    setHasToken(!!getToken());
  }, []);

  const apiBase = API_URL;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 md:px-6">
          {hasToken && (
            <Button variant="ghost" size="sm" asChild>
              <Link href="/drive">
                <ArrowLeft className="h-4 w-4" />
                Back to drive
              </Link>
            </Button>
          )}
          <Separator orientation="vertical" className="h-6" />
          <Link
            href="/docs/api"
            className="inline-flex items-center gap-2 text-sm font-semibold"
          >
            <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
              <FileSignature className="h-4 w-4" />
            </span>
            Formly · API docs
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            {hasToken && (
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings/api-keys">
                  <KeyRound className="h-4 w-4" />
                  API keys
                </Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-10 md:px-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <BookOpen className="h-3.5 w-3.5" />
            REST API · v1
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Programmatic access to your Formly workspace
          </h1>
          <p className="max-w-2xl text-muted-foreground">
            Every feature in the app is backed by a JSON REST endpoint. Create
            an API key from{" "}
            <Link
              href="/settings/api-keys"
              className="text-primary hover:underline"
            >
              Settings → API keys
            </Link>{" "}
            and pass it as a <code className="font-mono">Bearer</code> token.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5 text-primary" />
              Base URL
            </CardTitle>
            <CardDescription>
              Prefix all endpoints with this host.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
              {apiBase}
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Authentication</CardTitle>
            <CardDescription>
              Every protected endpoint expects{" "}
              <code className="font-mono">
                Authorization: Bearer &lt;token&gt;
              </code>
              . Tokens can be either a short-lived session JWT (used by the web
              app) or a long-lived API key (used by scripts &amp; CI).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px]">
              {`curl ${apiBase}/v1/me \\
  -H "Authorization: Bearer fk_live_…"`}
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick recipes</CardTitle>
            <CardDescription>
              Copy-paste examples covering the most common integrations.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <Recipe
              title="1. List files in the root folder"
              method="GET"
              path="/v1/files"
              body={`curl ${apiBase}/v1/files \\
  -H "Authorization: Bearer $FORMLY_KEY"`}
            />

            <Recipe
              title="2. Generate a filled PDF synchronously"
              method="POST"
              path="/v1/templates/{id}/generate"
              body={`curl -X POST ${apiBase}/v1/templates/TEMPLATE_ID/generate \\
  -H "Authorization: Bearer $FORMLY_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "data": {
      "invoice": { "number": "INV-2026-001", "paid": false },
      "items": [
        { "name": "Widget", "amount": 9.99 },
        { "name": "Gadget", "amount": 19.99 }
      ]
    }
  }'`}
              notes="Response includes a pre-signed download URL under `downloadUrl`."
            />

            <Recipe
              title="3. Run a batch (one PDF per CSV row)"
              method="POST"
              path="/v1/templates/{id}/batch"
              body={`curl -X POST ${apiBase}/v1/templates/TEMPLATE_ID/batch \\
  -H "Authorization: Bearer $FORMLY_KEY" \\
  -F "csv=@./contacts.csv"`}
              notes="Returns a jobId. Poll /v1/jobs/{jobId} until status == 'completed'."
            />

            <Recipe
              title="4. Override the locale per call"
              method="POST"
              path="/v1/templates/{id}/generate"
              body={`curl -X POST ${apiBase}/v1/templates/TEMPLATE_ID/generate \\
  -H "Authorization: Bearer $FORMLY_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "data": { "locale": "de-DE", "name": "Ada", "amount": 1234.56 } }'`}
              notes={'Currency, number and date formatters auto-localize; {{ t "…" }} looks up the right dictionary.'}
            />

            <Recipe
              title="5. Create a public share link"
              method="POST"
              path="/v1/files/{id}/share"
              body={`curl -X POST ${apiBase}/v1/files/FILE_ID/share \\
  -H "Authorization: Bearer $FORMLY_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "role": "viewer", "expiresIn": 604800 }'`}
              notes="Expiry is in seconds. 0 means never. Response includes the share token for building the /share/{token} URL."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Endpoint reference</CardTitle>
            <CardDescription>
              Everything the UI does, available over HTTP. All responses are
              JSON with <code className="font-mono">{`{ error: { code, message } }`}</code> on failure.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <EndpointGroup title="Auth / account">
              <Endpoint method="GET" path="/v1/me" />
              <Endpoint method="GET" path="/v1/api-keys" />
              <Endpoint method="POST" path="/v1/api-keys" />
              <Endpoint method="DELETE" path="/v1/api-keys/{id}" />
            </EndpointGroup>

            <EndpointGroup title="Files">
              <Endpoint method="POST" path="/v1/files/upload-url" />
              <Endpoint method="POST" path="/v1/files/{id}/complete" />
              <Endpoint method="GET" path="/v1/files" />
              <Endpoint method="GET" path="/v1/files/{id}" />
              <Endpoint method="PATCH" path="/v1/files/{id}" />
              <Endpoint method="GET" path="/v1/files/{id}/download" />
              <Endpoint method="DELETE" path="/v1/files/{id}" />
            </EndpointGroup>

            <EndpointGroup title="Folders">
              <Endpoint method="GET" path="/v1/folders" />
              <Endpoint method="POST" path="/v1/folders" />
              <Endpoint method="GET" path="/v1/folders/{id}/breadcrumbs" />
              <Endpoint method="PATCH" path="/v1/folders/{id}" />
              <Endpoint method="DELETE" path="/v1/folders/{id}" />
            </EndpointGroup>

            <EndpointGroup title="Templates">
              <Endpoint method="GET" path="/v1/templates/{id}" />
              <Endpoint method="PUT" path="/v1/templates/{id}/config" />
              <Endpoint method="GET" path="/v1/templates/{id}/preview-url" />
              <Endpoint method="GET" path="/v1/templates/{id}/source" />
              <Endpoint method="PUT" path="/v1/templates/{id}/source" />
              <Endpoint method="POST" path="/v1/templates/{id}/preview" />
              <Endpoint method="POST" path="/v1/templates/{id}/generate" />
              <Endpoint method="POST" path="/v1/templates/{id}/batch" />
              <Endpoint method="GET" path="/v1/templates/{id}/widgets" />
              <Endpoint method="PUT" path="/v1/templates/{id}/widgets" />
              <Endpoint method="GET" path="/v1/templates/{id}/versions" />
              <Endpoint method="POST" path="/v1/templates/{id}/versions/{ver}/restore" />
              <Endpoint method="POST" path="/v1/templates/blank-pdf" />
              <Endpoint method="POST" path="/v1/templates/form-builder" />
            </EndpointGroup>

            <EndpointGroup title="Mock data / jobs / sharing">
              <Endpoint method="GET" path="/v1/templates/{id}/mock-data" />
              <Endpoint method="POST" path="/v1/templates/{id}/mock-data" />
              <Endpoint method="DELETE" path="/v1/templates/{id}/mock-data/{setId}" />
              <Endpoint method="GET" path="/v1/jobs/{id}" />
              <Endpoint method="POST" path="/v1/files/{id}/share" />
              <Endpoint method="GET" path="/v1/files/{id}/shares" />
              <Endpoint method="DELETE" path="/v1/shares/{shareId}" />
              <Endpoint method="GET" path="/v1/public/shares/{token}" auth="public" />
            </EndpointGroup>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function Recipe({
  title,
  method,
  path,
  body,
  notes,
}: {
  title: string;
  method: string;
  path: string;
  body: string;
  notes?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <MethodBadge method={method} />
        <code className="font-mono text-xs text-muted-foreground">{path}</code>
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px]">
        {body}
      </pre>
      {notes && (
        <p className="text-xs text-muted-foreground">{notes}</p>
      )}
    </div>
  );
}

function EndpointGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}

function Endpoint({
  method,
  path,
  auth,
}: {
  method: string;
  path: string;
  auth?: "public";
}) {
  return (
    <li className="flex items-center gap-2 font-mono text-xs">
      <MethodBadge method={method} />
      <span>{path}</span>
      {auth === "public" && (
        <Badge variant="secondary" className="text-[9px]">
          public
        </Badge>
      )}
    </li>
  );
}

function MethodBadge({ method }: { method: string }) {
  const v =
    method === "GET"
      ? "secondary"
      : method === "DELETE"
      ? "destructive"
      : method === "POST" || method === "PUT" || method === "PATCH"
      ? "default"
      : "outline";
  return (
    <Badge variant={v as any} className="font-mono text-[10px]">
      {method}
    </Badge>
  );
}
