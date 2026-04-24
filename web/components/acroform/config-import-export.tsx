"use client";

// useConfigImportExport — hook that provides download/upload of an
// AcroForm template's mapping + cross-validation config as a portable
// JSON file, plus the preview dialog rendered by the returned `dialog`.
//
// Why a hook and not a button pair
// --------------------------------
// The header was originally shipping two ad-hoc buttons; the refactored
// header hides them behind a "Tools" dropdown menu. Radix menus need
// the trigger to be a simple JSX node, not a component wrapping more
// JSX siblings, so we expose plain callbacks (`download`,
// `openFilePicker`) and a single dialog node the parent renders once.
//
// Import safety
// -------------
// Import fully replaces the current mappings + crossValidations. The
// preview dialog shows a diff (added/changed/removed) before the user
// commits — no accidental wipes. Field names not present in the
// current template are still loaded (the mapping may outlive a
// structure re-extraction), but those mappings stay inert until a
// field of that name exists.

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AcroMapping, CrossValidation, MappingMap } from "./types";

export type ConfigPayload = {
  version: number; // file-format version (not template version)
  exportedAt: string;
  templateName?: string;
  mappings: MappingMap;
  crossValidations: CrossValidation[];
};

const FILE_VERSION = 1;

type Args = {
  templateName: string;
  mappings: MappingMap;
  crossValidations: CrossValidation[];
  onImport: (next: {
    mappings: MappingMap;
    crossValidations: CrossValidation[];
  }) => void;
};

export type ConfigImportExport = {
  download: () => void;
  openFilePicker: () => void;
  // JSX — the parent mounts this once near the end of its tree.
  dialog: React.ReactNode;
};

export function useConfigImportExport({
  templateName,
  mappings,
  crossValidations,
  onImport,
}: Args): ConfigImportExport {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [incoming, setIncoming] = useState<ConfigPayload | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);

  function download() {
    const payload: ConfigPayload = {
      version: FILE_VERSION,
      exportedAt: new Date().toISOString(),
      templateName,
      mappings,
      crossValidations,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safe = templateName.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40);
    a.download = `${safe || "template"}-config.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function openFilePicker() {
    fileRef.current?.click();
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!parsed || typeof parsed !== "object") {
          throw new Error("Not a valid JSON object");
        }
        if (parsed.version !== FILE_VERSION) {
          // Permissive — unknown version numbers shouldn't block import,
          // but warn so the user notices.
          console.warn(
            `[config-import] file version ${parsed.version} vs expected ${FILE_VERSION}`
          );
        }
        if (!parsed.mappings || typeof parsed.mappings !== "object") {
          throw new Error("Missing mappings object");
        }
        setIncoming({
          version: parsed.version ?? 0,
          exportedAt: parsed.exportedAt ?? "",
          templateName: parsed.templateName,
          mappings: parsed.mappings,
          crossValidations: Array.isArray(parsed.crossValidations)
            ? parsed.crossValidations
            : [],
        });
        setParseErr(null);
        setPreviewOpen(true);
      } catch (err: any) {
        setParseErr(err.message || "Could not parse JSON");
        setPreviewOpen(true);
      }
    };
    reader.readAsText(file);
    // Reset so re-selecting the same file re-fires onChange.
    e.target.value = "";
  }

  const diff = incoming ? computeDiff(mappings, incoming.mappings) : null;
  const crossChange =
    incoming && crossValidations.length !== incoming.crossValidations.length;

  const dialog = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onFile}
      />
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import config</DialogTitle>
            <DialogDescription>
              Review what will change before replacing your current
              mappings. This replaces all mappings and cross-validations.
            </DialogDescription>
          </DialogHeader>
          {parseErr ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {parseErr}
            </div>
          ) : incoming && diff ? (
            <div className="space-y-3 text-xs">
              {incoming.templateName && (
                <div className="text-muted-foreground">
                  Source template: <strong>{incoming.templateName}</strong>
                </div>
              )}
              <div className="grid grid-cols-3 gap-2 rounded-md border p-3">
                <DiffStat label="Added" count={diff.added.length} tint="emerald" />
                <DiffStat label="Changed" count={diff.changed.length} tint="amber" />
                <DiffStat label="Removed" count={diff.removed.length} tint="red" />
              </div>
              <DiffSection title="Added" items={diff.added} max={10} />
              <DiffSection title="Changed" items={diff.changed} max={10} />
              <DiffSection title="Removed" items={diff.removed} max={10} />
              <div className="text-muted-foreground">
                Cross-validations: {crossValidations.length} →{" "}
                {incoming.crossValidations.length}
                {crossChange && " (changed)"}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPreviewOpen(false)}
            >
              Cancel
            </Button>
            {incoming && !parseErr && (
              <Button
                size="sm"
                onClick={() => {
                  onImport({
                    mappings: incoming.mappings,
                    crossValidations: incoming.crossValidations,
                  });
                  setPreviewOpen(false);
                  setIncoming(null);
                }}
              >
                Replace {Object.keys(incoming.mappings).length} mapping
                {Object.keys(incoming.mappings).length === 1 ? "" : "s"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  return { download, openFilePicker, dialog };
}

type MappingDiff = {
  added: string[];
  changed: string[];
  removed: string[];
};

function computeDiff(current: MappingMap, incoming: MappingMap): MappingDiff {
  const out: MappingDiff = { added: [], changed: [], removed: [] };
  const curKeys = new Set(Object.keys(current));
  const incKeys = new Set(Object.keys(incoming));
  for (const k of incKeys) {
    if (!curKeys.has(k)) out.added.push(k);
    else if (!mappingEqual(current[k], incoming[k])) out.changed.push(k);
  }
  for (const k of curKeys) {
    if (!incKeys.has(k)) out.removed.push(k);
  }
  return out;
}

function mappingEqual(a: AcroMapping, b: AcroMapping): boolean {
  // JSON compare is fine — mappings are small, flat-ish objects and this
  // runs once per import click.
  return JSON.stringify(a) === JSON.stringify(b);
}

function DiffStat({
  label,
  count,
  tint,
}: {
  label: string;
  count: number;
  tint: "emerald" | "amber" | "red";
}) {
  const color =
    tint === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tint === "amber"
      ? "text-amber-600 dark:text-amber-400"
      : "text-red-600 dark:text-red-400";
  return (
    <div className="flex flex-col items-center">
      <div className={`text-lg font-semibold ${color}`}>{count}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function DiffSection({
  title,
  items,
  max,
}: {
  title: string;
  items: string[];
  max: number;
}) {
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title} ({items.length})
      </div>
      <div className="flex flex-wrap gap-1">
        {shown.map((n) => (
          <span
            key={n}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
          >
            {n}
          </span>
        ))}
        {more > 0 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            +{more} more
          </span>
        )}
      </div>
    </div>
  );
}
