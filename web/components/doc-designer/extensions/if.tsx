"use client";

/**
 * If extension — a block-level container that renders one of two child
 * branches depending on a boolean condition.
 *
 * Shape on the page:
 *
 *   ┌ if (invoice.total > 100) ───────────────────────────┐
 *   │ [then branch — ProseMirror content hole]            │
 *   ├ else ────────────────────────────────────────────────┤
 *   │ [else branch — ProseMirror content hole, optional]  │
 *   └──────────────────────────────────────────────────────┘
 *
 * Implementation strategy: the "if" node has a fixed child sequence of
 * exactly one `ifBranch` followed by an optional `elseBranch`.  Both sub-
 * nodes accept `block+` content so authors can put anything structural
 * inside either side.  The schema `content` expression is the thing that
 * makes this bullet-proof — ProseMirror itself refuses to delete or splice
 * the fixed children out of order, so the editor never ends up in an
 * invalid state like "two then-branches" or "dangling else".
 *
 * The condition is stored as a JSON string on the `if` node's `condition`
 * attribute.  The converter (convert.ts) serializes/deserializes that to
 * the structured `Condition` object the AST uses.
 */

import { mergeAttributes, Node } from "@tiptap/core";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";
import React from "react";
import type { CondOp, Condition } from "@/lib/doc/ast";

// ---------------------------------------------------------------------------
// Attribute (de)serialization
// ---------------------------------------------------------------------------

export function parseCondition(s: string | undefined | null): Condition | undefined {
  if (!s) return undefined;
  try {
    const obj = JSON.parse(s) as Condition;
    if (!obj || typeof obj !== "object" || !obj.op) return undefined;
    return obj;
  } catch {
    return undefined;
  }
}

export function stringifyCondition(c: Condition | undefined): string | undefined {
  if (!c) return undefined;
  return JSON.stringify(c);
}

// ---------------------------------------------------------------------------
// Node extensions
// ---------------------------------------------------------------------------

/** The wrapping `if` node.  Children are strictly (ifBranch elseBranch?). */
export const IfExtension = Node.create({
  name: "if",
  group: "block",
  content: "ifBranch elseBranch?",
  defining: true,
  isolating: true,
  parseHTML() {
    return [{ tag: "div[data-formly-if]" }];
  },
  addAttributes() {
    return {
      // Stored as JSON string because ProseMirror attribute storage works
      // best with primitives.  The converter layer turns this into the
      // structured Condition the renderer expects.
      condition: { default: "" },
      id: { default: undefined },
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-formly-if": String(node.attrs.condition ?? ""),
      }),
      0,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(IfBlock);
  },
});

/** Then-branch.  Always present.  `block+` keeps at least one child so the
 *  editor can always place the caret inside. */
export const IfBranchExtension = Node.create({
  name: "ifBranch",
  group: "ifBranchGroup",     // keeps it out of top-level `block` slots
  content: "block+",
  defining: true,
  isolating: true,
  parseHTML() {
    return [{ tag: "div[data-formly-if-branch='then']" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-formly-if-branch": "then" }),
      0,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(BranchLabel("then"));
  },
});

/** Else-branch.  Optional; the schema allows the `if` to omit it entirely. */
export const ElseBranchExtension = Node.create({
  name: "elseBranch",
  group: "elseBranchGroup",
  content: "block+",
  defining: true,
  isolating: true,
  parseHTML() {
    return [{ tag: "div[data-formly-if-branch='else']" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-formly-if-branch": "else" }),
      0,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(BranchLabel("else"));
  },
});

/** Factory: builds a React view that draws a small "then" / "else" gutter
 *  label next to the branch's content hole. */
function BranchLabel(kind: "then" | "else") {
  const Component = (_props: ReactNodeViewProps) => (
    <NodeViewWrapper
      as="div"
      className="relative pl-10 border-l-2 border-amber-200 my-1"
      data-formly-if-branch={kind}
    >
      <span
        contentEditable={false}
        className="absolute left-0 top-1 text-[10px] uppercase tracking-wide font-semibold text-amber-700 select-none"
      >
        {kind}
      </span>
      <NodeViewContent className={`formly-if-${kind}`} />
    </NodeViewWrapper>
  );
  Component.displayName = `BranchLabel(${kind})`;
  return Component;
}

// ---------------------------------------------------------------------------
// React node views
// ---------------------------------------------------------------------------

const OP_LABELS: Record<CondOp, string> = {
  defined: "is defined",
  truthy: "is truthy",
  empty: "is empty",
  eq: "=",
  ne: "≠",
  gt: ">",
  ge: "≥",
  lt: "<",
  le: "≤",
};

const BINARY_OPS = new Set<CondOp>(["eq", "ne", "gt", "ge", "lt", "le"]);

/** The outer `if` view: condition editor pill + children (then + optional
 *  else) rendered via NodeViewContent.  We deliberately keep the branch
 *  separator outside of the ProseMirror content stream because doing so
 *  would require a third "separator" schema node; instead the branches
 *  self-label via their own node views below. */
function IfBlock(props: ReactNodeViewProps) {
  const condition = parseCondition(props.node.attrs.condition as string | undefined);
  const op: CondOp = condition?.op ?? "truthy";
  const left = condition?.left ?? "";
  const right = condition?.right;

  const update = (next: Condition) => {
    props.updateAttributes({ condition: stringifyCondition(next) });
  };

  const hasElse = props.node.childCount >= 2;

  const addElse = () => {
    const { editor, getPos } = props;
    if (!editor || typeof getPos !== "function") return;
    const pos = getPos();
    if (pos == null) return;
    const node = props.node;
    // Append an elseBranch with a seeded empty paragraph so the caret can
    // land inside it immediately.
    const schema = editor.schema;
    const elseType = schema.nodes.elseBranch;
    const paragraph = schema.nodes.paragraph;
    if (!elseType || !paragraph) return;
    const insertPos = pos + node.nodeSize - 1;
    editor
      .chain()
      .focus()
      .insertContentAt(insertPos, {
        type: "elseBranch",
        content: [{ type: "paragraph" }],
      })
      .run();
  };

  const removeElse = () => {
    const { editor, getPos } = props;
    if (!editor || typeof getPos !== "function") return;
    const pos = getPos();
    if (pos == null) return;
    const node = props.node;
    if (node.childCount < 2) return;
    // Find the elseBranch's start/end within the if node.
    const ifStart = pos + 1;
    const thenChild = node.firstChild;
    if (!thenChild) return;
    const elseStart = ifStart + thenChild.nodeSize;
    const elseEnd = elseStart + node.child(1).nodeSize;
    editor.chain().focus().deleteRange({ from: elseStart, to: elseEnd }).run();
  };

  return (
    <NodeViewWrapper
      as="div"
      className="my-3 rounded-lg border-2 border-dashed border-amber-300 bg-amber-50/30 px-3 py-2 relative"
      data-formly-if={stringifyCondition(condition) ?? ""}
    >
      {/* Condition editor.  Kept intentionally simple: path, op, optional
          literal.  Advanced users can still drop to the JSON view for more
          elaborate conditions — but 95% of conditions fit this shape. */}
      <div
        contentEditable={false}
        className="flex flex-wrap items-center gap-2 mb-2 text-[11px] uppercase tracking-wide text-amber-700"
      >
        <span className="font-semibold">If</span>
        <input
          value={left}
          onChange={(e) =>
            update({ op, left: e.target.value, right })
          }
          placeholder="path (e.g. invoice.total)"
          className="px-1.5 py-0.5 rounded border border-amber-200 bg-white text-amber-900 text-[11px] w-40 focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
        <select
          value={op}
          onChange={(e) =>
            update({ op: e.target.value as CondOp, left, right })
          }
          className="px-1.5 py-0.5 rounded border border-amber-200 bg-white text-amber-900 text-[11px] focus:outline-none focus:ring-1 focus:ring-amber-400"
        >
          {(Object.keys(OP_LABELS) as CondOp[]).map((k) => (
            <option key={k} value={k}>
              {OP_LABELS[k]}
            </option>
          ))}
        </select>
        {BINARY_OPS.has(op) ? (
          <input
            value={right == null ? "" : String(right)}
            onChange={(e) =>
              update({ op, left, right: e.target.value })
            }
            placeholder="value"
            className="px-1.5 py-0.5 rounded border border-amber-200 bg-white text-amber-900 text-[11px] w-28 focus:outline-none focus:ring-1 focus:ring-amber-400"
          />
        ) : null}
        <span className="flex-1" />
        {hasElse ? (
          <button
            type="button"
            onClick={removeElse}
            className="px-1.5 py-0.5 rounded border border-amber-200 bg-white text-amber-700 text-[10px] hover:bg-amber-50"
          >
            Remove else
          </button>
        ) : (
          <button
            type="button"
            onClick={addElse}
            className="px-1.5 py-0.5 rounded border border-amber-200 bg-white text-amber-700 text-[10px] hover:bg-amber-50"
          >
            + Add else
          </button>
        )}
      </div>
      {/* Children: ProseMirror renders the ifBranch (and optional
          elseBranch) into this hole.  Their own node views draw the "then"
          / "else" labels. */}
      <NodeViewContent className="formly-if-children" />
    </NodeViewWrapper>
  );
}
