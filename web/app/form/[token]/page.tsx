"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  CheckCircle2,
  Download,
  FileSignature,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { API_URL } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type Schema = {
  token: string;
  title: string;
  description?: string;
  submitLabel: string;
  successMessage?: string;
  templateName: string;
  placeholders: string[];
};

export default function PublicFormPage() {
  const params = useParams<{ token: string }>();
  const [schema, setSchema] = useState<Schema | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ downloadUrl: string; name: string } | null>(
    null
  );

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_URL}/v1/public/forms/${params.token}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error?.message || "form not found");
        }
        const data: Schema = await res.json();
        setSchema(data);
        const init: Record<string, string> = {};
        for (const p of data.placeholders) init[p] = "";
        setValues(init);
      } catch (e: any) {
        setErr(e.message);
      }
    })();
  }, [params.token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!schema) return;
    setSubmitting(true);
    try {
      const payload = buildPayload(values);
      const res = await fetch(`${API_URL}/v1/public/forms/${schema.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: payload }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || "submission failed");
      }
      const json = await res.json();
      setDone({ downloadUrl: json.downloadUrl, name: json.outputName });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (err) {
    return (
      <PublicShell>
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-destructive/10 text-destructive">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <CardTitle className="text-center">Form unavailable</CardTitle>
          </CardHeader>
          <CardContent className="text-center text-sm text-muted-foreground">
            {err}
          </CardContent>
        </Card>
      </PublicShell>
    );
  }

  if (!schema) {
    return (
      <PublicShell>
        <Card className="w-full max-w-lg">
          <CardHeader>
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </PublicShell>
    );
  }

  if (done) {
    return (
      <PublicShell>
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-success/15 text-success">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <CardTitle className="text-center">
              {schema.successMessage || "Your document is ready"}
            </CardTitle>
            <CardDescription className="text-center">
              Thanks for your submission.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-3">
            <Button asChild size="lg">
              <a href={done.downloadUrl} download={done.name}>
                <Download className="h-4 w-4" />
                Download {done.name}
              </a>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDone(null);
                const init: Record<string, string> = {};
                for (const p of schema.placeholders) init[p] = "";
                setValues(init);
              }}
            >
              Submit another
            </Button>
          </CardContent>
        </Card>
      </PublicShell>
    );
  }

  return (
    <PublicShell>
      <Card className="w-full max-w-xl">
        <CardHeader>
          <div className="mb-1 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5" />
            {schema.templateName}
          </div>
          <CardTitle>{schema.title}</CardTitle>
          {schema.description && (
            <CardDescription>{schema.description}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {schema.placeholders.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                This template doesn&apos;t have placeholders yet. Ask the
                template owner to add <code className="font-mono">{"{{ .field }}"}</code>{" "}
                tokens and save.
              </p>
            ) : (
              schema.placeholders.map((p) => (
                <div key={p} className="space-y-1.5">
                  <Label htmlFor={`f-${p}`}>{humanizeKey(p)}</Label>
                  <Input
                    id={`f-${p}`}
                    value={values[p] || ""}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [p]: e.target.value }))
                    }
                    placeholder={p}
                  />
                </div>
              ))
            )}
            <Button
              type="submit"
              loading={submitting}
              disabled={schema.placeholders.length === 0}
              className="w-full"
            >
              {schema.submitLabel || "Submit"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </PublicShell>
  );
}

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-muted/40">
      <header className="border-b bg-background px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-5xl items-center gap-2 text-sm font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <FileSignature className="h-4 w-4" />
          </span>
          Drive360
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center p-6">
        {children}
      </div>
      <footer className="border-t bg-background px-4 py-3 text-center text-[11px] text-muted-foreground">
        Powered by Drive360 · Your submissions are delivered to the template owner.
      </footer>
    </div>
  );
}

function humanizeKey(k: string): string {
  const parts = k.split(/[._]/).map((w) => w.trim()).filter(Boolean);
  return parts
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// buildPayload unflattens "customer.name" → { customer: { name: ... } } so the
// template's dotted placeholders resolve naturally.
function buildPayload(flat: Record<string, string>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(flat)) {
    const parts = k.split(".");
    let cur: any = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (typeof cur[seg] !== "object" || cur[seg] === null) cur[seg] = {};
      cur = cur[seg];
    }
    cur[parts[parts.length - 1]] = flat[k];
  }
  return out;
}
