"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Mail, Send, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Settings = {
  provider: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  config?: Record<string, any>;
  isConfigured: boolean;
  // The server reports the env-derived fallback config so admins know
  // mail will still work for system notifications even when the org
  // hasn't filled out this form. Null when no fallback is configured.
  envFallback?: {
    provider: string;
    fromEmail: string;
    fromName?: string;
  } | null;
};

type Send = {
  id: string;
  orgId?: string;
  templateId?: string | null;
  outputFileId?: string | null;
  recipients: string[];
  subject: string;
  provider: string;
  status: string;
  providerId?: string | null;
  error?: string | null;
  // Audit columns added in migration 026 — surface them so admins can
  // tell at a glance which subsystem emitted each row.
  kind?: string;
  source?: string;
  fromEmail?: string;
  metadata?: Record<string, any> | null;
  createdAt: string;
};

export default function EmailSettingsPage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testTo, setTestTo] = useState("");

  const [provider, setProvider] = useState("console");
  const [fromName, setFromName] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [config, setConfig] = useState<Record<string, any>>({});
  const [envFallback, setEnvFallback] = useState<Settings["envFallback"]>(null);

  const [sends, setSends] = useState<Send[]>([]);
  const [kindFilter, setKindFilter] = useState<string>("");

  useEffect(() => {
    (async () => {
      try {
        const s = await api<Settings>("/v1/email/settings");
        if (s.isConfigured) {
          setProvider(s.provider || "console");
          setFromName(s.fromName || "");
          setFromEmail(s.fromEmail || "");
          setReplyTo(s.replyTo || "");
          setConfig(s.config || {});
        } else if (s.envFallback) {
          // Pre-fill the form with the env defaults so a "Save settings"
          // click locks them in per-org without re-typing.
          setProvider(s.envFallback.provider);
          setFromEmail(s.envFallback.fromEmail);
          setFromName(s.envFallback.fromName || "");
        }
        setEnvFallback(s.envFallback ?? null);
        await refreshSends();
      } catch (e: any) {
        toast.show("error", e.message);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshSends(kind?: string) {
    const qs = new URLSearchParams();
    if (kind) qs.set("kind", kind);
    const r = await api<{ sends: Send[] }>(
      "/v1/email/sends" + (qs.toString() ? "?" + qs.toString() : "")
    );
    setSends(r.sends);
  }

  async function save() {
    setSaving(true);
    try {
      await api("/v1/email/settings", {
        method: "PUT",
        body: JSON.stringify({
          provider,
          fromName: fromName.trim(),
          fromEmail: fromEmail.trim(),
          replyTo: replyTo.trim(),
          config,
        }),
      });
      toast.show("success", "Email settings saved");
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    try {
      await api("/v1/email/test", {
        method: "POST",
        body: JSON.stringify({ to: testTo.trim() || undefined }),
      });
      toast.show("success", "Test email sent", {
        description: "Check your inbox — or your spam folder if the from domain isn't verified.",
      });
    } catch (e: any) {
      toast.show("error", "Test failed", { description: e.message });
    } finally {
      setTesting(false);
    }
  }

  function setCfg(key: string, val: any) {
    setConfig((c) => ({ ...c, [key]: val }));
  }

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Email delivery</h1>
        <p className="text-sm text-muted-foreground">
          Configure once, then use{" "}
          <code className="font-mono text-xs">POST /v1/templates/{"{id}"}/send</code>{" "}
          (or the <strong>Send</strong> button in the designer) to generate a
          PDF and email it in one call.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            Provider
          </CardTitle>
          <CardDescription>
            Pick <strong>Console</strong> for local dev (logs only), or hook up
            SMTP / Resend for real delivery. Secrets are stored server-side and
            only ever shown back as{" "}
            <code className="font-mono text-xs">●●●●●●</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </>
          ) : (
            <>
              {envFallback && (
                <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200">
                  <div className="font-semibold">System fallback active</div>
                  <p className="mt-0.5">
                    Until you save org-specific settings, mail is sent via{" "}
                    <code className="font-mono">{envFallback.provider}</code> from{" "}
                    <code className="font-mono">{envFallback.fromEmail}</code>{" "}
                    (configured by environment variables).
                  </p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <ProviderTile
                  active={provider === "console"}
                  label="Console"
                  hint="Dev-only — logs to server stdout"
                  onClick={() => setProvider("console")}
                />
                <ProviderTile
                  active={provider === "smtp"}
                  label="SMTP"
                  hint="Generic STARTTLS (port 587)"
                  onClick={() => setProvider("smtp")}
                />
                <ProviderTile
                  active={provider === "resend"}
                  label="Resend"
                  hint="resend.com HTTP API"
                  onClick={() => setProvider("resend")}
                />
                <ProviderTile
                  active={provider === "ses"}
                  label="AWS SES"
                  hint="SES v2 — region + IAM key"
                  onClick={() => setProvider("ses")}
                />
              </div>

              <Separator />

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="from-name">From name</Label>
                  <Input
                    id="from-name"
                    value={fromName}
                    onChange={(e) => setFromName(e.target.value)}
                    placeholder="Acme Invoices"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="from-email">From email</Label>
                  <Input
                    id="from-email"
                    type="email"
                    value={fromEmail}
                    onChange={(e) => setFromEmail(e.target.value)}
                    placeholder="billing@acme.example"
                  />
                </div>
                <div className="space-y-1.5 col-span-2">
                  <Label htmlFor="reply-to">Reply-To (optional)</Label>
                  <Input
                    id="reply-to"
                    type="email"
                    value={replyTo}
                    onChange={(e) => setReplyTo(e.target.value)}
                    placeholder="support@acme.example"
                  />
                </div>
              </div>

              {provider === "smtp" && (
                <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    SMTP details
                  </div>
                  <div className="grid grid-cols-[2fr_1fr] gap-2">
                    <div className="space-y-1.5">
                      <Label>Host</Label>
                      <Input
                        value={(config.host as string) || ""}
                        onChange={(e) => setCfg("host", e.target.value)}
                        placeholder="smtp.example.com"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Port</Label>
                      <Input
                        type="number"
                        value={(config.port as number) ?? 587}
                        onChange={(e) =>
                          setCfg("port", parseInt(e.target.value || "587", 10))
                        }
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label>Username</Label>
                      <Input
                        value={(config.username as string) || ""}
                        onChange={(e) => setCfg("username", e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Password / app key</Label>
                      <Input
                        type="password"
                        value={(config.password as string) || ""}
                        onChange={(e) => setCfg("password", e.target.value)}
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={config.startTLS !== false}
                      onChange={(e) => setCfg("startTLS", e.target.checked)}
                    />
                    Use STARTTLS (recommended on port 587)
                  </label>
                </div>
              )}

              {provider === "resend" && (
                <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Resend
                  </div>
                  <div className="space-y-1.5">
                    <Label>API key</Label>
                    <Input
                      type="password"
                      value={(config.apiKey as string) || ""}
                      onChange={(e) => setCfg("apiKey", e.target.value)}
                      placeholder="re_live_…"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Create a key at{" "}
                      <a
                        href="https://resend.com/api-keys"
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        resend.com/api-keys
                      </a>
                      . The <strong>from</strong> domain must be verified in your
                      Resend account.
                    </p>
                  </div>
                </div>
              )}

              {provider === "ses" && (
                <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    AWS SES
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label>Access key ID</Label>
                      <Input
                        value={(config.accessKey as string) || ""}
                        onChange={(e) => setCfg("accessKey", e.target.value)}
                        placeholder="AKIA…"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Secret access key</Label>
                      <Input
                        type="password"
                        value={(config.secretKey as string) || ""}
                        onChange={(e) => setCfg("secretKey", e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Region</Label>
                    <Input
                      value={(config.region as string) || ""}
                      onChange={(e) => setCfg("region", e.target.value)}
                      placeholder="ap-south-1"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      The IAM user needs <code className="font-mono">ses:SendEmail</code>
                      and <code className="font-mono">ses:SendRawEmail</code>. Both
                      the From address and the recipients must be verified in
                      sandbox mode.
                    </p>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button onClick={save} loading={saving}>
                  <Mail className="h-4 w-4" />
                  Save settings
                </Button>
                <Separator orientation="vertical" className="mx-2 h-6" />
                <Input
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="Test recipient (defaults to you)"
                  className="max-w-xs"
                />
                <Button variant="outline" onClick={sendTest} loading={testing}>
                  <Send className="h-4 w-4" />
                  Send test
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Recent sends</CardTitle>
              <CardDescription>
                Audit log of every email this organization has produced — template
                deliveries, access-request notifications, system alerts.
              </CardDescription>
            </div>
            <Select
              value={kindFilter || "all"}
              onValueChange={(v) => {
                const next = v === "all" ? "" : v;
                setKindFilter(next);
                refreshSends(next).catch(() => {});
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder="All kinds" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                <SelectItem value="template">Template</SelectItem>
                <SelectItem value="test">Test</SelectItem>
                <SelectItem value="invitation">Invitation</SelectItem>
                <SelectItem value="access_request_filed">Access request filed</SelectItem>
                <SelectItem value="access_request_approved">Access approved</SelectItem>
                <SelectItem value="access_request_denied">Access denied</SelectItem>
                <SelectItem value="notification">Notification</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {sends.length === 0 ? (
            <p className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              No sends yet. Configure the provider above, then use{" "}
              <strong>Send</strong> on a template to try it.
            </p>
          ) : (
            <ul className="divide-y">
              {sends.map((s) => (
                <li key={s.id} className="py-2">
                  <div className="flex items-start gap-2">
                    {s.status === "sent" ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
                    ) : (
                      <XCircle className="mt-0.5 h-4 w-4 text-destructive" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium">{s.subject}</span>
                        {s.kind && (
                          <Badge variant="secondary" className="text-[10px]">
                            {s.kind}
                          </Badge>
                        )}
                        <Badge
                          variant="outline"
                          className="font-mono text-[10px]"
                        >
                          {s.provider}
                        </Badge>
                        {s.providerId && (
                          <span className="font-mono text-[10px] text-muted-foreground">
                            #{s.providerId.slice(0, 12)}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        to {s.recipients.join(", ")} ·{" "}
                        {new Date(s.createdAt).toLocaleString()}
                        {s.source && (
                          <>
                            {" "}
                            ·{" "}
                            <code className="font-mono text-[10px]">{s.source}</code>
                          </>
                        )}
                      </div>
                      {s.error && (
                        <pre className="mt-1 max-h-20 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px] text-destructive">
                          {s.error}
                        </pre>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function ProviderTile({
  active,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border p-3 text-left text-xs transition-colors ${
        active
          ? "border-primary bg-primary/10"
          : "hover:bg-accent"
      }`}
    >
      <div className="text-sm font-semibold">{label}</div>
      <div className="text-muted-foreground">{hint}</div>
    </button>
  );
}
