"use client";

/**
 * Repeat extension — a block-level container that renders its children once
 * per item in a data array.
 *
 * Unlike Go templates' `{{ range }}`, this container holds its children
 * STRUCTURALLY in the ProseMirror document.  The author cannot split a loop
 * by moving paragraphs across its boundary — that's the entire point of the
 * refactor.
 *
 * Visual design: a dashed indigo frame with a header pill that shows the
 * source path and (optional) alias.  Children render inline inside the frame,
 * so editing feels natural — you type paragraphs, bullets, fields, all the
 * usual stuff, and they auto-belong to the loop.
 */

import { mergeAttributes, Node } from "@tiptap/core";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";
import React from "react";

export interface RepeatAttrs {
  source: string;
  as?: string;
}

export const RepeatExtension = Node.create({
  name: "repeat",
  group: "block",
  // Accept any block content so authors can put lists / tables / nested
  // repeats / ifs inside a loop.  `block+` requires at least one child —
  // we seed an empty paragraph on insertion.
  content: "block+",
  defining: true,       // treat the node as a boundary for parse/paste ops
  isolating: true,      // don't let structure ops collapse this into siblings
  parseHTML() {
    return [{ tag: "div[data-formly-repeat]" }];
  },
  addAttributes() {
    return {
      source: { default: "" },
      as: { default: "" },
      id: { default: undefined },
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-formly-repeat": node.attrs.source ?? "",
        ...(node.attrs.as ? { "data-formly-alias": node.attrs.as } : {}),
      }),
      0,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(RepeatBlock);
  },
});

// ---------------------------------------------------------------------------
// React node view
// ---------------------------------------------------------------------------

function RepeatBlock(props: ReactNodeViewProps) {
  const source = String(props.node.attrs.source ?? "");
  const alias = String(props.node.attrs.as ?? "");

  const updateAttr = (key: "source" | "as", value: string) => {
    props.updateAttributes({ [key]: value });
  };

  return (
    <NodeViewWrapper
      as="div"
      className="my-3 rounded-lg border-2 border-dashed border-indigo-300 bg-indigo-50/30 px-3 py-2 relative"
      data-formly-repeat={source}
    >
      {/* Header: editable source + alias so binding tweaks don't need the
          sidebar.  We deliberately use plain inputs (no slash menu, no popovers)
          — authors twiddle these fields rarely, and a native input is fastest. */}
      <div
        contentEditable={false}
        className="flex items-center gap-2 mb-2 text-[11px] uppercase tracking-wide text-indigo-700"
      >
        <span className="font-semibold">Repeat for each</span>
        <input
          value={source}
          onChange={(e) => updateAttr("source", e.target.value)}
          placeholder="e.g. lines"
          className="px-1.5 py-0.5 rounded border border-indigo-200 bg-white text-indigo-900 text-[11px] w-28 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
        <span>as</span>
        <input
          value={alias}
          onChange={(e) => updateAttr("as", e.target.value)}
          placeholder="(optional)"
          className="px-1.5 py-0.5 rounded border border-indigo-200 bg-white text-indigo-900 text-[11px] w-24 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
      </div>
      {/* Children render here — this is the ProseMirror-controlled content
          hole, NOT a React-rendered prop.  Anything inside is editable as
          normal document content. */}
      <NodeViewContent className="formly-repeat-content" />
    </NodeViewWrapper>
  );
}
