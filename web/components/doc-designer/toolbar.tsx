"use client";

/**
 * Editor toolbar.  A thin strip of buttons above the TipTap surface that
 * drives the most-frequent operations — marks, block conversions, and
 * inserters for our custom nodes (field / repeat / if).
 *
 * We deliberately keep this component dumb: it receives the Editor via
 * ref/prop and calls its chainable commands.  No state of its own beyond
 * the "isActive" derivations, which are sourced from the editor's
 * reactive state via useEditorState.  That keeps the mental model small —
 * anything the toolbar can do, a slash menu or keyboard shortcut can do
 * equally via the same editor API.
 */

import React from "react";
import { type Editor, useEditorState } from "@tiptap/react";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Code,
  Link2,
  List,
  ListOrdered,
  Quote,
  Heading1,
  Heading2,
  Heading3,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Undo2,
  Redo2,
  Repeat2,
  GitBranch,
  Tag,
  Minus,
  Table as TableIcon,
} from "lucide-react";

import { insertField, insertIf, insertRepeat, type FieldRequest } from "./editor";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DocToolbarProps {
  editor: Editor | null;
  /** Called when the user presses the "field" button — the shell opens
   *  its picker (schema panel / modal) and resolves with the chosen path.
   *  Returning null cancels. */
  onRequestField?: () => Promise<FieldRequest | null>;
  /** Disable all controls (read-only view). */
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Reactive button helpers
// ---------------------------------------------------------------------------

/** Source-of-truth for which mark/node is currently active, refreshed
 *  on every editor transaction.  useEditorState batches derived reads
 *  into a single subscription so button re-renders stay cheap. */
function useToolbarState(editor: Editor | null) {
  return useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed) return null;
      return {
        bold: ed.isActive("bold"),
        italic: ed.isActive("italic"),
        underline: ed.isActive("underline"),
        strike: ed.isActive("strike"),
        code: ed.isActive("code"),
        link: ed.isActive("link"),
        bulletList: ed.isActive("bulletList"),
        orderedList: ed.isActive("orderedList"),
        blockquote: ed.isActive("blockquote"),
        h1: ed.isActive("heading", { level: 1 }),
        h2: ed.isActive("heading", { level: 2 }),
        h3: ed.isActive("heading", { level: 3 }),
        alignLeft: ed.isActive({ textAlign: "left" }),
        alignCenter: ed.isActive({ textAlign: "center" }),
        alignRight: ed.isActive({ textAlign: "right" }),
        canUndo: ed.can().chain().focus().undo().run(),
        canRedo: ed.can().chain().focus().redo().run(),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DocToolbar({
  editor,
  onRequestField,
  disabled,
}: DocToolbarProps) {
  const state = useToolbarState(editor);

  if (!editor || !state) {
    return (
      <div className="h-10 border-b bg-muted/30 animate-pulse" aria-hidden />
    );
  }

  const is = (k: keyof typeof state) => Boolean(state[k]);

  const promptRepeat = () => {
    const source = window.prompt("Repeat over which field? (e.g. 'lines')");
    if (!source) return;
    const as = window.prompt("Alias inside the loop (optional)") ?? "";
    insertRepeat(editor, { source, as });
  };

  const promptIf = () => {
    const left = window.prompt("Condition path (e.g. 'invoice.total')");
    if (!left) return;
    const withElse = window.confirm("Include an else branch?");
    insertIf(editor, { left, op: "truthy", withElse });
  };

  const pickField = async () => {
    if (onRequestField) {
      const req = await onRequestField();
      if (req) insertField(editor, req);
      return;
    }
    // Fallback: ask via a native prompt if the shell hasn't wired a picker.
    // Handy during early development; the designer shell replaces this.
    const path = window.prompt("Field path (e.g. 'invoice.total')");
    if (path) insertField(editor, { path });
  };

  const promptLink = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", previous ?? "");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: url })
      .run();
  };

  const insertTable = () => {
    editor
      .chain()
      .focus()
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run();
  };

  return (
    <div
      className={`flex flex-wrap items-center gap-0.5 border-b bg-muted/30 px-2 py-1 text-foreground ${
        disabled ? "opacity-50 pointer-events-none" : ""
      }`}
      role="toolbar"
      aria-label="Document formatting"
    >
      {/* Undo / redo */}
      <Btn
        title="Undo (⌘Z)"
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!is("canUndo")}
      >
        <Undo2 size={15} />
      </Btn>
      <Btn
        title="Redo (⇧⌘Z)"
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!is("canRedo")}
      >
        <Redo2 size={15} />
      </Btn>

      <Divider />

      {/* Headings */}
      <Btn
        title="Heading 1"
        active={is("h1")}
        onClick={() =>
          editor.chain().focus().toggleHeading({ level: 1 }).run()
        }
      >
        <Heading1 size={15} />
      </Btn>
      <Btn
        title="Heading 2"
        active={is("h2")}
        onClick={() =>
          editor.chain().focus().toggleHeading({ level: 2 }).run()
        }
      >
        <Heading2 size={15} />
      </Btn>
      <Btn
        title="Heading 3"
        active={is("h3")}
        onClick={() =>
          editor.chain().focus().toggleHeading({ level: 3 }).run()
        }
      >
        <Heading3 size={15} />
      </Btn>

      <Divider />

      {/* Marks */}
      <Btn
        title="Bold (⌘B)"
        active={is("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold size={15} />
      </Btn>
      <Btn
        title="Italic (⌘I)"
        active={is("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic size={15} />
      </Btn>
      <Btn
        title="Underline (⌘U)"
        active={is("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon size={15} />
      </Btn>
      <Btn
        title="Strikethrough"
        active={is("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough size={15} />
      </Btn>
      <Btn
        title="Inline code"
        active={is("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <Code size={15} />
      </Btn>
      <Btn title="Link" active={is("link")} onClick={promptLink}>
        <Link2 size={15} />
      </Btn>

      <Divider />

      {/* Alignment */}
      <Btn
        title="Align left"
        active={is("alignLeft")}
        onClick={() => editor.chain().focus().setTextAlign("left").run()}
      >
        <AlignLeft size={15} />
      </Btn>
      <Btn
        title="Align center"
        active={is("alignCenter")}
        onClick={() => editor.chain().focus().setTextAlign("center").run()}
      >
        <AlignCenter size={15} />
      </Btn>
      <Btn
        title="Align right"
        active={is("alignRight")}
        onClick={() => editor.chain().focus().setTextAlign("right").run()}
      >
        <AlignRight size={15} />
      </Btn>

      <Divider />

      {/* Blocks */}
      <Btn
        title="Bulleted list"
        active={is("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List size={15} />
      </Btn>
      <Btn
        title="Numbered list"
        active={is("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered size={15} />
      </Btn>
      <Btn
        title="Quote"
        active={is("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote size={15} />
      </Btn>
      <Btn
        title="Horizontal rule"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      >
        <Minus size={15} />
      </Btn>
      <Btn title="Insert table" onClick={insertTable}>
        <TableIcon size={15} />
      </Btn>

      <Divider />

      {/* Data-bound inserters — the key differentiators vs a plain WYSIWYG. */}
      <Btn title="Insert field (data placeholder)" onClick={pickField}>
        <Tag size={15} />
        <span className="ml-1 text-[11px] font-medium">Field</span>
      </Btn>
      <Btn title="Insert repeat block" onClick={promptRepeat}>
        <Repeat2 size={15} />
        <span className="ml-1 text-[11px] font-medium">Repeat</span>
      </Btn>
      <Btn title="Insert conditional block" onClick={promptIf}>
        <GitBranch size={15} />
        <span className="ml-1 text-[11px] font-medium">If</span>
      </Btn>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal bits
// ---------------------------------------------------------------------------

interface BtnProps {
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}

function Btn({ title, onClick, active, disabled, className, children }: BtnProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={[
        "inline-flex items-center h-7 px-1.5 rounded text-xs transition-colors",
        active
          ? "bg-foreground/10 text-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        disabled ? "opacity-40 cursor-not-allowed" : "",
        className ?? "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-border" aria-hidden />;
}
