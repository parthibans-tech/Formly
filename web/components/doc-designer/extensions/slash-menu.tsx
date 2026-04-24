"use client";

/**
 * Slash-menu extension — triggered by typing "/" at the start of a line
 * (or after whitespace).  Shows a popover of quick-insert commands:
 *
 *    /h1 /h2 /h3 /bullet /numbered /quote /divider /table
 *    /field /repeat /if
 *
 * The two-level design is deliberate: authors discover core WYSIWYG ops
 * via the toolbar, and discover data-bound ops (field/repeat/if) here.
 * Binding both to the same trigger means muscle memory carries — once an
 * author knows "/" opens commands, they'll try it before digging through
 * a menu.
 *
 * Implementation: TipTap's Suggestion plugin fires the trigger, calls the
 * passed-in render callbacks, and supplies the filtered item list.  We
 * render the popover ourselves via React portals so it can escape the
 * editor's overflow / transform contexts.
 */

import { Extension } from "@tiptap/core";
import { type Editor } from "@tiptap/react";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import { ReactRenderer } from "@tiptap/react";
import React, { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import "tippy.js/dist/tippy.css";

import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Minus,
  Table as TableIcon,
  Tag,
  Repeat2,
  GitBranch,
  type LucideIcon,
} from "lucide-react";

import { insertField, insertIf, insertRepeat } from "../editor";
import type { FieldRequest } from "../editor";

// ---------------------------------------------------------------------------
// Command catalog
// ---------------------------------------------------------------------------

interface SlashItem {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  keywords: string[];
  /** Run the command.  `range` is the slash-query range — the suggestion
   *  plugin passes us this so we can atomically delete the "/query" text
   *  before inserting the new content. */
  run: (ctx: { editor: Editor; range: { from: number; to: number }; onRequestField?: () => Promise<FieldRequest | null> }) => void | Promise<void>;
}

function chainWithDeletedRange(editor: Editor, range: { from: number; to: number }) {
  return editor.chain().focus().deleteRange(range);
}

const ITEMS: SlashItem[] = [
  {
    id: "h1",
    title: "Heading 1",
    description: "Big section title",
    icon: Heading1,
    keywords: ["heading", "h1", "title"],
    run: ({ editor, range }) =>
      chainWithDeletedRange(editor, range).setNode("heading", { level: 1 }).run(),
  },
  {
    id: "h2",
    title: "Heading 2",
    description: "Medium section title",
    icon: Heading2,
    keywords: ["heading", "h2"],
    run: ({ editor, range }) =>
      chainWithDeletedRange(editor, range).setNode("heading", { level: 2 }).run(),
  },
  {
    id: "h3",
    title: "Heading 3",
    description: "Small section title",
    icon: Heading3,
    keywords: ["heading", "h3"],
    run: ({ editor, range }) =>
      chainWithDeletedRange(editor, range).setNode("heading", { level: 3 }).run(),
  },
  {
    id: "bullet",
    title: "Bulleted list",
    description: "Unordered list",
    icon: List,
    keywords: ["list", "bullet", "ul"],
    run: ({ editor, range }) =>
      chainWithDeletedRange(editor, range).toggleBulletList().run(),
  },
  {
    id: "numbered",
    title: "Numbered list",
    description: "Ordered list",
    icon: ListOrdered,
    keywords: ["list", "numbered", "ol", "ordered"],
    run: ({ editor, range }) =>
      chainWithDeletedRange(editor, range).toggleOrderedList().run(),
  },
  {
    id: "quote",
    title: "Quote",
    description: "Blockquote",
    icon: Quote,
    keywords: ["quote", "blockquote"],
    run: ({ editor, range }) =>
      chainWithDeletedRange(editor, range).toggleBlockquote().run(),
  },
  {
    id: "divider",
    title: "Divider",
    description: "Horizontal rule",
    icon: Minus,
    keywords: ["divider", "hr", "rule", "separator"],
    run: ({ editor, range }) =>
      chainWithDeletedRange(editor, range).setHorizontalRule().run(),
  },
  {
    id: "table",
    title: "Table",
    description: "3×3 table with header row",
    icon: TableIcon,
    keywords: ["table", "grid"],
    run: ({ editor, range }) =>
      chainWithDeletedRange(editor, range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    id: "field",
    title: "Field",
    description: "Insert a data-bound value",
    icon: Tag,
    keywords: ["field", "variable", "data", "placeholder", "value"],
    run: async ({ editor, range, onRequestField }) => {
      // Remove the "/query" first so the picker popover doesn't sit over
      // residual slash text.  The editor ref stays valid across the await.
      chainWithDeletedRange(editor, range).run();
      const req = onRequestField
        ? await onRequestField()
        : window.prompt("Field path (e.g. 'invoice.total')")
          ? { path: String(window.prompt("Field path (e.g. 'invoice.total')") ?? "") }
          : null;
      if (req && req.path) insertField(editor, req);
    },
  },
  {
    id: "repeat",
    title: "Repeat",
    description: "Iterate over a list",
    icon: Repeat2,
    keywords: ["repeat", "loop", "foreach", "range", "each"],
    run: ({ editor, range }) => {
      chainWithDeletedRange(editor, range).run();
      const source = window.prompt("Repeat over which field? (e.g. 'lines')");
      if (!source) return;
      const as = window.prompt("Alias inside the loop (optional)") ?? "";
      insertRepeat(editor, { source, as });
    },
  },
  {
    id: "if",
    title: "If",
    description: "Conditional block",
    icon: GitBranch,
    keywords: ["if", "condition", "conditional", "when"],
    run: ({ editor, range }) => {
      chainWithDeletedRange(editor, range).run();
      const left = window.prompt("Condition path (e.g. 'invoice.total')");
      if (!left) return;
      const withElse = window.confirm("Include an else branch?");
      insertIf(editor, { left, op: "truthy", withElse });
    },
  },
];

// ---------------------------------------------------------------------------
// Popover list (React)
// ---------------------------------------------------------------------------

interface SlashListProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}

export interface SlashListHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

const SlashList = forwardRef<SlashListHandle, SlashListProps>(function SlashList(
  { items, command },
  ref,
) {
  const [selected, setSelected] = useState(0);

  // Reset highlight whenever the filtered list changes.
  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowUp") {
        setSelected((s) => (s + items.length - 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelected((s) => (s + 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "Enter") {
        const item = items[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (!items.length) {
    return (
      <div className="doc-slash-menu rounded-md border bg-popover text-popover-foreground shadow-md p-2 text-xs text-muted-foreground">
        No matches
      </div>
    );
  }

  return (
    <div
      role="listbox"
      className="doc-slash-menu rounded-md border bg-popover text-popover-foreground shadow-md min-w-[240px] max-h-[280px] overflow-auto p-1"
    >
      {items.map((item, i) => {
        const Icon = item.icon;
        const active = i === selected;
        return (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={active}
            onMouseEnter={() => setSelected(i)}
            onClick={() => command(item)}
            className={[
              "flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm",
              active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
            ].join(" ")}
          >
            <Icon size={14} className="mt-0.5 shrink-0 opacity-80" />
            <span className="flex flex-col">
              <span className="font-medium leading-tight">{item.title}</span>
              <span className="text-[11px] text-muted-foreground leading-tight">
                {item.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export interface SlashMenuOptions {
  /** Hook so the designer shell can supply its own field picker. */
  onRequestField?: () => Promise<FieldRequest | null>;
}

export function createSlashMenuExtension(opts: SlashMenuOptions = {}) {
  return Extension.create<SlashMenuOptions>({
    name: "slashMenu",
    addOptions() {
      return { onRequestField: opts.onRequestField };
    },
    addProseMirrorPlugins() {
      const extensionOptions = this.options;
      return [
        Suggestion({
          editor: this.editor,
          char: "/",
          allowSpaces: false,
          startOfLine: false,
          // Filter items by keyword match on the typed query.
          items: ({ query }: { query: string }) => {
            const q = query.trim().toLowerCase();
            if (!q) return ITEMS;
            return ITEMS.filter((it) =>
              [it.title, it.description, ...it.keywords]
                .join(" ")
                .toLowerCase()
                .includes(q),
            );
          },
          // Selection callback — runs when the user picks an item.
          command: ({ editor, range, props }) => {
            const item = props as SlashItem;
            item.run({
              editor,
              range,
              onRequestField: extensionOptions.onRequestField,
            });
          },
          // Render surface: wire a React component into a tippy popover.
          render: () => {
            let reactRenderer: ReactRenderer<SlashListHandle, SlashListProps> | null = null;
            let popup: TippyInstance | null = null;

            return {
              onStart: (props) => {
                reactRenderer = new ReactRenderer(SlashList, {
                  props: { items: props.items, command: props.command },
                  editor: props.editor,
                });
                const rect = props.clientRect?.();
                if (!rect) return;
                popup = tippy(document.body, {
                  getReferenceClientRect: () => rect,
                  appendTo: () => document.body,
                  content: reactRenderer.element,
                  showOnCreate: true,
                  interactive: true,
                  trigger: "manual",
                  placement: "bottom-start",
                  theme: "light-border",
                  arrow: false,
                  offset: [0, 6],
                });
              },
              onUpdate: (props) => {
                reactRenderer?.updateProps({
                  items: props.items,
                  command: props.command,
                });
                const rect = props.clientRect?.();
                if (popup && rect) {
                  popup.setProps({ getReferenceClientRect: () => rect });
                }
              },
              onKeyDown: (props) => {
                if (props.event.key === "Escape") {
                  popup?.hide();
                  return true;
                }
                return reactRenderer?.ref?.onKeyDown({ event: props.event }) ?? false;
              },
              onExit: () => {
                popup?.destroy();
                reactRenderer?.destroy();
                popup = null;
                reactRenderer = null;
              },
            };
          },
          // Populate the `props` the selection handler receives.
          // Suggestion sets `props` to the selected item automatically since
          // our items() result is an array of items.
        } as SuggestionOptions),
      ];
    },
  });
}
