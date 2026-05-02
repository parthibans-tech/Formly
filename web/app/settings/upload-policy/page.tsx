"use client";

// Org-admin upload policy: per-workspace overrides on top of the
// platform defaults. Every field is "inherit (= use product default)" by
// default; toggle "override" to pin a workspace-specific value.
//
// Wire shape (GET /v1/settings/upload-policy):
//   { effective: ProductConfig, overrides: PartialPolicy, product: ProductConfig }
//
// PATCH accepts a sparse overrides object. Sending null / omitting a
// field clears that override (back to inherit). DELETE clears every
// override at once.

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
  Undo2,
  X,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/ui/confirm";
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
  previewCsp: string;
  previewIframeSandbox: string;
  pdfHardenEnabled: boolean;
  pdfBlockedFeatures: string[];
  embedAllowedOrigins: string[];
  updatedAt?: string;
};

// Pointer-style overrides: null/undefined means "inherit". We model
// "inherit" as `undefined` in TypeScript and send `null` over the wire
// when the user clears an override that was previously set.
type Overrides = {
  maxUploadBytes?: number;
  allowedMimeTypes?: string[];
  blockedExtensions?: string[];
  mimeSniffEnabled?: boolean;
  scanEnabled?: boolean;
  maxFilenameLen?: number;
  forceAttachmentForRisky?: boolean;
  previewCsp?: string;
  previewIframeSandbox?: string;
  pdfHardenEnabled?: boolean;
  // Tri-state list semantics (server-side):
  //   undefined     → inherit
  //   []            → explicit empty (lock-down — overrides product)
  //   [..]          → replace
  // The "Override" toggle UI distinguishes undefined vs everything-else;
  // an admin who toggles ON then deletes every chip will see "[ ]"
  // shipped, which is the lock-down case.
  pdfBlockedFeatures?: string[];
  embedAllowedOrigins?: string[];
};

// Quick-add tokens for the iframe sandbox attribute. Same list as the
// product-config page; duplicated rather than shared because the two
// pages currently have no common module and a one-off for two arrays
// would be premature.
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

const PDF_FEATURE_PRESETS = [
  "javascript",
  "launch",
  "embedded_file",
  "external_xobject",
];

// Mirror of uploadpolicy.ValidateEmbedOrigin — see product-config/page.tsx
// for rationale. Returns null when valid; a short reason otherwise.
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

type PolicyResp = {
  effective: ProductConfig;
  overrides: Overrides;
  product: ProductConfig;
};

const SIZE_PRESETS: Array<{ label: string; bytes: number }> = [
  { label: "10 MB", bytes: 10 * 1024 * 1024 },
  { label: "25 MB", bytes: 25 * 1024 * 1024 },
  { label: "100 MB", bytes: 100 * 1024 * 1024 },
  { label: "500 MB", bytes: 500 * 1024 * 1024 },
  { label: "1 GB", bytes: 1024 * 1024 * 1024 },
];

export default function UploadPolicyPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<PolicyResp | null>(null);
  const [draft, setDraft] = useState<Overrides | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const d = await api<PolicyResp>("/v1/settings/upload-policy");
      setData(d);
      setDraft(d.overrides);
    } catch (e: any) {
      toast.show("error", "Couldn't load upload policy", {
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
    return JSON.stringify(data.overrides) !== JSON.stringify(draft);
  }, [data, draft]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      // Build a body that sends explicit nulls for cleared overrides so
      // the server can distinguish "inherit" from "untouched". We sent
      // `undefined` keys never appear in JSON, which is exactly what we
      // want — the server reads missing fields as "no override".
      const updated = await api<PolicyResp>("/v1/settings/upload-policy", {
        method: "PATCH",
        body: JSON.stringify(draft),
      });
      setData(updated);
      setDraft(updated.overrides);
      toast.show("success", "Upload policy saved");
    } catch (e: any) {
      const msg =
        e instanceof ApiError ? e.message : e?.message || "Couldn't save";
      toast.show("error", "Save failed", { description: msg });
    } finally {
      setSaving(false);
    }
  }

  async function resetAll() {
    const ok = await confirm({
      title: "Reset all overrides?",
      description:
        "Every workspace override will be cleared. Future uploads will use the platform defaults exactly.",
      confirmLabel: "Reset",
      destructive: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      const updated = await api<PolicyResp>("/v1/settings/upload-policy", {
        method: "DELETE",
      });
      setData(updated);
      setDraft(updated.overrides);
      toast.show("success", "Overrides cleared");
    } catch (e: any) {
      toast.show("error", "Reset failed", {
        description: e?.message,
      });
    } finally {
      setSaving(false);
    }
  }

  if (!draft || !data) {
    return (
      <>
        <Header onRefresh={load} refreshing={refreshing} onResetAll={() => {}} hasOverrides={false} />
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

  const product = data.product;
  const hasAnyOverride =
    Object.values(data.overrides).some((v) => v !== undefined) ||
    Object.values(draft).some((v) => v !== undefined);

  // setOverride writes to the draft; passing `undefined` clears the
  // override (= inherit from product).
  const setOverride = <K extends keyof Overrides>(
    k: K,
    v: Overrides[K] | undefined,
  ) =>
    setDraft((prev) => {
      const next = { ...(prev ?? {}) };
      if (v === undefined) delete next[k];
      else next[k] = v;
      return next;
    });

  return (
    <>
      <Header
        onRefresh={load}
        refreshing={refreshing}
        onResetAll={resetAll}
        hasOverrides={hasAnyOverride}
      />

      {/* Size cap */}
      <OverrideSection
        icon={<HardDrive className="h-4 w-4" />}
        title="Maximum upload size"
        description={
          <>
            Workspace cap. Cannot exceed the platform ceiling of{" "}
            <strong>{formatBytes(product.maxUploadBytes)}</strong>; the
            server clamps anything higher.
          </>
        }
        overridden={draft.maxUploadBytes !== undefined}
        inheritedDisplay={formatBytes(product.maxUploadBytes)}
        onToggleOverride={(on) =>
          setOverride(
            "maxUploadBytes",
            on ? product.maxUploadBytes : undefined,
          )
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {SIZE_PRESETS.filter((p) => p.bytes <= product.maxUploadBytes).map(
              (p) => (
                <Button
                  key={p.bytes}
                  type="button"
                  size="sm"
                  variant={
                    draft.maxUploadBytes === p.bytes ? "default" : "outline"
                  }
                  onClick={() => setOverride("maxUploadBytes", p.bytes)}
                >
                  {p.label}
                </Button>
              ),
            )}
          </div>
          <div className="flex items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="max-bytes">Custom (bytes)</Label>
              <Input
                id="max-bytes"
                type="number"
                min={1}
                max={product.maxUploadBytes}
                value={draft.maxUploadBytes ?? product.maxUploadBytes}
                onChange={(e) =>
                  setOverride(
                    "maxUploadBytes",
                    Math.min(
                      product.maxUploadBytes,
                      Math.max(1, Number(e.target.value) || 0),
                    ),
                  )
                }
                className="w-48"
              />
            </div>
            <div className="pb-2 text-sm text-muted-foreground">
              ≈{" "}
              <span className="font-medium">
                {formatBytes(draft.maxUploadBytes ?? product.maxUploadBytes)}
              </span>
            </div>
          </div>
        </div>
      </OverrideSection>

      {/* MIME allowlist */}
      <OverrideSection
        icon={<FileCheck2 className="h-4 w-4" />}
        title="Allowed MIME types"
        description={
          <>
            When overriding, only types ALSO present in the platform
            allowlist (or the platform's empty=any setting) will actually
            be accepted — the server intersects the two lists.
          </>
        }
        overridden={draft.allowedMimeTypes !== undefined}
        inheritedDisplay={
          product.allowedMimeTypes.length === 0
            ? "Any (no restriction)"
            : `${product.allowedMimeTypes.length} types`
        }
        onToggleOverride={(on) =>
          setOverride(
            "allowedMimeTypes",
            on ? [...product.allowedMimeTypes] : undefined,
          )
        }
      >
        <ChipInput
          values={draft.allowedMimeTypes ?? []}
          onChange={(next) => setOverride("allowedMimeTypes", next)}
          placeholder="application/pdf"
          ariaLabel="Allowed MIME types"
          normalize={(v) => v.toLowerCase().trim()}
        />
        {product.allowedMimeTypes.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Platform allows:{" "}
            {product.allowedMimeTypes.slice(0, 6).join(", ")}
            {product.allowedMimeTypes.length > 6 ? ", …" : ""}
          </p>
        )}
      </OverrideSection>

      {/* Extension blocklist */}
      <OverrideSection
        icon={<ShieldAlert className="h-4 w-4 text-amber-600" />}
        title="Blocked file extensions"
        description={
          <>
            Workspace blocklist is unioned with the platform list — you
            can add to it, but you can't unblock something the platform
            blocks.
          </>
        }
        overridden={draft.blockedExtensions !== undefined}
        inheritedDisplay={`${product.blockedExtensions.length} blocked`}
        onToggleOverride={(on) =>
          setOverride(
            "blockedExtensions",
            on ? [...product.blockedExtensions] : undefined,
          )
        }
      >
        <ChipInput
          values={draft.blockedExtensions ?? []}
          onChange={(next) => setOverride("blockedExtensions", next)}
          placeholder=".exe"
          ariaLabel="Blocked extensions"
          normalize={(v) => {
            const t = v.toLowerCase().trim();
            if (!t) return "";
            return t.startsWith(".") ? t : `.${t}`;
          }}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Platform always blocks:{" "}
          {product.blockedExtensions.slice(0, 8).join(" ")}
          {product.blockedExtensions.length > 8 ? " …" : ""}
        </p>
      </OverrideSection>

      {/* Toggles */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4" />
            Validation &amp; hardening
          </CardTitle>
          <CardDescription>
            Each toggle inherits from the platform default unless
            overridden. You can only make these stricter — turning off a
            check the platform requires has no effect on uploads.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <ToggleOverride
            title="Magic-byte MIME verification"
            desc="Compares the actual file bytes to the declared content type after upload."
            productValue={product.mimeSniffEnabled}
            override={draft.mimeSniffEnabled}
            onSet={(v) => setOverride("mimeSniffEnabled", v)}
          />
          <ToggleOverride
            title="Antivirus scan"
            desc="Gates downloads on a clean ClamAV verdict. Uploads sit in a scanning state until the worker returns; infected files are blocked from every download, share, and preview path."
            productValue={product.scanEnabled}
            override={draft.scanEnabled}
            onSet={(v) => setOverride("scanEnabled", v)}
          />
          <ToggleOverride
            title="Force download on risky types"
            desc="Sets Content-Disposition: attachment for HTML/SVG so they can't execute inline."
            productValue={product.forceAttachmentForRisky}
            override={draft.forceAttachmentForRisky}
            onSet={(v) => setOverride("forceAttachmentForRisky", v)}
          />
          <div className="grid gap-3 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium">
                Maximum filename length
                {draft.maxFilenameLen === undefined ? (
                  <Badge variant="outline" className="text-[10px]">
                    Inherits {product.maxFilenameLen}
                  </Badge>
                ) : (
                  <Badge className="text-[10px]">Override</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Truncated server-side after sanitization. Cannot exceed the
                platform ceiling ({product.maxFilenameLen}).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={16}
                max={product.maxFilenameLen}
                value={draft.maxFilenameLen ?? product.maxFilenameLen}
                onChange={(e) =>
                  setOverride(
                    "maxFilenameLen",
                    Math.max(
                      16,
                      Math.min(
                        product.maxFilenameLen,
                        Number(e.target.value) || 0,
                      ),
                    ),
                  )
                }
                className="w-24"
              />
              {draft.maxFilenameLen !== undefined && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setOverride("maxFilenameLen", undefined)}
                  title="Clear override (inherit from product)"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* PDF hardening — toggle + blocklist */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileWarning className="h-4 w-4 text-rose-600" />
            PDF hardening
          </CardTitle>
          <CardDescription>
            Strips active content (JavaScript, /Launch, embedded files,
            external xobjects) from PDFs at upload. Toggle inherits the
            platform default unless overridden; the blocklist below can
            be replaced per workspace (clearing every chip stores an
            explicit lock-down rather than inheriting).
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <ToggleOverride
            title="Enable PDF hardening"
            desc="When off, PDFs are accepted as-is. Recommended on for any deployment that lets end users open uploaded PDFs."
            productValue={product.pdfHardenEnabled}
            override={draft.pdfHardenEnabled}
            onSet={(v) => setOverride("pdfHardenEnabled", v)}
          />
        </CardContent>
      </Card>

      <OverrideSection
        icon={<FileWarning className="h-4 w-4 text-rose-600" />}
        title="Blocked PDF features"
        description={
          <>
            Per-workspace replacement of the platform list. An override
            with zero entries is stored as &quot;explicit lock-down&quot;
            — i.e. don&apos;t strip anything — rather than collapsing to
            inherit.
          </>
        }
        overridden={draft.pdfBlockedFeatures !== undefined}
        inheritedDisplay={`${product.pdfBlockedFeatures.length} features`}
        onToggleOverride={(on) =>
          setOverride(
            "pdfBlockedFeatures",
            on ? [...product.pdfBlockedFeatures] : undefined,
          )
        }
      >
        <ChipInput
          values={draft.pdfBlockedFeatures ?? []}
          onChange={(next) => setOverride("pdfBlockedFeatures", next)}
          placeholder="javascript"
          ariaLabel="Blocked PDF features"
          normalize={(v) => v.toLowerCase().trim().replace(/[^a-z0-9_]/g, "")}
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="self-center text-[10px] uppercase tracking-wide text-muted-foreground">
            Quick add
          </span>
          {PDF_FEATURE_PRESETS.filter(
            (m) => !(draft.pdfBlockedFeatures ?? []).includes(m),
          ).map((m) => (
            <Button
              key={m}
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() =>
                setOverride("pdfBlockedFeatures", [
                  ...(draft.pdfBlockedFeatures ?? []),
                  m,
                ])
              }
            >
              <Plus className="h-3 w-3" />
              {m}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Platform default:{" "}
          {product.pdfBlockedFeatures.join(" ") || "(empty)"}
        </p>
      </OverrideSection>

      {/* Embed allowed origins */}
      <OverrideSection
        icon={<Globe2 className="h-4 w-4" />}
        title="Embed-allowed origins"
        description={
          <>
            Origins permitted to iframe this workspace&apos;s public{" "}
            <code className="rounded bg-muted px-1 text-xs">/form</code>,{" "}
            <code className="rounded bg-muted px-1 text-xs">/share</code>{" "}
            and{" "}
            <code className="rounded bg-muted px-1 text-xs">/review</code>{" "}
            pages. Format:{" "}
            <code className="rounded bg-muted px-1 text-xs">
              https://customer.example
            </code>{" "}
            — scheme + host (+ optional port), no paths, no wildcards.
            An override with zero entries is stored as &quot;explicit
            lock-down&quot; (only this app can iframe).
          </>
        }
        overridden={draft.embedAllowedOrigins !== undefined}
        inheritedDisplay={
          product.embedAllowedOrigins.length === 0
            ? "Locked ('self' only)"
            : `${product.embedAllowedOrigins.length} origins`
        }
        onToggleOverride={(on) =>
          setOverride(
            "embedAllowedOrigins",
            on ? [...product.embedAllowedOrigins] : undefined,
          )
        }
      >
        <ChipInput
          values={draft.embedAllowedOrigins ?? []}
          onChange={(next) => setOverride("embedAllowedOrigins", next)}
          placeholder="https://partner.example"
          ariaLabel="Embed-allowed origins"
          normalize={(v) => {
            const t = v.trim();
            if (!t) return "";
            if (validateEmbedOrigin(t)) return "";
            return normalizeEmbedOrigin(t);
          }}
          validate={validateEmbedOrigin}
        />
      </OverrideSection>

      {/* Preview CSP */}
      <OverrideSection
        icon={<Eye className="h-4 w-4" />}
        title="Inline-preview CSP"
        description={
          <>
            Override the{" "}
            <code className="rounded bg-muted px-1 text-xs">
              Content-Security-Policy
            </code>{" "}
            header attached to inline-preview responses. Any directive
            you remove gets enforced from the platform default — there
            is no &quot;unset CSP&quot; option.
          </>
        }
        overridden={draft.previewCsp !== undefined}
        inheritedDisplay={
          product.previewCsp.length > 48
            ? product.previewCsp.slice(0, 48) + "…"
            : product.previewCsp
        }
        onToggleOverride={(on) =>
          setOverride("previewCsp", on ? product.previewCsp : undefined)
        }
      >
        <textarea
          value={draft.previewCsp ?? ""}
          onChange={(e) => setOverride("previewCsp", e.target.value)}
          rows={3}
          spellCheck={false}
          className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex justify-end pt-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => setOverride("previewCsp", product.previewCsp)}
            title="Copy the platform default into the override"
          >
            <RotateCcw className="h-3 w-3" />
            Copy from platform
          </Button>
        </div>
      </OverrideSection>

      {/* Preview iframe sandbox */}
      <OverrideSection
        icon={<Eye className="h-4 w-4" />}
        title="Inline-preview iframe sandbox tokens"
        description={
          <>
            Override the tokens applied to{" "}
            <code className="rounded bg-muted px-1 text-xs">{`<iframe sandbox="…">`}</code>
            . Empty override means the most restrictive sandbox (no
            scripts, no forms, no same-origin); each token relaxes one
            capability.
          </>
        }
        overridden={draft.previewIframeSandbox !== undefined}
        inheritedDisplay={
          product.previewIframeSandbox === ""
            ? "Locked (no tokens)"
            : product.previewIframeSandbox
        }
        onToggleOverride={(on) =>
          setOverride(
            "previewIframeSandbox",
            on ? product.previewIframeSandbox : undefined,
          )
        }
      >
        <ChipInput
          values={
            draft.previewIframeSandbox
              ? draft.previewIframeSandbox.split(/\s+/).filter(Boolean)
              : []
          }
          onChange={(next) =>
            setOverride("previewIframeSandbox", next.join(" ").trim())
          }
          placeholder="allow-same-origin"
          ariaLabel="Iframe sandbox tokens"
          normalize={(v) => v.toLowerCase().trim()}
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="self-center text-[10px] uppercase tracking-wide text-muted-foreground">
            Quick add
          </span>
          {SANDBOX_PRESETS.filter(
            (m) =>
              !(draft.previewIframeSandbox ?? "")
                .split(/\s+/)
                .filter(Boolean)
                .includes(m),
          ).map((m) => (
            <Button
              key={m}
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() =>
                setOverride(
                  "previewIframeSandbox",
                  [
                    ...(draft.previewIframeSandbox ?? "")
                      .split(/\s+/)
                      .filter(Boolean),
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
      </OverrideSection>

      {/* Footer save bar */}
      <div className="sticky bottom-0 -mx-6 border-t bg-background/95 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {dirty ? (
              <>
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                Unsaved changes.
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                {hasAnyOverride
                  ? "Workspace overrides active."
                  : "Inheriting platform defaults."}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => data && setDraft(data.overrides)}
              disabled={!dirty || saving}
            >
              Discard
            </Button>
            <Button size="sm" onClick={save} disabled={!dirty || saving}>
              <Save className="h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save overrides"}
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
  onResetAll,
  hasOverrides,
}: {
  onRefresh: () => void;
  refreshing: boolean;
  onResetAll: () => void;
  hasOverrides: boolean;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Lock className="h-6 w-6" />
            Upload policy
          </h1>
          <p className="text-sm text-muted-foreground">
            Workspace overrides on top of the platform defaults. Anything
            you don't override here inherits from the platform.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasOverrides && (
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={onResetAll}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset all
            </Button>
          )}
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
      </div>
      <Separator />
    </>
  );
}

// OverrideSection wraps a config value with a "Use platform default /
// Override" toggle. When inherited, the body is hidden; overriding
// reveals the editor with the platform value pre-filled as a starting
// point.
function OverrideSection({
  icon,
  title,
  description,
  overridden,
  inheritedDisplay,
  onToggleOverride,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  overridden: boolean;
  inheritedDisplay: React.ReactNode;
  onToggleOverride: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            {icon}
            {title}
            {overridden ? (
              <Badge className="text-[10px]">Override</Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">
                Inherits · {inheritedDisplay}
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="mt-1">{description}</CardDescription>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={overridden}
            onChange={(e) => onToggleOverride(e.target.checked)}
          />
          Override
        </label>
      </CardHeader>
      {overridden && <CardContent>{children}</CardContent>}
    </Card>
  );
}

function ToggleOverride({
  title,
  desc,
  productValue,
  override,
  onSet,
  disabled,
  badge,
}: {
  title: string;
  desc: string;
  productValue: boolean;
  override: boolean | undefined;
  onSet: (v: boolean | undefined) => void;
  disabled?: boolean;
  badge?: React.ReactNode;
}) {
  // Three-state UI: "Inherit (default)" | "Force on" | "Force off". We
  // collapse it into two controls: a checkbox for the active value, plus
  // a small undo button to clear back to inherit.
  const effective = override ?? productValue;
  return (
    <div className={"flex items-start justify-between gap-4 py-4 " + (disabled ? "opacity-60" : "")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {title}
          {override === undefined ? (
            <Badge variant="outline" className="text-[10px]">
              Inherits · {productValue ? "On" : "Off"}
            </Badge>
          ) : (
            <Badge className="text-[10px]">Override · {override ? "On" : "Off"}</Badge>
          )}
          {badge}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <input
          type="checkbox"
          className="h-4 w-4 accent-primary"
          checked={effective}
          disabled={disabled}
          onChange={(e) => onSet(e.target.checked)}
        />
        {override !== undefined && !disabled && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onSet(undefined)}
            title="Clear override (inherit from product)"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

// Same chip input as the super-admin page; kept duplicated rather than
// shared because the two pages have slightly different ergonomics
// (preset rows etc.) and we'd rather avoid a hasty premature
// abstraction.
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
  // short reason string the input renders inline. Mirrors the same
  // helper on the product-config page.
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
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
