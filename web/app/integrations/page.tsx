"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Blocks,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  KeyRound,
  Plug,
  Terminal,
  Webhook,
  Zap,
} from "lucide-react";
import { API_URL, api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { AppShell } from "@/components/app-shell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type Template = { id: string; name: string };

export default function IntegrationsPage() {
  const toast = useToast();
  const [apiBase, setApiBase] = useState(API_URL);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [open, setOpen] = useState<string | null>("zapier");

  useEffect(() => {
    setApiBase(API_URL);
    (async () => {
      try {
        const r = await api<{ files: any[] }>("/v1/files?view=templates");
        setTemplates(
          r.files.map((f: any) => ({ id: f.templateId, name: f.name }))
        );
      } catch {
        /* non-fatal; recipes work without it */
      }
    })();
  }, []);

  const sampleTpl = templates[0]?.id || "TEMPLATE_ID";

  async function copy(text: string, note: string) {
    await navigator.clipboard.writeText(text);
    toast.show("success", `Copied — ${note}`);
  }

  return (
    <AppShell>
      <div className="mb-6">
        <div className="mb-2 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Plug className="h-3.5 w-3.5" />
          Automation
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Connect Formly to 7 000+ apps
        </h1>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          Zapier, Make, and n8n all work with Formly out of the box via two
          primitives: <strong>API keys</strong> for outgoing calls, and{" "}
          <strong>Webhooks</strong> for incoming events. No custom connector
          required — both sides already speak HTTP + JSON.
        </p>
      </div>

      {/* Prereqs */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Before you start</CardTitle>
          <CardDescription>
            Two one-time prerequisites, then any of the providers below work.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <PrereqCard
            number="1"
            icon={KeyRound}
            title="Create an API key"
            description="Formly uses Bearer tokens to authenticate every call. Create a key and paste it into your automation platform's credentials step."
            cta={
              <Button asChild size="sm" variant="outline">
                <Link href="/settings/api-keys">
                  <KeyRound className="h-4 w-4" />
                  Open API keys
                </Link>
              </Button>
            }
          />
          <PrereqCard
            number="2"
            icon={Webhook}
            title="(Optional) Add a webhook"
            description="If your automation reacts to events inside Formly (e.g. a generated PDF), add a webhook pointing at the Catch Hook URL your provider gave you."
            cta={
              <Button asChild size="sm" variant="outline">
                <Link href="/settings/webhooks">
                  <Webhook className="h-4 w-4" />
                  Open Webhooks
                </Link>
              </Button>
            }
          />
        </CardContent>
      </Card>

      {/* Providers */}
      <div className="space-y-3">
        <ProviderCard
          id="zapier"
          name="Zapier"
          tagline="7 000+ apps · no-code"
          gradient="from-orange-500 to-amber-500"
          logo={<Zap className="h-5 w-5" />}
          open={open === "zapier"}
          onToggle={() => setOpen((c) => (c === "zapier" ? null : "zapier"))}
          apiBase={apiBase}
          sampleTpl={sampleTpl}
          onCopy={copy}
          docsURL="https://zapier.com/app/editor"
          triggerHint="Use Zapier → Webhooks by Zapier → Catch Hook. Paste the URL Zapier shows into a Formly webhook subscription."
          actionHint="In a Zapier action step, pick Webhooks by Zapier → POST, then plug in the snippet below."
        />

        <ProviderCard
          id="make"
          name="Make"
          tagline="Visual flows · formerly Integromat"
          gradient="from-fuchsia-500 to-indigo-500"
          logo={<Blocks className="h-5 w-5" />}
          open={open === "make"}
          onToggle={() => setOpen((c) => (c === "make" ? null : "make"))}
          apiBase={apiBase}
          sampleTpl={sampleTpl}
          onCopy={copy}
          docsURL="https://www.make.com/en/help/tools/webhooks"
          triggerHint="Add a Custom webhook module in Make. Copy its address into a Formly webhook."
          actionHint="Use the HTTP module → Make a request. Method POST, URL as below, plus an Authorization header."
        />

        <ProviderCard
          id="n8n"
          name="n8n"
          tagline="Self-hosted · open source"
          gradient="from-rose-500 to-pink-500"
          logo={<Blocks className="h-5 w-5" />}
          open={open === "n8n"}
          onToggle={() => setOpen((c) => (c === "n8n" ? null : "n8n"))}
          apiBase={apiBase}
          sampleTpl={sampleTpl}
          onCopy={copy}
          docsURL="https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/"
          triggerHint="Drop a Webhook node. Use the test or production URL as the destination in a Formly webhook."
          actionHint="An HTTP Request node with method POST covers outbound calls; use the snippet below as a template."
        />

        <ProviderCard
          id="curl"
          name="cURL / scripts"
          tagline="Bash, Python, anything that speaks HTTP"
          gradient="from-emerald-500 to-teal-500"
          logo={<Terminal className="h-5 w-5" />}
          open={open === "curl"}
          onToggle={() => setOpen((c) => (c === "curl" ? null : "curl"))}
          apiBase={apiBase}
          sampleTpl={sampleTpl}
          onCopy={copy}
          docsURL="/docs/api"
          triggerHint="Point any HTTP listener (ngrok, a tiny Flask handler, etc.) at the URL you configure in Formly webhooks."
          actionHint="Same Bearer + JSON as the rest of the REST API. See the docs page for the full endpoint reference."
          plainDocsLabel="View API docs"
        />
      </div>

      {/* Verification section */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Verifying inbound signatures</CardTitle>
          <CardDescription>
            When Formly posts to your automation platform, every request
            carries a <code className="font-mono text-xs">Formly-Signature</code>{" "}
            header. Zapier / Make / n8n can call a small code step to verify it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px]">
{`// Node code step (works in Zapier "Code by Zapier", Make "Tools › Execute JavaScript",
// n8n "Code" node). Set FORMLY_SIG in the incoming webhook's headers.
const crypto = require("crypto");
const [tPart, sigPart] = inputData.signature.split(",");
const t = tPart.split("=")[1];
const sig = sigPart.split("=")[1];
const expected = crypto
  .createHmac("sha256", inputData.secret)
  .update(\`\${t}.\${inputData.rawBody}\`)
  .digest("hex");
output = { ok: crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) };`}
          </pre>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Need help?</CardTitle>
          <CardDescription>
            Every provider follows the same two patterns. If you can describe
            your automation as &quot;when X happens, send Y to Z,&quot; pick:
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border bg-card p-3">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Formly → external
              </div>
              <p className="text-muted-foreground">
                Use a <strong>Formly webhook</strong>. Your automation platform
                receives a JSON POST with the event name and payload. Fan out
                to CRMs, Slack, email, spreadsheets — anything your platform
                supports.
              </p>
            </div>
            <div className="rounded-md border bg-card p-3">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                External → Formly
              </div>
              <p className="text-muted-foreground">
                Use a <strong>Formly API key</strong>. Your automation platform
                posts to <code className="font-mono text-[11px]">/v1/templates/{"{id}"}/generate</code>{" "}
                (or <code className="font-mono text-[11px]">/send</code>, or any
                other endpoint in the docs).
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </AppShell>
  );
}

// -- Prereq card ----------------------------------------------------------

function PrereqCard({
  number,
  icon: Icon,
  title,
  description,
  cta,
}: {
  number: string;
  icon: any;
  title: string;
  description: string;
  cta: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-md border bg-card p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
          {number}
        </span>
        <Icon className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{description}</p>
      <div className="mt-auto">{cta}</div>
    </div>
  );
}

// -- Provider card --------------------------------------------------------

function ProviderCard({
  id,
  name,
  tagline,
  gradient,
  logo,
  open,
  onToggle,
  apiBase,
  sampleTpl,
  onCopy,
  docsURL,
  triggerHint,
  actionHint,
  plainDocsLabel,
}: {
  id: string;
  name: string;
  tagline: string;
  gradient: string;
  logo: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  apiBase: string;
  sampleTpl: string;
  onCopy: (text: string, note: string) => Promise<void>;
  docsURL: string;
  triggerHint: string;
  actionHint: string;
  plainDocsLabel?: string;
}) {
  const postSnippet = `curl -X POST ${apiBase}/v1/templates/${sampleTpl}/generate \\
  -H "Authorization: Bearer fk_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{ "data": { "name": "{{trigger.contact_name}}", "amount": "{{trigger.amount}}" } }'`;

  const sendSnippet = `curl -X POST ${apiBase}/v1/templates/${sampleTpl}/send \\
  -H "Authorization: Bearer fk_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "data": { "name": "{{trigger.contact_name}}" },
    "to": ["{{trigger.email}}"],
    "subject": "Your document",
    "body": "Please find your document attached."
  }'`;

  return (
    <Card>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-accent/40"
      >
        <span
          className={cn(
            "grid h-12 w-12 place-items-center rounded-lg bg-gradient-to-br text-white shadow-sm",
            gradient
          )}
        >
          {logo}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold">{name}</span>
            <Badge variant="secondary" className="text-[10px]">
              {tagline}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Expand to see the trigger + action snippets.
          </p>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <CardContent className="space-y-5 border-t pt-5">
          {/* Trigger: Formly → provider */}
          <section>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ArrowRight className="h-3.5 w-3.5" />
              Formly event → {name}
            </div>
            <p className="mb-2 text-sm text-muted-foreground">{triggerHint}</p>
            <ol className="space-y-1 text-sm">
              <li>
                <span className="font-mono text-[10px] text-muted-foreground">
                  1
                </span>
                <span className="ml-1">
                  In {name}, create a catch-hook / custom-webhook step and copy
                  its URL.
                </span>
              </li>
              <li>
                <span className="font-mono text-[10px] text-muted-foreground">
                  2
                </span>
                <span className="ml-1">
                  In Formly, open{" "}
                  <Link
                    href="/settings/webhooks"
                    className="text-primary hover:underline"
                  >
                    Settings → Webhooks → New webhook
                  </Link>
                  . Paste the URL, pick the events you care about.
                </span>
              </li>
              <li>
                <span className="font-mono text-[10px] text-muted-foreground">
                  3
                </span>
                <span className="ml-1">
                  Trigger a matching event in Formly (e.g. generate a PDF).
                  Your {name} scenario fires with the signed JSON payload.
                </span>
              </li>
            </ol>
          </section>

          <Separator />

          {/* Action: provider → Formly */}
          <section>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ArrowRight className="h-3.5 w-3.5" />
              {name} → Formly (generate PDF)
            </div>
            <p className="mb-2 text-sm text-muted-foreground">{actionHint}</p>
            <CodeBlock
              text={postSnippet}
              onCopy={() => onCopy(postSnippet, "generate cURL")}
            />
          </section>

          {/* Bonus: generate + email */}
          <section>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ArrowRight className="h-3.5 w-3.5" />
              {name} → Formly (generate + email)
            </div>
            <p className="mb-2 text-sm text-muted-foreground">
              Swap the URL to <code className="font-mono text-xs">/send</code>{" "}
              to render the PDF and email it in one step. Requires{" "}
              <Link
                href="/settings/email"
                className="text-primary hover:underline"
              >
                email delivery
              </Link>{" "}
              to be configured.
            </p>
            <CodeBlock
              text={sendSnippet}
              onCopy={() => onCopy(sendSnippet, "send cURL")}
            />
          </section>

          <div className="flex items-center gap-2 pt-1">
            <Button asChild size="sm" variant="outline">
              <a href={docsURL} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
                {plainDocsLabel || `${name} docs`}
              </a>
            </Button>
            <Button asChild size="sm" variant="ghost">
              <Link href="/docs/api">Formly API reference</Link>
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function CodeBlock({
  text,
  onCopy,
}: {
  text: string;
  onCopy: () => void;
}) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px]">
        {text}
      </pre>
      <Button
        variant="outline"
        size="sm"
        className="absolute right-2 top-2"
        onClick={onCopy}
      >
        <Copy className="h-3.5 w-3.5" />
        Copy
      </Button>
    </div>
  );
}
