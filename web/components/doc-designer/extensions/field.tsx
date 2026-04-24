"use client";

/**
 * Field extension — an inline atom (zero width, non-editable) that stands in
 * for a data-bound value in the document.  Looks like a colored pill inside
 * flowing text; clicking opens a picker (wired by the editor shell via
 * the `onEdit` attribute callback).
 *
 * Why an atom? A field has NO editable child content — the author doesn't
 * type into it.  The path + format are attributes.  Atoms are the ProseMirror
 * way to express that: selectable as a unit, deleted as a unit, can never
 * be partially selected or split.
 */

import { mergeAttributes, Node } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";
import React from "react";
import type { FieldFormat } from "@/lib/doc/ast";

// ---------------------------------------------------------------------------
// Attribute shape
// ---------------------------------------------------------------------------

export interface FieldAttrs {
  path: string;
  /** Serialized JSON — ProseMirror attribute storage prefers primitives. The
   *  converter parses/stringifies on the way in and out. */
  format?: string;
  default?: string;
}

export function parseFormat(s: string | undefined | null): FieldFormat | undefined {
  if (!s) return undefined;
  try {
    const obj = JSON.parse(s) as FieldFormat;
    return obj;
  } catch {
    return undefined;
  }
}

export function stringifyFormat(f: FieldFormat | undefined): string | undefined {
  if (!f) return undefined;
  return JSON.stringify(f);
}

// ---------------------------------------------------------------------------
// Node extension
// ---------------------------------------------------------------------------

export const FieldExtension = Node.create({
  name: "field",
  group: "inline",
  inline: true,
  atom: true,          // indivisible — selected/deleted as one
  selectable: true,
  // Provide HTML parsing so pasting an already-rendered field span preserves
  // the binding instead of dropping back to plain text.  The `data-formly-field`
  // attribute is emitted by the server renderer, making round-trips consistent.
  parseHTML() {
    return [
      {
        tag: "span[data-formly-field]",
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          return {
            path: el.getAttribute("data-formly-field") ?? "",
            format: el.getAttribute("data-formly-format") ?? undefined,
            default: el.getAttribute("data-formly-default") ?? undefined,
          };
        },
      },
    ];
  },
  addAttributes() {
    return {
      path: { default: "" },
      format: { default: undefined },
      default: { default: undefined },
    };
  },
  // renderHTML only fires for the read-only export path (copy/paste,
  // toExternalHTML).  The interactive editor uses the React node view.
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(
        {
          "data-formly-field": HTMLAttributes.path,
          ...(HTMLAttributes.format ? { "data-formly-format": HTMLAttributes.format } : {}),
          ...(HTMLAttributes.default ? { "data-formly-default": HTMLAttributes.default } : {}),
          class: "formly-field-chip",
        },
      ),
      // Human-friendly label as fallback text; the live preview replaces this.
      friendlyLabel(HTMLAttributes.path ?? ""),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(FieldChip);
  },
});

// ---------------------------------------------------------------------------
// React node view
// ---------------------------------------------------------------------------

function FieldChip(props: ReactNodeViewProps) {
  const { node, selected } = props;
  const path = String(node.attrs.path ?? "");
  const fmt = parseFormat(node.attrs.format as string | undefined);
  const kind = fmt?.kind ?? "text";
  const label = friendlyLabel(path);
  const fmtHint = formatHint(fmt);

  // Atom node view: contentEditable=false on the wrapper so the cursor can't
  // enter the pill. ProseMirror still treats selection / deletion correctly
  // because we're using NodeViewWrapper as the outer element.
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className={[
        "inline-flex items-center gap-1 align-baseline px-1.5 py-0.5 mx-0.5 rounded text-[12px] font-medium select-none",
        palette(kind),
        selected ? "ring-2 ring-offset-1 ring-sky-400" : "",
      ].join(" ")}
      data-formly-field={path}
      data-formly-kind={kind}
      title={path + (fmtHint ? ` · ${fmtHint}` : "")}
    >
      <span className="truncate max-w-[200px]">{label || "(unnamed)"}</span>
      {fmtHint ? (
        <span className="opacity-60 text-[10px] font-normal">· {fmtHint}</span>
      ) : null}
    </NodeViewWrapper>
  );
}

// ---------------------------------------------------------------------------
// Chip styling + friendly labels
// ---------------------------------------------------------------------------

/** Per-format-kind color palette — sky/blue for plain text, emerald for
 *  currency, amber for number/percent, violet for date. Keeps the chips
 *  glanceable so authors see at-a-glance what kind of value renders. */
function palette(kind: string): string {
  switch (kind) {
    case "currency":
      return "bg-emerald-100 text-emerald-800 border border-emerald-200";
    case "number":
    case "percent":
      return "bg-amber-100 text-amber-800 border border-amber-200";
    case "date":
      return "bg-violet-100 text-violet-800 border border-violet-200";
    default:
      return "bg-sky-100 text-blue-700 border border-sky-200";
  }
}

/** Convert a.dotted.path into a more readable "A › Dotted › Path".  Used for
 *  pill labels so authors see semantic names, not raw paths.  Power users
 *  can still hover to see the exact path in the tooltip. */
export function friendlyLabel(path: string): string {
  const clean = path.replace(/^\./, "").trim();
  if (!clean) return "";
  return clean
    .split(".")
    .map(titleCase)
    .join(" › ");
}

function titleCase(s: string): string {
  return s.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatHint(f: FieldFormat | undefined): string {
  if (!f) return "";
  switch (f.kind) {
    case "currency":
      return f.code || "currency";
    case "number":
      return `${f.decimals ?? 0} dp`;
    case "percent":
      return `${f.decimals ?? 0}%`;
    case "date":
      return f.pattern || "date";
    case "text":
    default:
      return "";
  }
}
