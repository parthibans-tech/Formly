"use client";

// Notion-style block editor built on BlockNote. Client-only — BlockNote uses
// ProseMirror which can't SSR. The parent imports this via next/dynamic.

import * as React from "react";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { FileCode2, FileSignature, Hash, QrCode, ScrollText } from "lucide-react";

import {
  BlockNoteSchema,
  defaultBlockSpecs,
  filterSuggestionItems,
} from "@blocknote/core";
import {
  SuggestionMenuController,
  useCreateBlockNote,
  createReactBlockSpec,
  getDefaultReactSlashMenuItems,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

// Imperative handle exposed to the parent so it can read/write HTML.
export type BlockEditorRef = {
  toHTML: () => Promise<string>;
  loadFromHTML: (html: string) => Promise<void>;
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

const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...(defaultBlockSpecs as any),
    qrCode: QrCodeBlock(),
    barcode: BarcodeBlock(),
    signature: SignatureBlock(),
    pageBreak: PageBreakBlock(),
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

  // Seed with initial HTML on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!initialHTML) return;
      try {
        const blocks = await editor.tryParseHTMLToBlocks(initialHTML);
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
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emitChange = useCallback(async () => {
    if (!onChangeRef.current) return;
    const html = await editor.blocksToHTMLLossy(editor.document);
    onChangeRef.current(html);
  }, [editor]);

  useImperativeHandle(
    ref,
    () => ({
      toHTML: async () => editor.blocksToHTMLLossy(editor.document),
      loadFromHTML: async (html: string) => {
        const blocks = await editor.tryParseHTMLToBlocks(html);
        if (blocks.length > 0) editor.replaceBlocks(editor.document, blocks);
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
        subtext: "Insert {{ .field }}",
        icon: <FileCode2 className="h-4 w-4" />,
        aliases: ["placeholder", "field", "var", "variable"],
        group: "Template",
        onItemClick: () => {
          ed.insertInlineContent([
            { type: "text", text: "{{ .field }}", styles: {} },
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
