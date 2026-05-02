"use client";

// Super-admin product config: the platform-wide defaults that every org
// inherits from. An org admin can override any of these in
// /settings/upload-policy; if they don't, the product value applies.
//
// Why this page exists: file upload security (size cap, MIME allowlist,
// extension blocklist, content-type sniffing, scanner toggle, filename
// length, force-attachment-on-risky) needs to be tunable per deploy
// without a redeploy. Burying these in env vars or DB seeds means support
// has to ship a migration to bump a limit. With this page they tweak,
// audit, done.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Eye,
  FileCheck2,
  FileWarning,
  Globe2,
  HardDrive,
  Lock,
  Plus,
  RefreshCcw,
  RotateCcw,
  Save,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { formatBytes } from "@/lib/upload";

type ProductConfig = {
  maxUploadBytes: number;
  allowedMimeTypes: string[];
  blockedExtensions: string[];
  mimeSniffEnabled: boolean;
  scanEnabled: boolean;
  maxFilenameLen: number;
  forceAttachmentForRisky: boolean;
  // Inline-preview hardening — applied as response headers on the
  // /v1/files/:id/inline-preview endpoint. See uploadpolicy.go.
  previewCsp: string;
  previewIframeSandbox: string;
  // PDF structural hardening — strips scripts/launch-actions/etc. before
  // a PDF is admitted. Backed by internal/pdfsec.
  pdfHardenEnabled: boolean;
  pdfBlockedFeatures: string[];
  // Per-org allowlist of HTTP origins permitted to iframe the public
  // /form, /share, /review pages. Empty = locked down ('self' only).
  // Product default is empty by design (cross-tenant default would be
  // unsafe); orgs opt in explicitly per-origin.
  embedAllowedOrigins: string[];
  updatedAt?: string;
};

// Defaults used when the API returns a never-seeded row (or when a
// "Reset to default" button is pressed). Mirrored from
// internal/uploadpolicy/uploadpolicy.go — keep in sync when the Go
// constants change. We don't fetch them from the server because they're
// only ever a fallback for the editor itself, never persisted unless
// the admin clicks save.
const DEFAULT_PREVIEW_CSP =
  "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src 'self' data:; sandbox";
const DEFAULT_PDF_BLOCKED_FEATURES = [
  "javascript",
  "launch",
  "embedded_file",
  "external_xobject",
];
// Quick-add tokens for the iframe sandbox attribute. Empty list = the
// most restrictive sandbox; each token relaxes one capability. We list
// the W3C-defined values so admins can chip them in without typos.
const SANDBOX_PRESETS = [
  "allow-scripts",
  "allow-same-origin",
  "allow-forms",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-modals",
  "allow-downloads",
  "allow-pointer-lock",
  "allow-top-navigation",
  "allow-presentation",
];
// Supported PDF feature tokens — same list pdfsec.go knows how to strip.
// If the Go side adds a new token, surface it here so admins can
// actually toggle it.
const PDF_FEATURE_PRESETS = [
  "javascript",
  "launch",
  "embedded_file",
  "external_xobject",
];

// Client-side mirror of uploadpolicy.ValidateEmbedOrigin. The server is
// authoritative — we just want to give the admin instant feedback
// instead of a round-trip. Returns null when valid; otherwise a short
// reason string suitable for an inline hint.
function validateEmbedOrigin(raw: string): string | null {
  const o = raw.trim();
  if (!o) return "must not be empty";
  let u: URL;
  try {
    u = new URL(o);
  } catch {
    return "not a valid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "must use http:// or https://";
  }
  if (!u.host) return "missing host";
  if (u.pathname && u.pathname !== "/") return "must not include a path";
  if (u.search || u.hash || u.username || u.password) {
    return "must not include query, fragment, or userinfo";
  }
  if (u.host.includes("*")) {
    return "wildcards not allowed; list each subdomain explicitly";
  }
  return null;
}

function normalizeEmbedOrigin(raw: string): string {
  try {
    const u = new URL(raw.trim());
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}`;
  } catch {
    return raw.trim();
  }
}

// A short list the admin can click to set a sensible cap without doing
// the bytes-math themselves. Anything else they can type into the input.
const SIZE_PRESETS: Array<{ label: string; bytes: number }> = [
  { label: "10 MB", bytes: 10 * 1024 * 1024 },
  { label: "25 MB", bytes: 25 * 1024 * 1024 },
  { label: "100 MB", bytes: 100 * 1024 * 1024 },
  { label: "500 MB", bytes: 500 * 1024 * 1024 },
  { label: "1 GB", bytes: 1024 * 1024 * 1024 },
  { label: "5 GB", bytes: 5 * 1024 * 1024 * 1024 },
];

// Curated MIME quick-adds. The admin can add anything they want manually,
// but these cover ~95% of what a typical org actually allows.
const MIME_PRESETS = [
  "application/pdf",
  "image/*",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "text/html",
  "text/markdown",
  "application/json",
  "application/zip",
];

export default function ProductConfigPage() {
  const toast = useToast();
  const [data, setData] = useState<ProductConfig | null>(null);
  const [draft, setDraft] = useState<ProductConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const d = await api<ProductConfig>("/v1/admin/product-config");
      setData(d);
      setDraft(d);
    } catch (e: any) {
      toast.show("error", "Couldn't load product config", {
        description: e?.message,
      });
    } finally {
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!data || !draft) return false;
    return JSON.stringify(data) !== JSON.stringify(draft);
  }, [data, draft]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const body: Omit<ProductConfig, "updatedAt"> = {
        maxUploadBytes: draft.maxUploadBytes,
        allowedMimeTypes: draft.allowedMimeTypes,
        blockedExtensions: draft.blockedExtensions,
        mimeSniffEnabled: draft.mimeSniffEnabled,
        scanEnabled: draft.scanEnabled,
        maxFilenameLen: draft.maxFilenameLen,
        forceAttachmentForRisky: draft.forceAttachmentForRisky,
        previewCsp: draft.previewCsp,
        previewIframeSandbox: draft.previewIframeSandbox,
        pdfHardenEnabled: draft.pdfHardenEnabled,
        pdfBlockedFeatures: draft.pdfBlockedFeatures,
        embedAllowedOrigins: draft.embedAllowedOrigins,
      };
      const updated = await api<ProductConfig>("/v1/admin/product-config", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setData(updated);
      setDraft(updated);
      toast.show("success", "Product config saved", {
        description: "Every workspace now inherits the new defaults.",
      });
    } catch (e: any) {
      const msg =
        e instanceof ApiError ? e.message : e?.message || "Couldn't save";
      toast.show("error", "Save failed", { description: msg });
    } finally {
      setSaving(false);
    }
  }

  if (!draft) {
    return (
      <>
        <Header onRefresh={load} refreshing={refreshing} />
        <Card>
          <CardContent className="space-y-3 p-6">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </CardContent>
        </Card>
      </>
    );
  }

  const set = <K extends keyof ProductConfig>(k: K, v: ProductConfig[K]) =>
    setDraft((prev) => (prev ? { ...prev, [k]: v } : prev));

  return (
    <>
      <Header onRefresh={load} refreshing={refreshing} />

      {/* Size cap */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4" />
            Maximum upload size
          </CardTitle>
          <CardDescription>
            Hard ceiling enforced at the storage edge (presigned POST
            content-length-range) and re-checked server-side after upload.
            Org admins can lower this for their workspace but cannot raise
            it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {SIZE_PRESETS.map((p) => (
              <Button
                key={p.bytes}
                type="button"
                size="sm"
                variant={
                  draft.maxUploadBytes === p.bytes ? "default" : "outline"
                }
                onClick={() => set("maxUploadBytes", p.bytes)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <div className="flex items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="max-bytes">Custom (bytes)</Label>
              <Input
                id="max-bytes"
                type="number"
                min={1}
                value={draft.maxUploadBytes}
                onChange={(e) =>
                  set("maxUploadBytes", Math.max(1, Number(e.target.value) || 0))
                }
                className="w-48"
              />
            </div>
            <div className="pb-2 text-sm text-muted-foreground">
              ≈ <span className="font-medium">{formatBytes(draft.maxUploadBytes)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* MIME allowlist */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileCheck2 className="h-4 w-4" />
            Allowed MIME types
          </CardTitle>
          <CardDescription>
            Empty list means "any MIME accepted". Wildcards like{" "}
            <code className="rounded bg-muted px-1 text-xs">image/*</code>{" "}
            are supported. The server normalizes to lowercase.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ChipInput
            values={draft.allowedMimeTypes}
            onChange={(next) => set("allowedMimeTypes", next)}
            placeholder="application/pdf"
            ariaLabel="Allowed MIME types"
            normalize={(v) => v.toLowerCase().trim()}
          />
          <div className="flex flex-wrap gap-1.5 border-t pt-3">
            <span className="self-center text-[10px] uppercase tracking-wide text-muted-foreground">
              Quick add
            </span>
            {MIME_PRESETS.filter((m) => !draft.allowedMimeTypes.includes(m)).map(
              (m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    set("allowedMimeTypes", [...draft.allowedMimeTypes, m])
                  }
                >
                  <Plus className="h-3 w-3" />
                  {m}
                </Button>
              ),
            )}
          </div>
        </CardContent>
      </Card>

      {/* Extension blocklist */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4 text-amber-600" />
            Blocked file extensions
          </CardTitle>
          <CardDescription>
            Always rejected, regardless of MIME or content-sniff result.
            Entries are auto-prefixed with a dot and lowercased ({" "}
            <code className="rounded bg-muted px-1 text-xs">EXE</code>{" "}
            becomes <code className="rounded bg-muted px-1 text-xs">.exe</code>
            ).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChipInput
            values={draft.blockedExtensions}
            onChange={(next) => set("blockedExtensions", next)}
            placeholder=".exe"
            ariaLabel="Blocked extensions"
            normalize={(v) => {
              const t = v.toLowerCase().trim();
              if (!t) return "";
              return t.startsWith(".") ? t : `.${t}`;
            }}
          />
        </CardContent>
      </Card>

      {/* Toggles + filename len */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4" />
            Validation &amp; hardening
          </CardTitle>
          <CardDescription>
            Defense-in-depth controls beyond the size cap and MIME list.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <ToggleRow
            checked={draft.mimeSniffEnabled}
            onChange={(v) => set("mimeSniffEnabled", v)}
            title="Magic-byte MIME verification"
            desc="After upload, fetch the first 512 bytes and compare with the declared content type. Catches the case where a user renames evil.exe to invoice.pdf and lies about its MIME."
          />
          <ToggleRow
            checked={draft.scanEnabled}
            onChange={(v) => set("scanEnabled", v)}
            title="Antivirus scan"
            desc="Hands the uploaded blob to a ClamAV worker before exposing it for download. Files stay in scanning state until the verdict is in; infected uploads are blocked from every download/share/preview path. Requires CLAMAV_ADDR set on the worker — without it, scans report skipped and files release as if scanning was off."
          />
          <ToggleRow
            checked={draft.forceAttachmentForRisky}
            onChange={(v) => set("forceAttachmentForRisky", v)}
            title="Force download on risky types"
            desc={
              <>
                Sets <code className="rounded bg-muted px-1 text-xs">Content-Disposition: attachment</code>{" "}
                on download for HTML, SVG, and other types that can execute
                JavaScript when rendered inline. Mitigates stored-XSS via
                shared file URLs.
              </>
            }
          />
          <div className="grid gap-3 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
            <div>
              <div className="text-sm font-medium">Maximum filename length</div>
              <p className="text-xs text-muted-foreground">
                Filenames longer than this are truncated server-side after
                sanitization. 255 is the typical filesystem ceiling.
              </p>
            </div>
            <Input
              type="number"
              min={16}
              max={1024}
              value={draft.maxFilenameLen}
              onChange={(e) =>
                set(
                  "maxFilenameLen",
                  Math.max(16, Math.min(1024, Number(e.target.value) || 0)),
                )
              }
              className="w-28"
            />
          </div>
        </CardContent>
      </Card>

      {/* PDF hardening */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileWarning className="h-4 w-4 text-rose-600" />
            PDF hardening
          </CardTitle>
          <CardDescription>
            Strips active content (JavaScript, /Launch actions, embedded
            files, external xobjects) from PDFs at upload time. The
            blocklist below names which structural features are removed
            — anything not listed is left intact.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleRow
            checked={draft.pdfHardenEnabled}
            onChange={(v) => set("pdfHardenEnabled", v)}
            title="Enable PDF hardening"
            desc="When off, PDFs are accepted as-is. Recommended on for any deployment that lets end users open uploaded PDFs."
          />
          <div className="space-y-2">
            <Label>Blocked PDF features</Label>
            <ChipInput
              values={draft.pdfBlockedFeatures}
              onChange={(next) => set("pdfBlockedFeatures", next)}
              placeholder="javascript"
              ariaLabel="Blocked PDF features"
              normalize={(v) => v.toLowerCase().trim().replace(/[^a-z0-9_]/g, "")}
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              <span className="self-center text-[10px] uppercase tracking-wide text-muted-foreground">
                Quick add
              </span>
              {PDF_FEATURE_PRESETS.filter(
                (m) => !draft.pdfBlockedFeatures.includes(m),
              ).map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    set("pdfBlockedFeatures", [...draft.pdfBlockedFeatures, m])
                  }
                >
                  <Plus className="h-3 w-3" />
                  {m}
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() =>
                  set("pdfBlockedFeatures", [...DEFAULT_PDF_BLOCKED_FEATURES])
                }
                title="Reset to platform default blocklist"
              >
                <RotateCcw className="h-3 w-3" />
                Reset to default
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Embed allowed origins */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe2 className="h-4 w-4" />
            Embed-allowed origins
            <Badge variant="outline" className="text-[10px]">
              CSP frame-ancestors
            </Badge>
          </CardTitle>
          <CardDescription>
            Origins permitted to iframe public{" "}
            <code className="rounded bg-muted px-1 text-xs">/form</code>,{" "}
            <code className="rounded bg-muted px-1 text-xs">/share</code> and{" "}
            <code className="rounded bg-muted px-1 text-xs">/review</code>{" "}
            pages. Format: <code className="rounded bg-muted px-1 text-xs">https://customer.example</code>{" "}
            — scheme + host (+ optional port), no paths, no wildcards.
            Platform default is empty by design (a cross-tenant default
            would let one customer iframe another's branded form); orgs
            populate this in their own settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChipInput
            values={draft.embedAllowedOrigins}
            onChange={(next) => set("embedAllowedOrigins", next)}
            placeholder="https://partner.example"
            ariaLabel="Embed-allowed origins"
            normalize={(v) => {
              const t = v.trim();
              if (!t) return "";
              if (validateEmbedOrigin(t)) return ""; // reject invalid silently
              return normalizeEmbedOrigin(t);
            }}
            validate={validateEmbedOrigin}
          />
        </CardContent>
      </Card>

      {/* Preview CSP */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Eye className="h-4 w-4" />
            Inline-preview CSP
          </CardTitle>
          <CardDescription>
            <code className="rounded bg-muted px-1 text-xs">Content-Security-Policy</code>{" "}
            attached to{" "}
            <code className="rounded bg-muted px-1 text-xs">/v1/files/:id/inline-preview</code>{" "}
            responses. Default below is maximally restrictive — only
            relax it if you've audited what previews actually need.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <textarea
            value={draft.previewCsp}
            onChange={(e) => set("previewCsp", e.target.value)}
            rows={3}
            spellCheck={false}
            className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => set("previewCsp", DEFAULT_PREVIEW_CSP)}
              title="Restore the maximally restrictive default"
            >
              <RotateCcw className="h-3 w-3" />
              Reset to default
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Preview iframe sandbox */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Eye className="h-4 w-4" />
            Inline-preview iframe sandbox tokens
          </CardTitle>
          <CardDescription>
            Tokens applied to the{" "}
            <code className="rounded bg-muted px-1 text-xs">{`<iframe sandbox="…">`}</code>{" "}
            attribute the SPA reads from the preview metadata response.
            Empty = the most restrictive sandbox (no scripts, no forms,
            no same-origin). Each token below relaxes one specific
            capability.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChipInput
            values={
              draft.previewIframeSandbox
                ? draft.previewIframeSandbox.split(/\s+/).filter(Boolean)
                : []
            }
            onChange={(next) =>
              set("previewIframeSandbox", next.join(" ").trim())
            }
            placeholder="allow-same-origin"
            ariaLabel="Iframe sandbox tokens"
            normalize={(v) => v.toLowerCase().trim()}
          />
          <div className="flex flex-wrap gap-1.5 border-t pt-3">
            <span className="self-center text-[10px] uppercase tracking-wide text-muted-foreground">
              Quick add
            </span>
            {SANDBOX_PRESETS.filter(
              (m) => !draft.previewIframeSandbox.split(/\s+/).includes(m),
            ).map((m) => (
              <Button
                key={m}
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() =>
                  set(
                    "previewIframeSandbox",
                    [
                      ...draft.previewIframeSandbox.split(/\s+/).filter(Boolean),
                      m,
                    ].join(" "),
                  )
                }
              >
                <Plus className="h-3 w-3" />
                {m}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Footer save bar */}
      <div className="sticky bottom-0 -mx-6 border-t bg-background/95 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {dirty ? (
              <>
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                Unsaved changes.
              </>
            ) : data?.updatedAt ? (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                Last updated {new Date(data.updatedAt).toLocaleString()}.
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                Defaults synced.
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => data && setDraft(data)}
              disabled={!dirty || saving}
            >
              Discard
            </Button>
            <Button size="sm" onClick={save} disabled={!dirty || saving}>
              <Save className="h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save defaults"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function Header({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Lock className="h-6 w-6" />
            Product config — file uploads
          </h1>
          <p className="text-sm text-muted-foreground">
            Platform-wide defaults inherited by every workspace. Org admins
            can override (within these limits) at{" "}
            <code className="rounded bg-muted px-1 text-xs">
              /settings/upload-policy
            </code>
            .
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>
      <Separator />
    </>
  );
}

function ToggleRow({
  checked,
  onChange,
  title,
  desc,
  disabled,
  badge,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc: React.ReactNode;
  disabled?: boolean;
  badge?: React.ReactNode;
}) {
  return (
    <label
      className={
        "flex cursor-pointer items-start justify-between gap-4 py-4 " +
        (disabled ? "opacity-60" : "")
      }
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          {title}
          {badge}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
      </div>
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

// ChipInput: tag-style multi-string editor. Enter or comma commits a
// chip; backspace on empty pops the last one. Used for both MIME
// allowlist and extension blocklist.
function ChipInput({
  values,
  onChange,
  placeholder,
  ariaLabel,
  normalize,
  validate,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  ariaLabel: string;
  normalize: (v: string) => string;
  // Optional client-side validator. Returns null when valid, or a
  // short reason string the input renders inline. Validation runs on
  // the raw (pre-normalize) draft so errors stay tied to what the
  // admin actually typed.
  validate?: (v: string) => string | null;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft("");
      setError(null);
      return;
    }
    if (validate) {
      const err = validate(trimmed);
      if (err) {
        setError(err);
        return; // keep the bad text so the admin can fix it
      }
    }
    const v = normalize(draft);
    if (!v) {
      setDraft("");
      setError(null);
      return;
    }
    if (values.includes(v)) {
      setDraft("");
      setError(null);
      return;
    }
    onChange([...values, v]);
    setDraft("");
    setError(null);
  }

  function remove(i: number) {
    onChange(values.filter((_, idx) => idx !== i));
  }

  return (
    <div className="space-y-1">
      <div
        className={
          "flex flex-wrap items-center gap-1.5 rounded-md border bg-background p-2 " +
          (error ? "border-destructive" : "")
        }
      >
        {values.map((v, i) => (
          <span
            key={`${v}-${i}`}
            className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 text-xs"
          >
            <span className="max-w-[24ch] truncate" title={v}>
              {v}
            </span>
            <button
              type="button"
              aria-label={`Remove ${v}`}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => remove(i)}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          aria-label={ariaLabel}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (
              e.key === "Backspace" &&
              draft === "" &&
              values.length > 0
            ) {
              e.preventDefault();
              remove(values.length - 1);
            }
          }}
          onBlur={() => draft && commit()}
          placeholder={values.length === 0 ? placeholder : ""}
          className="min-w-[12ch] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {error && (
        <p className="text-[11px] text-destructive">{error}</p>
      )}
    </div>
  );
}
