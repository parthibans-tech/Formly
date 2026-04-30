"use client";

// Per-template output + security settings page.
//
// Lives on its own route (analogous to /templates/:id/api) so it's
// reachable from any of the mode-specific designers without each one
// having to grow its own settings UI. Two surfaces here:
//
//   1. Output naming & folder — filename / folder templates with
//      {{key}} placeholder substitution against the request data
//      payload at render time. Same rules apply to per-call overrides
//      (request body's outputName / outputPath).
//
//   2. PDF security — owner / user passwords, AES-128 vs AES-256, and
//      the granular permission mask (print / copy / modify / annotate).
//      Server-side only — passwords never echo back from /schema, and
//      the request body cannot weaken these.
//
// The page does its own GET /v1/templates/:id round-trip so the form
// always reflects the current persisted config (no flash of stale
// state if the user edited from another tab). Save merges the new
// `output` and `security` keys into the existing config object so we
// don't clobber mappings / placeholders / pageLayout / etc.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Folder,
  Lock,
  Save,
  Shield,
} from "lucide-react";
import { api, getToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/toast";

type SecurityCfg = {
  ownerPassword?: string;
  userPassword?: string;
  encryption?: string; // "AES-128" | "AES-256"
  permissions?: {
    print?: boolean;
    copy?: boolean;
    modify?: boolean;
    annotate?: boolean;
  };
};

type OutputCfg = {
  folderPath?: string;
  filenameTemplate?: string;
};

type Template = {
  id: string;
  name: string;
  mode: string;
  version: number;
  config: Record<string, any> & {
    output?: OutputCfg;
    security?: SecurityCfg;
  };
  canEdit: boolean;
};

export default function TemplateSettingsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [tpl, setTpl] = useState<Template | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Local edit state — separated from tpl so a typo in a password
  // field doesn't stomp the persisted config until the user clicks
  // Save. Mirrors the pattern used by the AcroForm designer.
  const [folderPath, setFolderPath] = useState("");
  const [filenameTemplate, setFilenameTemplate] = useState("");
  const [secEnabled, setSecEnabled] = useState(false);
  const [ownerPassword, setOwnerPassword] = useState("");
  const [userPassword, setUserPassword] = useState("");
  const [encryption, setEncryption] = useState("AES-256");
  const [allowPrint, setAllowPrint] = useState(true);
  const [allowCopy, setAllowCopy] = useState(false);
  const [allowModify, setAllowModify] = useState(false);
  const [allowAnnotate, setAllowAnnotate] = useState(false);
  const [showOwnerPwd, setShowOwnerPwd] = useState(false);
  const [showUserPwd, setShowUserPwd] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        const t = await api<Template>(`/v1/templates/${params.id}`);
        setTpl(t);
        // Hydrate form fields from the persisted config. Note: the
        // server returns plaintext passwords here only because the
        // template fetch is gated on edit permission — viewers go
        // through TemplateViewer and never hit this page.
        setFolderPath(t.config?.output?.folderPath ?? "");
        setFilenameTemplate(t.config?.output?.filenameTemplate ?? "");
        const sec = t.config?.security;
        if (sec && (sec.ownerPassword || sec.userPassword)) {
          setSecEnabled(true);
          setOwnerPassword(sec.ownerPassword ?? "");
          setUserPassword(sec.userPassword ?? "");
          setEncryption(sec.encryption || "AES-256");
          setAllowPrint(sec.permissions?.print ?? true);
          setAllowCopy(sec.permissions?.copy ?? false);
          setAllowModify(sec.permissions?.modify ?? false);
          setAllowAnnotate(sec.permissions?.annotate ?? false);
        }
      } catch (e: any) {
        setErr(e?.message || "Failed to load template");
      }
    })();
  }, [params.id, router]);

  async function save() {
    if (!tpl) return;
    setSaving(true);
    try {
      // Merge over the existing config so we don't clobber mappings /
      // placeholders / pageLayout / validations / etc. The PUT
      // endpoint takes the whole object — there's no patch route — so
      // a clean read-modify-write here is the right shape.
      const nextConfig: Record<string, any> = { ...(tpl.config || {}) };

      if (folderPath.trim() === "" && filenameTemplate.trim() === "") {
        delete nextConfig.output;
      } else {
        nextConfig.output = {
          ...(folderPath.trim() && { folderPath: folderPath.trim() }),
          ...(filenameTemplate.trim() && {
            filenameTemplate: filenameTemplate.trim(),
          }),
        };
      }

      if (!secEnabled || (!ownerPassword && !userPassword)) {
        delete nextConfig.security;
      } else {
        nextConfig.security = {
          ...(ownerPassword && { ownerPassword }),
          ...(userPassword && { userPassword }),
          encryption,
          permissions: {
            print: allowPrint,
            copy: allowCopy,
            modify: allowModify,
            annotate: allowAnnotate,
          },
        };
      }

      const res = await api<{ version: number }>(
        `/v1/templates/${tpl.id}/config`,
        {
          method: "PUT",
          body: JSON.stringify({
            config: nextConfig,
            expectedVersion: tpl.version,
          }),
        }
      );
      toast.show("success", `Saved v${res.version}`);
      setTpl({ ...tpl, config: nextConfig, version: res.version });
    } catch (e: any) {
      toast.show("error", e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (err) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {err}
        </div>
      </div>
    );
  }

  if (!tpl) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // Read-only message for viewers. Belt-and-suspenders — the server
  // also rejects the PUT — but a friendly explanation beats a raw
  // 403 toast on Save click.
  if (!tpl.canEdit) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/templates/${tpl.id}/designer`}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to designer
          </Link>
        </Button>
        <div className="rounded-lg border bg-muted/30 p-4 text-sm">
          <p className="font-medium">Read-only</p>
          <p className="text-muted-foreground">
            You don&rsquo;t have edit access to this template, so output
            and security settings are not editable here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/templates/${tpl.id}/designer`}>
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Link>
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <h1 className="text-lg font-semibold">{tpl.name}</h1>
          <span className="text-xs text-muted-foreground">
            · {tpl.mode} · v{tpl.version}
          </span>
        </div>
        <Button onClick={save} disabled={saving}>
          <Save className="h-3.5 w-3.5" />
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      {/* --- Output naming & folder --- */}
      <section className="space-y-4 rounded-lg border bg-card p-5">
        <div className="flex items-center gap-2">
          <Folder className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Output naming &amp; folder</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Both fields support <code className="font-mono">{`{{key}}`}</code>{" "}
          placeholders that resolve against the keys in the{" "}
          <code className="font-mono">data</code> payload at render time.
          Missing keys collapse to empty strings — keep your templates
          robust to optional inputs.
        </p>
        <div className="space-y-2">
          <Label htmlFor="filenameTemplate">Filename template</Label>
          <Input
            id="filenameTemplate"
            placeholder="Invoice-{{invoiceNumber}}.pdf"
            value={filenameTemplate}
            onChange={(e) => setFilenameTemplate(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Defaults to{" "}
            <code className="font-mono">
              {`{templateName}-filled-{timestamp}.pdf`}
            </code>{" "}
            when blank. The <code className="font-mono">.pdf</code>{" "}
            extension is added automatically if you forget it.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="folderPath">Folder path</Label>
          <Input
            id="folderPath"
            placeholder="clients/{{customerName}}/{{year}}"
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Slash-separated. <code className="font-mono">..</code> and
            other path-traversal tricks are stripped per segment.
          </p>
        </div>
      </section>

      {/* --- PDF security --- */}
      <section className="space-y-4 rounded-lg border bg-card p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">PDF security</h2>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={secEnabled}
              onChange={(e) => setSecEnabled(e.target.checked)}
              aria-label="Enable PDF security"
            />
            <span>Enabled</span>
          </label>
        </div>
        {!secEnabled ? (
          <p className="text-xs text-muted-foreground">
            Off — generated PDFs are not encrypted. Anyone with the
            download URL can open them.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border-l-2 border-amber-400 bg-amber-50/40 p-3 text-xs dark:bg-amber-500/10">
              <p className="font-medium">
                <Lock className="-mt-0.5 mr-1 inline h-3 w-3" />
                Heads up
              </p>
              <p className="text-muted-foreground">
                Passwords are stored in the template config and used on
                every render. Rotate them by editing here and re-saving;
                already-rendered PDFs keep the password they were
                generated with.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ownerPassword">Owner password</Label>
                <div className="relative">
                  <Input
                    id="ownerPassword"
                    type={showOwnerPwd ? "text" : "password"}
                    placeholder="Required to bypass restrictions"
                    value={ownerPassword}
                    onChange={(e) => setOwnerPassword(e.target.value)}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowOwnerPwd((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={
                      showOwnerPwd ? "Hide password" : "Show password"
                    }
                  >
                    {showOwnerPwd ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Required to print / copy / modify when the user
                  doesn&rsquo;t have those granted.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="userPassword">User password</Label>
                <div className="relative">
                  <Input
                    id="userPassword"
                    type={showUserPwd ? "text" : "password"}
                    placeholder="Required to open the file"
                    value={userPassword}
                    onChange={(e) => setUserPassword(e.target.value)}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowUserPwd((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={
                      showUserPwd ? "Hide password" : "Show password"
                    }
                  >
                    {showUserPwd ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Empty = file opens without a prompt; permissions still
                  apply.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Encryption</Label>
              <Select value={encryption} onValueChange={setEncryption}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AES-256">
                    AES-256 (recommended)
                  </SelectItem>
                  <SelectItem value="AES-128">
                    AES-128 (legacy readers)
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                AES-256 is supported by Acrobat ≥ X (2010), Preview, and
                modern browsers. Drop to AES-128 only for ancient
                viewers.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Permissions (without owner password)</Label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <PermissionRow
                  label="Print"
                  description="Allow printing the document."
                  checked={allowPrint}
                  onChange={setAllowPrint}
                />
                <PermissionRow
                  label="Copy text & graphics"
                  description="Allow selecting and copying content."
                  checked={allowCopy}
                  onChange={setAllowCopy}
                />
                <PermissionRow
                  label="Modify"
                  description="Allow editing pages or assembling."
                  checked={allowModify}
                  onChange={setAllowModify}
                />
                <PermissionRow
                  label="Annotate / fill forms"
                  description="Allow adding comments or filling AcroForm fields."
                  checked={allowAnnotate}
                  onChange={setAllowAnnotate}
                />
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function PermissionRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border p-3">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 rounded border-input"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}
