"use client";

/**
 * DocEditor — the rich-text surface for doc-mode templates.
 *
 * Wraps TipTap with our custom Field/Repeat/If extensions and exposes the
 * minimum surface the designer shell cares about:
 *
 *   <DocEditor value={doc} onChange={setDoc} />
 *
 * `value` is a Doc (AST).  The editor converts it to TipTap JSON on mount
 * and converts back on every transaction.  The conversion is cheap enough
 * (O(node count), no string parsing) that we don't bother debouncing —
 * the AST is the single source of truth, and downstream consumers
 * (preview, save, schema panel) always see the latest shape.
 */

import React, { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Underline } from "@tiptap/extension-underline";
import { Link } from "@tiptap/extension-link";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { Image } from "@tiptap/extension-image";

import type { Doc, FieldFormat } from "@/lib/doc/ast";
import { FieldExtension, stringifyFormat } from "./extensions/field";
import { RepeatExtension } from "./extensions/repeat";
import {
  ElseBranchExtension,
  IfBranchExtension,
  IfExtension,
  stringifyCondition,
} from "./extensions/if";
import { createSlashMenuExtension } from "./extensions/slash-menu";
import { docToTipTap, tipTapToDoc } from "./convert";

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export interface DocEditorProps {
  value: Doc;
  onChange: (doc: Doc) => void;
  /** Optional data-fields list for the (future) slash menu / picker. */
  availableFields?: string[];
  /** Disable editing (read-only preview mode). */
  readOnly?: boolean;
  /** Optional handler fired when the user requests the field picker.
   *  The shell wires this to the schema panel / modal. */
  onPickField?: () => Promise<FieldRequest | null>;
  /** Ref to the underlying TipTap editor, for imperative ops (insert field,
   *  apply mark, etc).  Parent components compose toolbars / menus via this. */
  editorRef?: React.MutableRefObject<Editor | null>;
}

export interface FieldRequest {
  path: string;
  format?: FieldFormat;
  default?: string;
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export function DocEditor({
  value,
  onChange,
  readOnly,
  editorRef,
  onPickField,
}: DocEditorProps) {
  // Memoize the extension list so the editor isn't torn down on every render.
  //
  // NB: `onPickField` is captured into the slash-menu extension on mount. If
  // the caller swaps the picker impl mid-session we'd need to reinstate the
  // editor — not a concern today because the picker is a stable module-scope
  // function on the designer shell.
  const extensions = useMemo(
    () => [
      StarterKit.configure({
        // StarterKit already ships HorizontalRule + History; keep both.
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      TextStyle,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Image,
      FieldExtension,
      RepeatExtension,
      IfExtension,
      IfBranchExtension,
      ElseBranchExtension,
      createSlashMenuExtension({ onRequestField: onPickField }),
    ],
    // Intentionally do not depend on onPickField — see note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // We only want to seed TipTap's document once — later updates to `value`
  // coming from outside (e.g. a remote save landing) are reconciled via the
  // explicit sync effect below.  Seeding on every render would fight the
  // user's cursor on every keystroke.
  const seededRef = useRef(false);
  const initialDoc = useMemo(() => docToTipTap(value), [value]);

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions,
      content: initialDoc,
      editable: !readOnly,
      editorProps: {
        attributes: {
          class:
            "doc-editor prose prose-sm max-w-none focus:outline-none min-h-[60vh] px-6 py-8",
        },
      },
      onUpdate: ({ editor: ed }) => {
        // Convert once per transaction.  We feed the raw JSON through our
        // converter rather than reading from TipTap's schema types, because
        // the converter is the single canonical boundary — if the two ever
        // disagree, debugging is nightmarish.
        const json = ed.getJSON() as Parameters<typeof tipTapToDoc>[0];
        onChange(tipTapToDoc(json));
      },
    },
    // Extensions/readOnly captured via closure; no-deps is fine because
    // we memoized them above.  If readOnly flips, we call setEditable in an
    // effect below.
    [],
  );

  // Expose the editor to the parent via ref, so toolbars can drive it.
  useEffect(() => {
    if (editorRef) editorRef.current = editor ?? null;
    return () => {
      if (editorRef) editorRef.current = null;
    };
  }, [editor, editorRef]);

  // Handle external `value` replacements (load-from-server, template switch).
  // We only resync when the *identity* of `value` changes and the doc is
  // materially different — a naive deep-equals on every keystroke would
  // reset the selection.  A cheap heuristic: compare stringified roots.
  useEffect(() => {
    if (!editor) return;
    if (!seededRef.current) {
      // First mount: useEditor's `content` already seeded it.
      seededRef.current = true;
      return;
    }
    const nextJson = docToTipTap(value);
    const currentJson = editor.getJSON();
    if (JSON.stringify(nextJson) === JSON.stringify(currentJson)) return;
    editor.commands.setContent(nextJson, { emitUpdate: false });
  }, [editor, value]);

  // React to readOnly flips without recreating the editor.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  if (!editor) {
    // Brief mount tick; render an empty shell with the same min-height so
    // the layout doesn't jump.
    return <div className="doc-editor min-h-[60vh] px-6 py-8" />;
  }

  return <EditorContent editor={editor} className="doc-editor-root" />;
}

// ---------------------------------------------------------------------------
// Imperative helpers — used by toolbars / slash menus
// ---------------------------------------------------------------------------

export function insertField(editor: Editor, req: FieldRequest): void {
  editor
    .chain()
    .focus()
    .insertContent({
      type: "field",
      attrs: {
        path: req.path,
        format: stringifyFormat(req.format),
        default: req.default,
      },
    })
    .run();
}

export function insertRepeat(
  editor: Editor,
  opts: { source: string; as?: string },
): void {
  editor
    .chain()
    .focus()
    .insertContent({
      type: "repeat",
      attrs: { source: opts.source, as: opts.as ?? "" },
      content: [{ type: "paragraph" }],
    })
    .run();
}

export function insertIf(
  editor: Editor,
  opts: { left: string; op?: string; right?: string; withElse?: boolean },
): void {
  const condition = stringifyCondition({
    op: (opts.op as never) ?? "truthy",
    left: opts.left,
    right: opts.right,
  });
  const content: Array<{ type: string; content: Array<{ type: string }> }> = [
    { type: "ifBranch", content: [{ type: "paragraph" }] },
  ];
  if (opts.withElse) {
    content.push({ type: "elseBranch", content: [{ type: "paragraph" }] });
  }
  editor
    .chain()
    .focus()
    .insertContent({
      type: "if",
      attrs: { condition },
      content,
    })
    .run();
}
