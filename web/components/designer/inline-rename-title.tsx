"use client";

/**
 * Inline rename affordance used in every designer header.
 *
 * Default state renders the name as a title with a subtle "click to edit"
 * affordance (hover ring + tiny pencil icon).  Clicking (or focusing via
 * keyboard) promotes the title to an input.  The save path hits
 * `PATCH /v1/templates/:id` and propagates the new name upward so the
 * parent can keep its own `tpl` state in sync.
 *
 * UX contract:
 *   - Enter commits; Escape reverts.
 *   - Blur commits, same as Enter.
 *   - Empty or whitespace-only value reverts (matches Drive's rename).
 *   - A 409 `name_conflict` surfaces inline, red, WITHOUT exiting edit mode
 *     so the user can tweak and try again.
 *   - While saving the input is disabled with a spinner-ish aria-busy state.
 *
 * Intentionally framework-thin — no modal, no confirm dialog.  Renaming
 * a template is cheap, reversible, and should feel as frictionless as
 * renaming a file in Finder/Explorer.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  renameTemplate,
  isNameConflict,
} from "@/lib/rename-template";
import { ApiError } from "@/lib/api";

export interface InlineRenameTitleProps {
  templateId: string;
  name: string;
  /** Called with the new name after the server confirms the rename. */
  onRenamed: (name: string) => void;
  /** Optional tailwind classes for the title text — keeps call sites able
   *  to match their existing header typography (e.g. text-sm font-semibold). */
  className?: string;
  /** Max width to clamp the title/input so long names don't push the header
   *  layout around. Defaults to a sane truncation width. */
  maxWidthClass?: string;
  /** Read-only mode: hides the pencil and disables click-to-edit. Useful
   *  when the current user doesn't own the template. Defaults to false. */
  readOnly?: boolean;
}

export function InlineRenameTitle({
  templateId,
  name,
  onRenamed,
  className,
  maxWidthClass = "max-w-[28ch]",
  readOnly = false,
}: InlineRenameTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Sync draft whenever the upstream name changes (e.g. from a server echo
  // or version restore). We only pull in the new value when NOT editing —
  // don't blow away mid-edit text just because the parent re-rendered.
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  // Autofocus + select-all on entering edit mode. useLayoutEffect avoids a
  // perceptible flicker between the title and the focused input.
  useLayoutEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  async function commit() {
    const next = draft.trim();
    if (next === "" || next === name) {
      // Empty or unchanged — revert silently.
      setDraft(name);
      setEditing(false);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await renameTemplate(templateId, next);
      onRenamed(r.name);
      setEditing(false);
    } catch (e) {
      if (isNameConflict(e)) {
        setError(
          "A template with this name already exists. Try another name.",
        );
      } else {
        setError((e as ApiError).message || "Couldn't rename template");
      }
      // Keep editing so the user can fix + retry.
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(name);
    setEditing(false);
    setError(null);
  }

  if (!editing) {
    return (
      <button
        type="button"
        disabled={readOnly}
        onClick={() => !readOnly && setEditing(true)}
        className={cn(
          "group inline-flex items-center gap-1.5 min-w-0 rounded-sm text-left",
          !readOnly &&
            "hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          readOnly && "cursor-default",
        )}
        title={readOnly ? name : `Rename "${name}"`}
      >
        <span
          className={cn(
            "truncate",
            maxWidthClass,
            className,
          )}
        >
          {name}
        </span>
        {!readOnly ? (
          <Pencil
            size={11}
            className="shrink-0 text-muted-foreground/0 transition group-hover:text-muted-foreground group-focus-visible:text-muted-foreground"
          />
        ) : null}
      </button>
    );
  }

  return (
    <div className="inline-flex min-w-0 flex-col">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        disabled={saving}
        aria-busy={saving}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onBlur={() => {
          // Don't fire blur-commit when the input lost focus because the
          // error cleared it. A simple saving guard is enough — if we're
          // mid-save, let the network resolve.
          if (!saving) void commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        className={cn(
          "truncate rounded-sm bg-background px-1.5 py-0.5 outline-none",
          "border",
          error ? "border-destructive ring-1 ring-destructive/40" : "border-input ring-1 ring-ring/30",
          maxWidthClass,
          className,
        )}
      />
      {error ? (
        <span className="mt-0.5 text-[10px] leading-tight text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
