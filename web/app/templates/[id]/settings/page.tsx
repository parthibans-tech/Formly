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
  Mail,
  Save,
  Send,
  Shield,
  Stamp,
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
  // flattenDefault is a tri-state at this layer: undefined ("no
  // template-level opinion, follow legacy / per-call default"), true
  // ("flatten unless the request explicitly says otherwise"), false
  // ("never flatten unless the request explicitly says so"). The form
  // control below is a Select so users see all three states without
  // mistaking an unchecked checkbox for an explicit "no".
  flattenDefault?: boolean;
};

// DecorationsCfg mirrors api/internal/generate/pdfdecor.Config. Every
// sub-block is optional; omitting them on save (delete nextConfig.
// decorations) is what tells the server "no decorations". Text fields
// support {{key}} from data plus {{page}}, {{pages}}, {{generatedAt}},
// {{date}} built-ins.
type WatermarkCfg = {
  text?: string;
  fontSize?: number;
  color?: string;
  opacity?: number;
  rotation?: number;
  position?: string; // "diagonal" | "center" | "top-left" | …
  pages?: string; // "all" | "first" | "last" | "1,3-5"
  onTop?: boolean;
};

type HeaderFooterCfg = {
  left?: string;
  center?: string;
  right?: string;
  fontSize?: number;
  color?: string;
  margin?: number;
  showOnFirstPage?: boolean;
  pages?: string;
};

type DecorationsCfg = {
  watermark?: WatermarkCfg;
  header?: HeaderFooterCfg;
  footer?: HeaderFooterCfg;
};

// DeliveryCfg mirrors api/internal/generate/delivery.Config.
//
// Both sub-blocks are off by default — adding them here doesn't
// silently start mailing or minting share links. The integrator
// has to flip the per-section "Enabled" toggle, which the save
// logic respects: a disabled block is dropped from the persisted
// config so server-side IsEnabled() short-circuits.
//
// Recipient/subject/body fields support {{key}} placeholders
// against the request data — the server's resolveRecipients drops
// addresses that didn't resolve cleanly, so a missing key won't
// surface as a literal "{{managerEmail}}" in someone's inbox.
type EmailDeliveryCfg = {
  enabled?: boolean;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  attachPDF?: boolean;
  includeDownloadLink?: boolean;
  includeShareLink?: boolean;
};

type ShareDeliveryCfg = {
  enabled?: boolean;
  role?: string; // viewer | downloader
  expiresIn?: number; // seconds
  password?: string;
  oneTime?: boolean;
  downloadLimit?: number;
};

type DeliveryCfg = {
  email?: EmailDeliveryCfg;
  share?: ShareDeliveryCfg;
};

type Template = {
  id: string;
  name: string;
  mode: string;
  version: number;
  config: Record<string, any> & {
    output?: OutputCfg;
    security?: SecurityCfg;
    decorations?: DecorationsCfg;
    delivery?: DeliveryCfg;
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
  // "inherit" → don't write flattenDefault to config; "yes" → true;
  // "no" → false. We use a string in state because <Select> values
  // must be strings, then map back to the JSON tri-state on save.
  const [flattenDefault, setFlattenDefault] = useState<"inherit" | "yes" | "no">(
    "inherit",
  );
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

  // Decorations: each block has its own enabled flag so users can stage
  // a config (e.g. type out a watermark text) without it being applied
  // until they flip the switch. Save logic strips disabled blocks
  // before persisting — same shape as PDF security above.
  const [wmEnabled, setWmEnabled] = useState(false);
  const [wmText, setWmText] = useState("");
  const [wmFontSize, setWmFontSize] = useState(48);
  const [wmColor, setWmColor] = useState("#888888");
  const [wmOpacity, setWmOpacity] = useState(0.3);
  const [wmRotation, setWmRotation] = useState(0);
  const [wmPosition, setWmPosition] = useState("diagonal");
  const [wmPages, setWmPages] = useState("all");
  const [wmOnTop, setWmOnTop] = useState(false);

  const [hdrEnabled, setHdrEnabled] = useState(false);
  const [hdrLeft, setHdrLeft] = useState("");
  const [hdrCenter, setHdrCenter] = useState("");
  const [hdrRight, setHdrRight] = useState("");
  const [hdrFontSize, setHdrFontSize] = useState(9);
  const [hdrColor, setHdrColor] = useState("#666666");
  const [hdrMargin, setHdrMargin] = useState(18);
  const [hdrShowFirst, setHdrShowFirst] = useState(true);
  const [hdrPages, setHdrPages] = useState("");

  const [ftrEnabled, setFtrEnabled] = useState(false);
  const [ftrLeft, setFtrLeft] = useState("");
  const [ftrCenter, setFtrCenter] = useState("");
  const [ftrRight, setFtrRight] = useState("");
  const [ftrFontSize, setFtrFontSize] = useState(9);
  const [ftrColor, setFtrColor] = useState("#666666");
  const [ftrMargin, setFtrMargin] = useState(18);
  const [ftrShowFirst, setFtrShowFirst] = useState(true);
  const [ftrPages, setFtrPages] = useState("");

  // Delivery: same staging pattern as decorations / security — every
  // sub-section has its own enabled flag, and the save logic strips
  // disabled blocks. Recipient slots are kept as comma-joined strings
  // for the simplest possible UX (one input per To/CC/BCC line)
  // because most templates ship to a single address; the array shape
  // on the wire still supports multiple via comma separation.
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailCc, setEmailCc] = useState("");
  const [emailBcc, setEmailBcc] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailAttachPDF, setEmailAttachPDF] = useState(true);
  const [emailIncludeDownloadLink, setEmailIncludeDownloadLink] = useState(false);
  const [emailIncludeShareLink, setEmailIncludeShareLink] = useState(false);

  const [shareEnabled, setShareEnabled] = useState(false);
  const [shareRole, setShareRole] = useState("viewer");
  // Expiry held as a string so an empty input means "no expiry";
  // converted to a number on save. Days is the friendlier UX unit
  // than the raw seconds the server stores.
  const [shareExpiresInDays, setShareExpiresInDays] = useState("");
  const [sharePassword, setSharePassword] = useState("");
  const [showSharePwd, setShowSharePwd] = useState(false);
  const [shareOneTime, setShareOneTime] = useState(false);
  const [shareDownloadLimit, setShareDownloadLimit] = useState("");

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
        const fd = t.config?.output?.flattenDefault;
        setFlattenDefault(fd === true ? "yes" : fd === false ? "no" : "inherit");
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
        const dec = t.config?.decorations;
        if (dec?.watermark && dec.watermark.text) {
          setWmEnabled(true);
          setWmText(dec.watermark.text ?? "");
          setWmFontSize(dec.watermark.fontSize ?? 48);
          setWmColor(dec.watermark.color ?? "#888888");
          setWmOpacity(dec.watermark.opacity ?? 0.3);
          setWmRotation(dec.watermark.rotation ?? 0);
          setWmPosition(dec.watermark.position ?? "diagonal");
          setWmPages(dec.watermark.pages ?? "all");
          setWmOnTop(dec.watermark.onTop ?? false);
        }
        if (
          dec?.header &&
          (dec.header.left || dec.header.center || dec.header.right)
        ) {
          setHdrEnabled(true);
          setHdrLeft(dec.header.left ?? "");
          setHdrCenter(dec.header.center ?? "");
          setHdrRight(dec.header.right ?? "");
          setHdrFontSize(dec.header.fontSize ?? 9);
          setHdrColor(dec.header.color ?? "#666666");
          setHdrMargin(dec.header.margin ?? 18);
          setHdrShowFirst(dec.header.showOnFirstPage ?? true);
          setHdrPages(dec.header.pages ?? "");
        }
        if (
          dec?.footer &&
          (dec.footer.left || dec.footer.center || dec.footer.right)
        ) {
          setFtrEnabled(true);
          setFtrLeft(dec.footer.left ?? "");
          setFtrCenter(dec.footer.center ?? "");
          setFtrRight(dec.footer.right ?? "");
          setFtrFontSize(dec.footer.fontSize ?? 9);
          setFtrColor(dec.footer.color ?? "#666666");
          setFtrMargin(dec.footer.margin ?? 18);
          setFtrShowFirst(dec.footer.showOnFirstPage ?? true);
          setFtrPages(dec.footer.pages ?? "");
        }

        const del = t.config?.delivery;
        if (del?.email && del.email.enabled) {
          setEmailEnabled(true);
          setEmailTo((del.email.to ?? []).join(", "));
          setEmailCc((del.email.cc ?? []).join(", "));
          setEmailBcc((del.email.bcc ?? []).join(", "));
          setEmailSubject(del.email.subject ?? "");
          setEmailBody(del.email.body ?? "");
          setEmailAttachPDF(del.email.attachPDF ?? true);
          setEmailIncludeDownloadLink(del.email.includeDownloadLink ?? false);
          setEmailIncludeShareLink(del.email.includeShareLink ?? false);
        }
        if (del?.share && del.share.enabled) {
          setShareEnabled(true);
          setShareRole(del.share.role || "viewer");
          // expiresIn is seconds on the wire; days in the UI for
          // friendlier muscle memory ("share for 30 days", not
          // "share for 2592000 seconds").
          if (del.share.expiresIn && del.share.expiresIn > 0) {
            setShareExpiresInDays(
              String(Math.round(del.share.expiresIn / 86400)),
            );
          }
          setSharePassword(del.share.password ?? "");
          setShareOneTime(del.share.oneTime ?? false);
          if (del.share.downloadLimit && del.share.downloadLimit > 0) {
            setShareDownloadLimit(String(del.share.downloadLimit));
          }
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

      const hasFolder = folderPath.trim() !== "";
      const hasFilename = filenameTemplate.trim() !== "";
      const flattenSet = flattenDefault !== "inherit";
      if (!hasFolder && !hasFilename && !flattenSet) {
        delete nextConfig.output;
      } else {
        nextConfig.output = {
          ...(hasFolder && { folderPath: folderPath.trim() }),
          ...(hasFilename && {
            filenameTemplate: filenameTemplate.trim(),
          }),
          ...(flattenSet && { flattenDefault: flattenDefault === "yes" }),
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

      // Decorations: build sub-blocks only when they're enabled AND have
      // content. A block toggled "on" but with no text produces nothing
      // useful — skipping it keeps the persisted config tidy and lets
      // pdfdecor.IsEnabled short-circuit on the server.
      const decOut: DecorationsCfg = {};
      if (wmEnabled && wmText.trim() !== "") {
        decOut.watermark = {
          text: wmText.trim(),
          fontSize: wmFontSize,
          color: wmColor,
          opacity: wmOpacity,
          rotation: wmRotation,
          position: wmPosition,
          pages: wmPages,
          onTop: wmOnTop,
        };
      }
      const hdrHasText =
        hdrLeft.trim() !== "" ||
        hdrCenter.trim() !== "" ||
        hdrRight.trim() !== "";
      if (hdrEnabled && hdrHasText) {
        decOut.header = {
          ...(hdrLeft.trim() && { left: hdrLeft.trim() }),
          ...(hdrCenter.trim() && { center: hdrCenter.trim() }),
          ...(hdrRight.trim() && { right: hdrRight.trim() }),
          fontSize: hdrFontSize,
          color: hdrColor,
          margin: hdrMargin,
          showOnFirstPage: hdrShowFirst,
          ...(hdrPages.trim() && { pages: hdrPages.trim() }),
        };
      }
      const ftrHasText =
        ftrLeft.trim() !== "" ||
        ftrCenter.trim() !== "" ||
        ftrRight.trim() !== "";
      if (ftrEnabled && ftrHasText) {
        decOut.footer = {
          ...(ftrLeft.trim() && { left: ftrLeft.trim() }),
          ...(ftrCenter.trim() && { center: ftrCenter.trim() }),
          ...(ftrRight.trim() && { right: ftrRight.trim() }),
          fontSize: ftrFontSize,
          color: ftrColor,
          margin: ftrMargin,
          showOnFirstPage: ftrShowFirst,
          ...(ftrPages.trim() && { pages: ftrPages.trim() }),
        };
      }
      if (!decOut.watermark && !decOut.header && !decOut.footer) {
        delete nextConfig.decorations;
      } else {
        nextConfig.decorations = decOut;
      }

      // Delivery: same pattern — drop disabled blocks so the server
      // doesn't see ghost configuration. splitAddrs collapses the
      // comma-separated UI inputs back into the array shape the
      // server expects, with empty values filtered out so a stray
      // trailing comma doesn't poison the recipient list.
      const splitAddrs = (s: string) =>
        s
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x !== "");
      const delOut: DeliveryCfg = {};
      if (emailEnabled) {
        const to = splitAddrs(emailTo);
        // Refuse to persist email-on with no `To`, otherwise every
        // render produces an "empty recipients" error event. The
        // toast tells the user instead of silently saving a useless
        // config.
        if (to.length === 0) {
          throw new Error("Email delivery: at least one To recipient required");
        }
        delOut.email = {
          enabled: true,
          to,
          ...(splitAddrs(emailCc).length && { cc: splitAddrs(emailCc) }),
          ...(splitAddrs(emailBcc).length && { bcc: splitAddrs(emailBcc) }),
          ...(emailSubject.trim() && { subject: emailSubject.trim() }),
          ...(emailBody.trim() && { body: emailBody.trim() }),
          // attachPDF defaults true on the server — only persist
          // when the user explicitly turned it off, so the saved
          // config stays terse and the default is portable.
          ...(emailAttachPDF === false && { attachPDF: false }),
          ...(emailIncludeDownloadLink && { includeDownloadLink: true }),
          ...(emailIncludeShareLink && { includeShareLink: true }),
        };
      }
      if (shareEnabled) {
        const days = parseInt(shareExpiresInDays, 10);
        const dl = parseInt(shareDownloadLimit, 10);
        delOut.share = {
          enabled: true,
          role: shareRole,
          ...(Number.isFinite(days) && days > 0 && {
            expiresIn: days * 86400,
          }),
          ...(sharePassword.trim() && { password: sharePassword }),
          ...(shareOneTime && { oneTime: true }),
          ...(Number.isFinite(dl) && dl > 0 && { downloadLimit: dl }),
        };
      }
      if (!delOut.email && !delOut.share) {
        delete nextConfig.delivery;
      } else {
        nextConfig.delivery = delOut;
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
        {tpl.mode === "acroform" && (
          <div className="space-y-2">
            <Label>Default flatten behaviour</Label>
            <Select
              value={flattenDefault}
              onValueChange={(v: "inherit" | "yes" | "no") =>
                setFlattenDefault(v)
              }
            >
              <SelectTrigger className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">
                  No default — caller decides each render
                </SelectItem>
                <SelectItem value="yes">
                  Flatten by default (locks fields into the page)
                </SelectItem>
                <SelectItem value="no">
                  Never flatten by default (keeps fields editable)
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Applied when the request body omits{" "}
              <code className="font-mono">flatten</code>. Sending{" "}
              <code className="font-mono">{`"flatten": false`}</code> in
              the request still wins, even when this is set to{" "}
              <em>Flatten by default</em>.
            </p>
          </div>
        )}
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

      {/* --- Decorations: watermarks, headers, footers --- */}
      <section className="space-y-4 rounded-lg border bg-card p-5">
        <div className="flex items-center gap-2">
          <Stamp className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Decorations</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Stamp every rendered PDF with a watermark, running header, or
          footer. Text supports{" "}
          <code className="font-mono">{`{{key}}`}</code> placeholders from
          the request <code className="font-mono">data</code>, plus four
          built-ins:{" "}
          <code className="font-mono">{`{{page}}`}</code>,{" "}
          <code className="font-mono">{`{{pages}}`}</code>,{" "}
          <code className="font-mono">{`{{generatedAt}}`}</code>, and{" "}
          <code className="font-mono">{`{{date}}`}</code>. Applied
          server-side before any PDF security is enforced — recipients
          can&rsquo;t edit them out.
        </p>

        {/* Watermark */}
        <div className="rounded-md border p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Watermark</p>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={wmEnabled}
                onChange={(e) => setWmEnabled(e.target.checked)}
                aria-label="Enable watermark"
              />
              <span>Enabled</span>
            </label>
          </div>
          {wmEnabled && (
            <div className="mt-3 space-y-3">
              <div className="space-y-2">
                <Label htmlFor="wmText">Text</Label>
                <Input
                  id="wmText"
                  placeholder="DRAFT"
                  value={wmText}
                  onChange={(e) => setWmText(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="wmPosition">Position</Label>
                  <Select value={wmPosition} onValueChange={setWmPosition}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="diagonal">
                        Diagonal (DRAFT-style)
                      </SelectItem>
                      <SelectItem value="center">Center</SelectItem>
                      <SelectItem value="top-left">Top-left</SelectItem>
                      <SelectItem value="top-center">Top-center</SelectItem>
                      <SelectItem value="top-right">Top-right</SelectItem>
                      <SelectItem value="bottom-left">Bottom-left</SelectItem>
                      <SelectItem value="bottom-center">
                        Bottom-center
                      </SelectItem>
                      <SelectItem value="bottom-right">Bottom-right</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wmPages">Pages</Label>
                  <Input
                    id="wmPages"
                    placeholder="all"
                    value={wmPages}
                    onChange={(e) => setWmPages(e.target.value)}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    <code className="font-mono">all</code> /{" "}
                    <code className="font-mono">first</code> /{" "}
                    <code className="font-mono">last</code> /{" "}
                    <code className="font-mono">1,3-5</code>
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wmColor">Color</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      id="wmColor"
                      value={wmColor}
                      onChange={(e) => setWmColor(e.target.value)}
                      className="h-9 w-12 cursor-pointer rounded border bg-transparent"
                      aria-label="Watermark color"
                    />
                    <Input
                      value={wmColor}
                      onChange={(e) => setWmColor(e.target.value)}
                      className="font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="wmFontSize">Font size (pt)</Label>
                  <Input
                    id="wmFontSize"
                    type="number"
                    min={6}
                    max={400}
                    value={wmFontSize}
                    onChange={(e) =>
                      setWmFontSize(Number(e.target.value) || 0)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wmOpacity">
                    Opacity ({wmOpacity.toFixed(2)})
                  </Label>
                  <input
                    id="wmOpacity"
                    type="range"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={wmOpacity}
                    onChange={(e) => setWmOpacity(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wmRotation">Rotation (°)</Label>
                  <Input
                    id="wmRotation"
                    type="number"
                    min={-180}
                    max={180}
                    value={wmRotation}
                    onChange={(e) =>
                      setWmRotation(Number(e.target.value) || 0)
                    }
                    disabled={wmPosition === "diagonal"}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Ignored in diagonal mode.
                  </p>
                </div>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-input"
                  checked={wmOnTop}
                  onChange={(e) => setWmOnTop(e.target.checked)}
                />
                <span>
                  Stamp <em>over</em> page content (otherwise drawn under
                  it)
                </span>
              </label>
            </div>
          )}
        </div>

        {/* Header */}
        <HeaderFooterEditor
          title="Header"
          enabled={hdrEnabled}
          setEnabled={setHdrEnabled}
          left={hdrLeft}
          setLeft={setHdrLeft}
          center={hdrCenter}
          setCenter={setHdrCenter}
          right={hdrRight}
          setRight={setHdrRight}
          fontSize={hdrFontSize}
          setFontSize={setHdrFontSize}
          color={hdrColor}
          setColor={setHdrColor}
          margin={hdrMargin}
          setMargin={setHdrMargin}
          showOnFirstPage={hdrShowFirst}
          setShowOnFirstPage={setHdrShowFirst}
          pages={hdrPages}
          setPages={setHdrPages}
          idPrefix="hdr"
        />

        {/* Footer */}
        <HeaderFooterEditor
          title="Footer"
          enabled={ftrEnabled}
          setEnabled={setFtrEnabled}
          left={ftrLeft}
          setLeft={setFtrLeft}
          center={ftrCenter}
          setCenter={setFtrCenter}
          right={ftrRight}
          setRight={setFtrRight}
          fontSize={ftrFontSize}
          setFontSize={setFtrFontSize}
          color={ftrColor}
          setColor={setFtrColor}
          margin={ftrMargin}
          setMargin={setFtrMargin}
          showOnFirstPage={ftrShowFirst}
          setShowOnFirstPage={setFtrShowFirst}
          pages={ftrPages}
          setPages={setFtrPages}
          idPrefix="ftr"
        />
      </section>

      {/* --- Delivery: auto-email + auto-share-link --- */}
      <section className="space-y-4 rounded-lg border bg-card p-5">
        <div className="flex items-center gap-2">
          <Send className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Delivery</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Fan out every successful render to email recipients and / or a
          public share link. Both flows are best-effort — a delivery
          failure is recorded in the event payload but does not fail the
          render itself. Recipients, subject, and body support{" "}
          <code className="font-mono">{`{{key}}`}</code> placeholders
          against the request <code className="font-mono">data</code>.
        </p>

        {/* Email */}
        <div className="rounded-md border p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-medium">Auto-email on render</p>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={emailEnabled}
                onChange={(e) => setEmailEnabled(e.target.checked)}
                aria-label="Enable auto-email"
              />
              <span>Enabled</span>
            </label>
          </div>
          {emailEnabled && (
            <div className="mt-3 space-y-3">
              <div className="space-y-2">
                <Label htmlFor="emailTo">To (comma-separated)</Label>
                <Input
                  id="emailTo"
                  placeholder="{{customerEmail}}, billing@example.com"
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                />
                <p className="text-[10px] text-muted-foreground">
                  Required. Unresolved <code className="font-mono">{`{{...}}`}</code>{" "}
                  placeholders are dropped silently rather than mailed
                  literally — a mistyped key surfaces as a missing
                  recipient, not a noisy bounce.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="emailCc">CC</Label>
                  <Input
                    id="emailCc"
                    placeholder="{{managerEmail}}"
                    value={emailCc}
                    onChange={(e) => setEmailCc(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="emailBcc">BCC</Label>
                  <Input
                    id="emailBcc"
                    placeholder="archive@example.com"
                    value={emailBcc}
                    onChange={(e) => setEmailBcc(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="emailSubject">Subject</Label>
                <Input
                  id="emailSubject"
                  placeholder="Your invoice {{invoiceNumber}}"
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="emailBody">Body</Label>
                <textarea
                  id="emailBody"
                  rows={5}
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder={`Hi {{customerName}},\n\nYour invoice is attached.`}
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                />
              </div>
              <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-input"
                    checked={emailAttachPDF}
                    onChange={(e) => setEmailAttachPDF(e.target.checked)}
                  />
                  <span>
                    <span className="font-medium">Attach the PDF</span>
                    <span className="block text-muted-foreground">
                      In-band delivery — recipient gets the file
                      immediately. Turn off when outputs are very large.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-input"
                    checked={emailIncludeDownloadLink}
                    onChange={(e) =>
                      setEmailIncludeDownloadLink(e.target.checked)
                    }
                  />
                  <span>
                    <span className="font-medium">
                      Include a 24h download link
                    </span>
                    <span className="block text-muted-foreground">
                      Presigned, expires in 24 hours. Useful as a
                      re-download path.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-input"
                    checked={emailIncludeShareLink}
                    onChange={(e) =>
                      setEmailIncludeShareLink(e.target.checked)
                    }
                    disabled={!shareEnabled}
                  />
                  <span>
                    <span className="font-medium">
                      Include the public share link
                    </span>
                    <span className="block text-muted-foreground">
                      Honours the share policy below
                      {!shareEnabled && (
                        <em> — enable share links to use this</em>
                      )}
                      .
                    </span>
                  </span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Share */}
        <div className="rounded-md border p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Auto share-link on render</p>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={shareEnabled}
                onChange={(e) => setShareEnabled(e.target.checked)}
                aria-label="Enable auto-share-link"
              />
              <span>Enabled</span>
            </label>
          </div>
          {shareEnabled && (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                Every successful render mints a public share link. The
                URL is returned in the API response, the webhook
                payload, and (optionally) the auto-email body.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Role</Label>
                  <Select value={shareRole} onValueChange={setShareRole}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="viewer">
                        Viewer (preview only)
                      </SelectItem>
                      <SelectItem value="downloader">
                        Downloader (preview + download)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="shareExpiry">Expires after (days)</Label>
                  <Input
                    id="shareExpiry"
                    type="number"
                    min={0}
                    placeholder="Never"
                    value={shareExpiresInDays}
                    onChange={(e) => setShareExpiresInDays(e.target.value)}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Blank = no expiry. 30 is a common pick for
                    self-cleaning links.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="sharePwd">Password (optional)</Label>
                  <div className="relative">
                    <Input
                      id="sharePwd"
                      type={showSharePwd ? "text" : "password"}
                      placeholder="Leave blank for no password"
                      value={sharePassword}
                      onChange={(e) => setSharePassword(e.target.value)}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSharePwd((s) => !s)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={
                        showSharePwd ? "Hide password" : "Show password"
                      }
                    >
                      {showSharePwd ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Bcrypt-hashed before storage; recipients enter the
                    plaintext on the share page.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="shareDlLimit">Download limit</Label>
                  <Input
                    id="shareDlLimit"
                    type="number"
                    min={0}
                    placeholder="Unlimited"
                    value={shareDownloadLimit}
                    onChange={(e) => setShareDownloadLimit(e.target.value)}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Counts download actions only — preview views are free.
                  </p>
                </div>
              </div>
              <label className="flex cursor-pointer items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-input"
                  checked={shareOneTime}
                  onChange={(e) => setShareOneTime(e.target.checked)}
                />
                <span>
                  <span className="font-medium">One-time link</span>
                  <span className="block text-muted-foreground">
                    Self-revokes after the first download. Combine with a
                    short expiry for sensitive deliveries.
                  </span>
                </span>
              </label>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// HeaderFooterEditor renders the same three-slot panel for both the
// header and the footer block. Pulled out as a sub-component because
// the JSX would otherwise duplicate ~80 lines per region — the only
// thing that differs is the title (and the underlying state setters).
function HeaderFooterEditor({
  title,
  enabled,
  setEnabled,
  left,
  setLeft,
  center,
  setCenter,
  right,
  setRight,
  fontSize,
  setFontSize,
  color,
  setColor,
  margin,
  setMargin,
  showOnFirstPage,
  setShowOnFirstPage,
  pages,
  setPages,
  idPrefix,
}: {
  title: string;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  left: string;
  setLeft: (v: string) => void;
  center: string;
  setCenter: (v: string) => void;
  right: string;
  setRight: (v: string) => void;
  fontSize: number;
  setFontSize: (v: number) => void;
  color: string;
  setColor: (v: string) => void;
  margin: number;
  setMargin: (v: number) => void;
  showOnFirstPage: boolean;
  setShowOnFirstPage: (v: boolean) => void;
  pages: string;
  setPages: (v: string) => void;
  idPrefix: string;
}) {
  return (
    <div className="rounded-md border p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{title}</p>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            aria-label={`Enable ${title.toLowerCase()}`}
          />
          <span>Enabled</span>
        </label>
      </div>
      {enabled && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}Left`}>Left</Label>
              <Input
                id={`${idPrefix}Left`}
                placeholder="{{customerName}}"
                value={left}
                onChange={(e) => setLeft(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}Center`}>Center</Label>
              <Input
                id={`${idPrefix}Center`}
                placeholder="{{documentTitle}}"
                value={center}
                onChange={(e) => setCenter(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}Right`}>Right</Label>
              <Input
                id={`${idPrefix}Right`}
                placeholder="Page {{page}} of {{pages}}"
                value={right}
                onChange={(e) => setRight(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}FontSize`}>Font size (pt)</Label>
              <Input
                id={`${idPrefix}FontSize`}
                type="number"
                min={5}
                max={36}
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value) || 0)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}Color`}>Color</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  id={`${idPrefix}Color`}
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-9 w-12 cursor-pointer rounded border bg-transparent"
                  aria-label={`${title} color`}
                />
                <Input
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}Margin`}>Margin (pt)</Label>
              <Input
                id={`${idPrefix}Margin`}
                type="number"
                min={0}
                max={144}
                value={margin}
                onChange={(e) => setMargin(Number(e.target.value) || 0)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}Pages`}>Pages</Label>
              <Input
                id={`${idPrefix}Pages`}
                placeholder="all"
                value={pages}
                onChange={(e) => setPages(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">
                Defaults to all pages.
              </p>
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={showOnFirstPage}
              onChange={(e) => setShowOnFirstPage(e.target.checked)}
            />
            <span>Show on first page</span>
          </label>
        </div>
      )}
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
