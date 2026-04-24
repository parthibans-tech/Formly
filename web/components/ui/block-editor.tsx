"use client";

// Notion-style block editor built on BlockNote. Client-only — BlockNote uses
// ProseMirror which can't SSR. The parent imports this via next/dynamic.

import * as React from "react";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { FileCode2, FileSignature, Hash, QrCode, ScrollText } from "lucide-react";

import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  filterSuggestionItems,
} from "@blocknote/core";
import {
  SuggestionMenuController,
  useCreateBlockNote,
  createReactBlockSpec,
  createReactInlineContentSpec,
  getDefaultReactSlashMenuItems,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

// Imperative handle exposed to the parent so it can read/write HTML.
export type BlockEditorRef = {
  toHTML: () => Promise<string>;
  loadFromHTML: (html: string) => Promise<void>;
  // Insert plain text at the cursor. Used by the Fields sidebar in the
  // HTML designer to drop `{{ .field }}` placeholders without forcing
  // the user into the HTML tab.
  insertText: (text: string) => void;
};

type Props = {
  initialHTML?: string;
  onChange?: (html: string) => void;
};

// -- Custom blocks ----------------------------------------------------------
//
// Each custom block renders a preview inside the editor and serializes back to
// a Go-template expression on export, so the backend substitution pipeline
// works unchanged. We cast the spec factories to `any` because the BlockNote
// generic inference is strict enough to trip TS; runtime behaviour is fine.

const makeSpec: any = createReactBlockSpec;

const QrCodeBlock = makeSpec(
  {
    type: "qrCode",
    propSchema: {
      path: { default: ".url" },
      size: { default: 180 },
    },
    content: "none",
  },
  {
    render: ({ block }: any) => {
      const path = String(block.props.path);
      const size = Number(block.props.size);
      return (
        <div
          contentEditable={false}
          className="formly-custom-block"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            border: "1px dashed #d4d4d8",
            borderRadius: 6,
            background: "rgba(16,185,129,.08)",
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            color: "rgb(4,120,87)",
          }}
        >
          QR code · {path} · {size}px
        </div>
      );
    },
    toExternalHTML: ({ block }: any) => {
      const p = document.createElement("p");
      p.textContent = `{{ qrcode ${block.props.path} ${block.props.size} }}`;
      return { dom: p };
    },
  }
);

const BarcodeBlock = makeSpec(
  {
    type: "barcode",
    propSchema: {
      path: { default: ".sku" },
      kind: { default: "code128" },
      width: { default: 300 },
      height: { default: 80 },
    },
    content: "none",
  },
  {
    render: ({ block }: any) => (
      <div
        contentEditable={false}
        className="formly-custom-block"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          border: "1px dashed #d4d4d8",
          borderRadius: 6,
          background: "rgba(245,158,11,.1)",
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          color: "rgb(146,64,14)",
        }}
      >
        Barcode · {String(block.props.kind)} · {String(block.props.path)} ·{" "}
        {String(block.props.width)}×{String(block.props.height)}
      </div>
    ),
    toExternalHTML: ({ block }: any) => {
      const p = document.createElement("p");
      p.textContent = `{{ barcode ${block.props.path} "${block.props.kind}" ${block.props.width} ${block.props.height} }}`;
      return { dom: p };
    },
  }
);

const SignatureBlock = makeSpec(
  {
    type: "signature",
    propSchema: {
      path: { default: ".signature.image" },
      name: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block }: any) => (
      <div
        contentEditable={false}
        className="formly-custom-block"
        style={{
          display: "inline-block",
          minWidth: 220,
          borderBottom: "1px solid #999",
          padding: "14px 0 4px",
          fontSize: 12,
          color: "#666",
          textAlign: "center",
        }}
      >
        Signature {String(block.props.name || "")}
      </div>
    ),
    toExternalHTML: ({ block }: any) => {
      const expr = block.props.name
        ? `{{ signature ${block.props.path} "${block.props.name}" }}`
        : `{{ signature ${block.props.path} }}`;
      const p = document.createElement("p");
      p.textContent = expr;
      return { dom: p };
    },
  }
);

const PageBreakBlock = makeSpec(
  {
    type: "pageBreak",
    propSchema: {},
    content: "none",
  },
  {
    render: () => (
      <div
        contentEditable={false}
        className="formly-custom-block"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "#888",
          fontSize: 11,
          padding: "12px 0",
          userSelect: "none",
        }}
      >
        <span style={{ flex: 1, borderTop: "1px dashed #bbb" }} />
        <span style={{ letterSpacing: ".1em", textTransform: "uppercase" }}>
          Page break
        </span>
        <span style={{ flex: 1, borderTop: "1px dashed #bbb" }} />
      </div>
    ),
    toExternalHTML: () => {
      const div = document.createElement("div");
      div.setAttribute("style", "page-break-after: always;");
      return { dom: div };
    },
  }
);

// -- Placeholder chip (inline content) --------------------------------------
//
// This is THE change that makes the editor approachable for non-technical
// users. Every Go-template expression — `{{ .merchant.name }}`,
// `{{ range .lines }}`, `{{ .paidAt | formatDate "…" }}` — renders as a
// coloured pill with a friendly label (e.g. "Merchant › Name") instead of
// raw mustache syntax. The original expression text is preserved in a prop
// and serialized back out verbatim, so the server template pipeline is
// unchanged.

type ExprKind = "field" | "helper" | "logic";

function titleCase(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function friendlyPathLabel(path: string): string {
  return path.split(".").map(titleCase).join(" › ");
}

function logicLabel(inner: string): string {
  const [kw, ...rest] = inner.split(/\s+/);
  const arg = rest.join(" ").trim();
  const dot = arg.match(/^\.([\w.]+)/);
  const pretty = dot ? friendlyPathLabel(dot[1]) : arg;
  switch (kw) {
    case "if":
      return pretty ? `If ${pretty}` : "If";
    case "else":
      return "Otherwise";
    case "end":
      return "End";
    case "range":
      return pretty ? `Repeat for each ${pretty}` : "Repeat";
    case "with":
      return pretty ? `With ${pretty}` : "With";
    default:
      return inner;
  }
}

// classifyExpr extracts kind/label/expr from a raw `{{ … }}` snippet.
function classifyExpr(expr: string): {
  kind: ExprKind;
  label: string;
  expr: string;
} {
  const trimmed = expr.trim();
  const inner = trimmed
    .replace(/^\{\{\s*-?\s*/, "")
    .replace(/\s*-?\s*\}\}$/, "")
    .trim();

  // Control flow keywords → logic chip
  if (/^(if|else|end|range|with|define|template|block|break|continue)\b/.test(inner)) {
    return { kind: "logic", label: logicLabel(inner), expr: trimmed };
  }

  // Pure field reference (with optional pipe filters): .path, .a.b | fmt …
  const fieldMatch = inner.match(/^\.([\w.]+)/);
  if (fieldMatch) {
    return {
      kind: "field",
      label: friendlyPathLabel(fieldMatch[1]),
      expr: trimmed,
    };
  }

  // Helper invocation: `helperName .arg1 "x" …`
  const helperMatch = inner.match(/^(\w+)(?:\s|$)/);
  if (helperMatch) {
    return { kind: "helper", label: helperMatch[1], expr: trimmed };
  }

  return { kind: "logic", label: inner, expr: trimmed };
}

// preprocessTemplateHTML walks text nodes and wraps every `{{ … }}` run in
// `<span data-formly-expr="…">…</span>` so BlockNote's parser can match them
// against our Placeholder inline-content spec. Attribute values (e.g.
// `href="{{ .url }}"`) are left untouched because we only rewrite text nodes.
function preprocessTemplateHTML(html: string): string {
  if (!html || !html.includes("{{")) return html;
  if (typeof window === "undefined") return html;
  const doc = new DOMParser().parseFromString(
    `<div id="__formly_root__">${html}</div>`,
    "text/html"
  );
  const root = doc.getElementById("__formly_root__");
  if (!root) return html;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  const re = /\{\{[^{}]*\}\}/g;
  for (const text of nodes) {
    const data = text.data;
    if (!data.includes("{{")) continue;
    const matches: { start: number; end: number; expr: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(data))) {
      matches.push({ start: m.index, end: m.index + m[0].length, expr: m[0] });
    }
    re.lastIndex = 0;
    if (!matches.length) continue;
    const frag = doc.createDocumentFragment();
    let cursor = 0;
    for (const hit of matches) {
      if (hit.start > cursor) {
        frag.appendChild(doc.createTextNode(data.slice(cursor, hit.start)));
      }
      const { kind, label } = classifyExpr(hit.expr);
      const span = doc.createElement("span");
      span.setAttribute("data-formly-expr", hit.expr);
      span.setAttribute("data-formly-kind", kind);
      span.setAttribute("data-formly-label", label);
      span.textContent = hit.expr;
      frag.appendChild(span);
      cursor = hit.end;
    }
    if (cursor < data.length) {
      frag.appendChild(doc.createTextNode(data.slice(cursor)));
    }
    text.parentNode?.replaceChild(frag, text);
  }
  return root.innerHTML;
}

const CHIP_PALETTE: Record<ExprKind, React.CSSProperties> = {
  field: {
    background: "rgb(219 234 254)", // sky-100
    color: "rgb(29 78 216)", // blue-700
    borderColor: "rgb(147 197 253)", // blue-300
  },
  helper: {
    background: "rgb(237 233 254)", // violet-100
    color: "rgb(91 33 182)", // violet-800
    borderColor: "rgb(196 181 253)", // violet-300
  },
  logic: {
    background: "rgb(244 244 245)", // zinc-100
    color: "rgb(63 63 70)", // zinc-700
    borderColor: "rgb(212 212 216)", // zinc-300
  },
};

const makeInline: any = createReactInlineContentSpec;

const PlaceholderChip = makeInline(
  {
    type: "placeholder",
    propSchema: {
      expr: { default: "" },
      label: { default: "" },
      kind: { default: "field" },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }: any) => {
      const kind = (inlineContent.props.kind as ExprKind) || "field";
      const label =
        String(inlineContent.props.label || "") ||
        String(inlineContent.props.expr || "");
      return (
        <span
          contentEditable={false}
          title={String(inlineContent.props.expr || "")}
          style={{
            display: "inline-block",
            padding: "0 6px",
            margin: "0 1px",
            borderRadius: 4,
            border: "1px solid",
            fontSize: "0.85em",
            fontWeight: 500,
            lineHeight: 1.5,
            verticalAlign: "baseline",
            whiteSpace: "nowrap",
            userSelect: "none",
            cursor: "default",
            ...CHIP_PALETTE[kind],
          }}
          data-formly-chip={kind}
        >
          {label}
        </span>
      );
    },
    parse: (element: HTMLElement) => {
      if (element.tagName.toLowerCase() !== "span") return undefined;
      const expr = element.getAttribute("data-formly-expr");
      if (!expr) return undefined;
      return {
        expr,
        label: element.getAttribute("data-formly-label") || expr,
        kind: (element.getAttribute("data-formly-kind") as ExprKind) || "field",
      };
    },
    // On export, emit a span that carries the original expression as its text
    // content. The span is invisible in the rendered PDF (no styling), and
    // Go's html/template processes the `{{ … }}` inside it identically to
    // bare text.
    toExternalHTML: ({ inlineContent }: any) => (
      <span>{String(inlineContent.props.expr || "")}</span>
    ),
  }
);

const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...(defaultBlockSpecs as any),
    qrCode: QrCodeBlock(),
    barcode: BarcodeBlock(),
    signature: SignatureBlock(),
    pageBreak: PageBreakBlock(),
  },
  inlineContentSpecs: {
    ...(defaultInlineContentSpecs as any),
    placeholder: PlaceholderChip,
  },
}) as any;

// -- Component --------------------------------------------------------------

function BlockEditorInner(
  { initialHTML = "", onChange }: Props,
  ref: React.Ref<BlockEditorRef>
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor: any = useCreateBlockNote({
    schema,
    initialContent: [{ type: "paragraph" }],
  } as any);

  const [isDark, setIsDark] = React.useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const check = () => setIsDark(root.classList.contains("dark"));
    check();
    const observer = new MutationObserver(check);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // Suppress the onChange that fires immediately after the initial parse +
  // replaceBlocks — the content hasn't actually changed from the user's
  // perspective, and we don't want the chip round-trip to mutate the
  // persisted source on first open.
  const isInitialLoad = useRef(true);

  // Seed with initial HTML on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!initialHTML) {
        isInitialLoad.current = false;
        return;
      }
      try {
        const blocks = await editor.tryParseHTMLToBlocks(
          preprocessTemplateHTML(initialHTML)
        );
        if (cancelled) return;
        if (blocks.length > 0) editor.replaceBlocks(editor.document, blocks);
      } catch {
        editor.replaceBlocks(editor.document, [
          {
            type: "paragraph",
            content: [{ type: "text", text: initialHTML, styles: {} }],
          },
        ] as any);
      }
      // Let BlockNote's onChange fire once (from replaceBlocks) before we
      // start forwarding edits upstream.
      queueMicrotask(() => {
        isInitialLoad.current = false;
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emitChange = useCallback(async () => {
    if (isInitialLoad.current) return;
    if (!onChangeRef.current) return;
    const html = await editor.blocksToHTMLLossy(editor.document);
    onChangeRef.current(html);
  }, [editor]);

  useImperativeHandle(
    ref,
    () => ({
      toHTML: async () => editor.blocksToHTMLLossy(editor.document),
      loadFromHTML: async (html: string) => {
        const blocks = await editor.tryParseHTMLToBlocks(
          preprocessTemplateHTML(html)
        );
        if (blocks.length > 0) editor.replaceBlocks(editor.document, blocks);
      },
      insertText: (text: string) => {
        // If the sidebar / command palette handed us a `{{ … }}` expression,
        // drop it in as a proper Placeholder chip so the user sees a friendly
        // pill instead of raw mustache text. Plain text still takes the
        // normal path.
        const trimmed = text.trim();
        const isTemplate =
          trimmed.startsWith("{{") && trimmed.endsWith("}}");
        try {
          if (isTemplate) {
            const info = classifyExpr(trimmed);
            editor.insertInlineContent([
              {
                type: "placeholder",
                props: {
                  expr: info.expr,
                  label: info.label,
                  kind: info.kind,
                },
              },
              // Trailing space so the cursor lands after the chip and the
              // user can continue typing without the chip absorbing input.
              { type: "text", text: " ", styles: {} },
            ] as any);
            return;
          }
          editor.insertInlineContent([
            { type: "text", text, styles: {} },
          ] as any);
        } catch {
          // Fallback: append a paragraph when no cursor is available.
          editor.insertBlocks(
            [
              {
                type: "paragraph",
                content: [{ type: "text", text, styles: {} }],
              },
            ] as any,
            editor.getTextCursorPosition?.()?.block ?? editor.document[0],
            "after"
          );
        }
      },
    }),
    [editor]
  );

  // Slash-menu additions for our custom blocks.
  const getCustomSlashItems = useMemo(
    () => (ed: any) => [
      {
        title: "QR code",
        subtext: "{{ qrcode .url 200 }}",
        icon: <QrCode className="h-4 w-4" />,
        aliases: ["qr", "code", "qrcode"],
        group: "Media",
        onItemClick: () => {
          ed.insertBlocks(
            [
              {
                type: "qrCode",
                props: { path: ".url", size: 180 },
              },
            ] as any,
            ed.getTextCursorPosition().block,
            "after"
          );
        },
      },
      {
        title: "Barcode",
        subtext: '{{ barcode .sku "code128" }}',
        icon: <Hash className="h-4 w-4" />,
        aliases: ["barcode", "bar", "ean", "code128"],
        group: "Media",
        onItemClick: () => {
          ed.insertBlocks(
            [
              {
                type: "barcode",
                props: {
                  path: ".sku",
                  kind: "code128",
                  width: 300,
                  height: 80,
                },
              },
            ] as any,
            ed.getTextCursorPosition().block,
            "after"
          );
        },
      },
      {
        title: "Signature",
        subtext: "{{ signature .signature.image }}",
        icon: <FileSignature className="h-4 w-4" />,
        aliases: ["sign", "signature", "sig"],
        group: "Media",
        onItemClick: () => {
          ed.insertBlocks(
            [
              {
                type: "signature",
                props: { path: ".signature.image", name: "" },
              },
            ] as any,
            ed.getTextCursorPosition().block,
            "after"
          );
        },
      },
      {
        title: "Page break",
        subtext: "Force a new page in the PDF",
        icon: <ScrollText className="h-4 w-4" />,
        aliases: ["page", "break", "pagebreak", "pb"],
        group: "Layout",
        onItemClick: () => {
          ed.insertBlocks(
            [{ type: "pageBreak" }] as any,
            ed.getTextCursorPosition().block,
            "after"
          );
        },
      },
      {
        title: "Placeholder",
        subtext: "Insert a data field chip",
        icon: <FileCode2 className="h-4 w-4" />,
        aliases: ["placeholder", "field", "var", "variable"],
        group: "Template",
        onItemClick: () => {
          ed.insertInlineContent([
            {
              type: "placeholder",
              props: {
                expr: "{{ .field }}",
                label: "Field",
                kind: "field",
              },
            },
            { type: "text", text: " ", styles: {} },
          ] as any);
        },
      },
    ],
    []
  );

  return (
    <div className="h-full w-full overflow-y-auto" data-formly-block-editor>
      <BlockNoteView
        editor={editor}
        theme={isDark ? "dark" : "light"}
        slashMenu={false}
        onChange={emitChange}
      >
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                ...getDefaultReactSlashMenuItems(editor),
                ...getCustomSlashItems(editor),
              ] as any,
              query
            )
          }
        />
      </BlockNoteView>
    </div>
  );
}

export const BlockEditor = React.forwardRef(BlockEditorInner);
