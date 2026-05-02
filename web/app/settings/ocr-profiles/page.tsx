"use client";

// OCR profiles authoring page.
//
// Two flavours of caller, one page:
//
//   - Org admin lands here from /settings (Admin → "OCR profiles") and
//     can CRUD profiles scoped to their own org. Built-ins (platform-
//     shipped Aadhaar, PAN, Receipt, etc.) appear in the list as
//     read-only — they're shown so the user can see their full picker
//     inventory in one view, but the Edit button is hidden.
//   - Super admin lands here from /admin → "OCR profiles" and
//     additionally gets edit/delete on built-ins. Creating a new
//     profile prompts whether it's an org-scoped row or a new platform
//     built-in via the "Make this a platform built-in" toggle in the
//     editor.
//
// The backend enforces the same gates (handler.go), so this UI is just
// a convenience filter — bypassing it via a direct API call still 403s.
//
// # Why one page instead of two
//
// The data is identical (same list endpoint, same row shape) and the
// editor differs by exactly one toggle. Splitting into /settings/
// ocr-profiles and /admin/ocr-profiles would duplicate the
// 400 lines of editor + list code for that single boolean. Instead we
// branch on `isSuperAdmin` from the cached user blob; the URL is
// reached from either sidebar group.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookMarked,
  Car,
  CreditCard,
  FileText,
  IdCard,
  Pencil,
  Plus,
  Receipt,
  RefreshCcw,
  Save,
  ScanText,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { api, ApiError, getUser } from "@/lib/api";
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type ProfileDTO = {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  lang?: string;
  psm: number;
  preprocess?: boolean | null;
  fields: string[];
  extractors: Record<string, string>;
  llmPrompt: string;
  builtin: boolean;
  orgScoped: boolean;
  createdAt?: string;
  updatedAt?: string;
};

// PSM list from tesseract docs. -1 is our internal sentinel for
// "inherit operator default"; 0 (osd-only) and 1 (auto+osd) are
// excluded because they don't return text. The remaining values are
// the ones a profile author would realistically pick.
const PSM_CHOICES: Array<{ value: number; label: string }> = [
  { value: -1, label: "Inherit (operator default)" },
  { value: 3, label: "3 — Auto, no OSD (default)" },
  { value: 4, label: "4 — Single column of variable text" },
  { value: 6, label: "6 — Single uniform block (recommended for IDs)" },
  { value: 7, label: "7 — Single text line" },
  { value: 8, label: "8 — Single word" },
  { value: 11, label: "11 — Sparse text" },
  { value: 13, label: "13 — Raw line, no layout analysis" },
];

// Lucide icon string → component. The picker tiles in the designer use
// the same map; keeping this in one file is fine because the set is
// fixed and small. Unknown icons fall back to FileText.
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  "id-card": IdCard,
  "credit-card": CreditCard,
  car: Car,
  "book-marked": BookMarked,
  receipt: Receipt,
  "file-text": FileText,
  "scan-text": ScanText,
};

const ICON_CHOICES = Object.keys(ICON_MAP);

function ProfileIcon({ name, className }: { name: string; className?: string }) {
  const C = ICON_MAP[name] ?? FileText;
  return <C className={className} />;
}

// Fresh DTO for "+ New profile". PSM=-1 = inherit, no overrides yet.
function emptyDraft(): ProfileDTO {
  return {
    id: "",
    slug: "",
    name: "",
    description: "",
    icon: "file-text",
    lang: "",
    psm: -1,
    preprocess: null,
    fields: [],
    extractors: {},
    llmPrompt: "",
    builtin: false,
    orgScoped: true,
  };
}

export default function OcrProfilesPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<ProfileDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ProfileDTO | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  // Super admin state is derived from the cached user blob — same
  // source the sidebar uses to decide which links to show.
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  useEffect(() => {
    const u = getUser();
    setIsSuperAdmin(!!u?.isSuperAdmin);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ profiles: ProfileDTO[] }>("/v1/ocr/profiles");
      setProfiles(r.profiles ?? []);
    } catch (e: any) {
      toast.show("error", "Failed to load profiles", { description: e?.message });
      setProfiles([]);
    } finally {
      setLoading(false);
    }
    // toast is a fresh object every render — including it would re-create
    // `load`, which would re-fire the mount effect below in a loop and
    // hammer /v1/ocr/profiles. The toast methods themselves dispatch
    // through module-scope shadcn calls so they're safe to use without
    // a dep entry. Same pattern as /admin/users.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // canEdit captures the per-row gate the backend will enforce. Hiding
  // the button rather than disabling it (with a "you don't have rights"
  // tooltip) keeps the surface clean — every visible action is one the
  // user can actually take.
  const canEdit = useCallback(
    (p: ProfileDTO) => {
      if (p.builtin) return isSuperAdmin;
      return true; // org-scoped: org admin landing on this page can always edit own org's
    },
    [isSuperAdmin],
  );

  const startNew = () => {
    setEditing(emptyDraft());
    setIsNew(true);
  };

  const startEdit = (p: ProfileDTO) => {
    setEditing(JSON.parse(JSON.stringify(p))); // deep clone so the editor edits don't mutate the list
    setIsNew(false);
  };

  const cancel = () => {
    setEditing(null);
    setIsNew(false);
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      // Strip the generated/computed fields the server doesn't accept on
      // write. Slug is forced lowercase here so a copy-paste of "PAN"
      // doesn't 400 on the regex check.
      const body = {
        slug: editing.slug.toLowerCase().trim(),
        name: editing.name.trim(),
        description: editing.description.trim(),
        icon: editing.icon || "file-text",
        lang: editing.lang || "",
        psm: editing.psm,
        preprocess: editing.preprocess,
        fields: editing.fields.filter((f) => f.trim() !== ""),
        extractors: Object.fromEntries(
          Object.entries(editing.extractors).filter(
            ([k, v]) => k.trim() !== "" && v.trim() !== "",
          ),
        ),
        llmPrompt: editing.llmPrompt,
        builtin: editing.builtin,
      };
      if (isNew) {
        await api("/v1/ocr/profiles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        toast.show("success", "Profile created");
      } else {
        await api(`/v1/ocr/profiles/${editing.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        toast.show("success", "Profile saved");
      }
      cancel();
      await load();
    } catch (e: any) {
      // The backend returns structured codes (slug_conflict, etc.) — we
      // surface message text directly because the codes are precise
      // enough that the human-readable message is already the right
      // error to show. ApiError preserves both for future branching.
      const msg = e instanceof ApiError ? e.message : e?.message;
      toast.show("error", "Save failed", { description: msg });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: ProfileDTO) => {
    const ok = await confirm({
      title: `Delete "${p.name}"?`,
      description: p.builtin
        ? "This is a platform-wide built-in. Deleting it removes it for every org. The 'generic' profile cannot be deleted."
        : "Users in this org will lose access to this profile in the picker.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/ocr/profiles/${p.id}`, { method: "DELETE" });
      toast.show("success", "Profile deleted");
      await load();
    } catch (e: any) {
      toast.show("error", "Delete failed", {
        description: e instanceof ApiError ? e.message : e?.message,
      });
    }
  };

  const builtinList = useMemo(
    () => (profiles ?? []).filter((p) => p.builtin),
    [profiles],
  );
  const orgList = useMemo(
    () => (profiles ?? []).filter((p) => !p.builtin),
    [profiles],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">OCR profiles</h1>
          <p className="text-sm text-muted-foreground">
            Document-type presets the Extract Text picker reads from.
            Each profile bundles tesseract knobs, regex extractors, and an
            optional LLM cleanup prompt.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCcw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          <Button size="sm" onClick={startNew}>
            <Plus className="mr-1 h-4 w-4" /> New profile
          </Button>
        </div>
      </div>

      {/* Org-authored section comes first because it's the section the
          user is most likely editing on this page. Built-ins below act
          as reference documentation as much as live profiles. */}
      <Card>
        <CardHeader>
          <CardTitle>Your organization's profiles</CardTitle>
          <CardDescription>
            Custom document types authored for your org. Visible only to
            users in this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : orgList.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No org-specific profiles yet. Click "New profile" to author one.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {orgList.map((p) => (
                <ProfileRow
                  key={p.id}
                  p={p}
                  canEdit={canEdit(p)}
                  onEdit={() => startEdit(p)}
                  onDelete={() => void remove(p)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Built-in profiles
            <Badge variant="secondary">Platform-wide</Badge>
          </CardTitle>
          <CardDescription>
            Shipped by the platform and visible to every org.{" "}
            {isSuperAdmin
              ? "You can edit these — changes take effect for all tenants."
              : "Only super admins can modify these. They're shown here so you can see the full picker inventory."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-14 w-full" />
          ) : builtinList.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              <AlertTriangle className="mr-2 inline h-4 w-4" />
              No built-ins loaded — has migration 047 run on this database?
            </div>
          ) : (
            <ul className="divide-y rounded-md border">
              {builtinList.map((p) => (
                <ProfileRow
                  key={p.id || p.slug}
                  p={p}
                  canEdit={canEdit(p)}
                  onEdit={() => startEdit(p)}
                  onDelete={() => void remove(p)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Editor dialog. Mounted at the page level so the form state can
          survive list reloads (the `editing` object is the source of
          truth while open). */}
      {editing && (
        <ProfileEditor
          value={editing}
          isNew={isNew}
          isSuperAdmin={isSuperAdmin}
          saving={saving}
          onChange={setEditing}
          onCancel={cancel}
          onSave={save}
        />
      )}
    </div>
  );
}

/* ----------------------------- Row ----------------------------- */

function ProfileRow({
  p,
  canEdit,
  onEdit,
  onDelete,
}: {
  p: ProfileDTO;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // The "generic" built-in is the runtime fallback for unknown slugs;
  // the backend rejects deletion. We surface that here by hiding the
  // delete button entirely for that one row.
  const canDelete = canEdit && !(p.builtin && p.slug === "generic");
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="rounded-md bg-muted p-2">
          <ProfileIcon name={p.icon} className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{p.name}</span>
            <code className="rounded bg-muted px-1 text-xs">{p.slug}</code>
            {p.builtin && <Badge variant="secondary">Built-in</Badge>}
            {p.llmPrompt && (
              <Badge variant="outline" className="gap-1">
                <Sparkles className="h-3 w-3" /> LLM cleanup
              </Badge>
            )}
          </div>
          {p.description && (
            <p className="mt-0.5 text-sm text-muted-foreground line-clamp-2">
              {p.description}
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-1">
            {p.fields.map((f) => (
              <Badge key={f} variant="outline" className="text-xs">
                {f}
              </Badge>
            ))}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canEdit && (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </Button>
        )}
        {canDelete && (
          <Button variant="ghost" size="sm" onClick={onDelete}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        )}
      </div>
    </li>
  );
}

/* ---------------------------- Editor --------------------------- */

function ProfileEditor({
  value,
  isNew,
  isSuperAdmin,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  value: ProfileDTO;
  isNew: boolean;
  isSuperAdmin: boolean;
  saving: boolean;
  onChange: (p: ProfileDTO) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  // Local helpers to keep the JSX readable. `set` shallow-merges; the
  // dynamic field/extractor rows mutate via dedicated helpers because
  // they need both index and key.
  const set = (patch: Partial<ProfileDTO>) => onChange({ ...value, ...patch });

  const setField = (idx: number, v: string) => {
    const next = [...value.fields];
    next[idx] = v;
    set({ fields: next });
  };
  const addField = () => set({ fields: [...value.fields, ""] });
  const removeField = (idx: number) =>
    set({ fields: value.fields.filter((_, i) => i !== idx) });

  // Extractors are stored as map but edited as ordered rows — we project
  // into an entries array on render and rebuild the map on every key/
  // value tweak so duplicate keys "just work" until the user disambiguates.
  const extractorEntries = useMemo(
    () => Object.entries(value.extractors),
    [value.extractors],
  );
  const setExtractorKey = (idx: number, key: string) => {
    const next: Record<string, string> = {};
    extractorEntries.forEach(([k, v], i) => {
      next[i === idx ? key : k] = v;
    });
    set({ extractors: next });
  };
  const setExtractorValue = (idx: number, v: string) => {
    const next: Record<string, string> = {};
    extractorEntries.forEach(([k, val], i) => {
      next[k] = i === idx ? v : val;
    });
    set({ extractors: next });
  };
  const addExtractor = () => {
    set({ extractors: { ...value.extractors, "": "" } });
  };
  const removeExtractor = (idx: number) => {
    const next: Record<string, string> = {};
    extractorEntries.forEach(([k, v], i) => {
      if (i !== idx) next[k] = v;
    });
    set({ extractors: next });
  };

  const canTogglePreprocess = value.preprocess !== undefined;
  const preprocessValue: "inherit" | "on" | "off" =
    value.preprocess === null || value.preprocess === undefined
      ? "inherit"
      : value.preprocess
        ? "on"
        : "off";

  // Slug is immutable post-create — surface that with a disabled input
  // rather than removing the field entirely so users see what slug a
  // row was saved with.
  const slugLocked = !isNew;

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "New OCR profile" : `Edit ${value.name || value.slug}`}
          </DialogTitle>
          <DialogDescription>
            {isNew
              ? "Configure tesseract knobs and field extractors for a new document type."
              : "Slug cannot be changed — clients persist it in localStorage."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="slug">Slug</Label>
              <Input
                id="slug"
                value={value.slug}
                disabled={slugLocked}
                onChange={(e) => set({ slug: e.target.value.toLowerCase() })}
                placeholder="vendor-x-invoice"
                pattern="[a-z0-9][a-z0-9-]*"
              />
              <p className="text-xs text-muted-foreground">
                Lowercase, digits, dashes. Used as the URL/cache key.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={value.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="Vendor X Invoice"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              value={value.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="Short hint shown in the picker"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="icon">Icon</Label>
              <Select
                value={value.icon}
                onValueChange={(v) => set({ icon: v })}
              >
                <SelectTrigger id="icon">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ICON_CHOICES.map((c) => (
                    <SelectItem key={c} value={c}>
                      <span className="flex items-center gap-2">
                        <ProfileIcon name={c} className="h-4 w-4" />
                        {c}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lang">Language</Label>
              <Input
                id="lang"
                value={value.lang ?? ""}
                onChange={(e) => set({ lang: e.target.value })}
                placeholder="eng (blank = inherit)"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="psm">Page-segmentation mode</Label>
              <Select
                value={String(value.psm)}
                onValueChange={(v) => set({ psm: Number(v) })}
              >
                <SelectTrigger id="psm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PSM_CHOICES.map((c) => (
                    <SelectItem key={c.value} value={String(c.value)}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Imagemagick preprocessing</Label>
            <Select
              value={preprocessValue}
              onValueChange={(v) =>
                set({
                  preprocess: v === "inherit" ? null : v === "on",
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Inherit operator default</SelectItem>
                <SelectItem value="on">Force on (deskew + denoise)</SelectItem>
                <SelectItem value="off">Force off (already-rectified scans)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Display fields — ordered list, drives the result-table column
              order. Empty rows are stripped at save time so the user can
              add a placeholder without committing to it. */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Display fields</Label>
              <Button variant="outline" size="sm" onClick={addField}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add field
              </Button>
            </div>
            {value.fields.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No fields configured. Add field keys (e.g. "vendor", "total") to drive the result-table columns.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {value.fields.map((f, i) => (
                  <li key={i} className="flex gap-2">
                    <Input
                      value={f}
                      onChange={(e) => setField(i, e.target.value)}
                      placeholder="field_key"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeField(i)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Regex extractors. Two columns: field key (left) and Go regex
              (right). The first capture group of each regex is the value
              the UI surfaces. Bad regex is rejected on save by the
              backend's regexp.Compile check. */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Regex extractors</Label>
              <Button variant="outline" size="sm" onClick={addExtractor}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add extractor
              </Button>
            </div>
            {extractorEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No extractors. Add a field key + Go regex; the first capture group becomes the value.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {extractorEntries.map(([k, v], i) => (
                  <li key={i} className="grid grid-cols-[140px_1fr_auto] gap-2">
                    <Input
                      value={k}
                      onChange={(e) => setExtractorKey(i, e.target.value)}
                      placeholder="field_key"
                      className="font-mono text-xs"
                    />
                    <Input
                      value={v}
                      onChange={(e) => setExtractorValue(i, e.target.value)}
                      placeholder="(?i)Total\\s*[:\\-]?\\s*([\\d.]+)"
                      className="font-mono text-xs"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeExtractor(i)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* LLM cleanup prompt. Optional — empty disables the cleanup
              pass so the endpoint just returns regex-extracted fields.
              Hard-capped at 4000 chars by the backend; we don't show a
              counter because anyone hitting that ceiling on this prompt
              is way outside our intended use. */}
          <div className="space-y-1.5">
            <Label htmlFor="prompt" className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" /> LLM cleanup prompt
              <span className="text-xs font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <textarea
              id="prompt"
              value={value.llmPrompt}
              onChange={(e) => set({ llmPrompt: e.target.value })}
              rows={6}
              spellCheck={false}
              placeholder="System prompt for the chat model. Empty = no LLM cleanup."
              className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              Sent as the system message to the chat model. Tell it to
              return JSON with the fields above as keys.
            </p>
          </div>

          {/* Super-admin-only toggle for promoting a profile to a platform
              built-in. Hidden for regular org admins — the backend would
              403 anyway and showing a non-functional toggle is worse
              than not showing it. */}
          {isSuperAdmin && isNew && (
            <div className="flex items-center justify-between rounded-md border bg-muted/50 p-3">
              <div className="space-y-0.5">
                <Label className="text-sm">Make this a platform built-in</Label>
                <p className="text-xs text-muted-foreground">
                  Visible to every org. Only you (and other super admins)
                  can edit it later.
                </p>
              </div>
              <input
                type="checkbox"
                checked={value.builtin}
                onChange={(e) => set({ builtin: e.target.checked })}
                className="h-4 w-4"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            <Save className="mr-1 h-4 w-4" />
            {saving ? "Saving…" : isNew ? "Create profile" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
