"use client";

import * as React from "react";
import dynamic from "next/dynamic";

const Editor: any = dynamic(
  () =>
    import("@tinymce/tinymce-react").then(
      (m) => m.Editor as unknown as React.ComponentType<any>
    ),
  { ssr: false }
);

type Props = {
  value: string;
  onChange: (v: string) => void;
  placeholders?: string[];
  height?: number | string;
};

const MEDIA_SNIPPETS: Array<{
  key: string;
  label: string;
  description: string;
  html: string;
}> = [
  {
    key: "qrcode",
    label: "QR code",
    description: '{{ qrcode .url 200 }}',
    html: '<p>{{ qrcode .url 200 }}</p>',
  },
  {
    key: "barcode",
    label: "Barcode (Code 128)",
    description: '{{ barcode .sku "code128" 300 80 }}',
    html: '<p>{{ barcode .sku "code128" 300 80 }}</p>',
  },
  {
    key: "barcode-ean13",
    label: "Barcode (EAN-13)",
    description: '{{ barcode .ean "ean13" 260 80 }}',
    html: '<p>{{ barcode .ean "ean13" 260 80 }}</p>',
  },
  {
    key: "signature",
    label: "Signature image",
    description: '{{ signature .signature.image "Jane Doe" }}',
    html: '<p>{{ signature .signature.image "Jane Doe" }}</p>',
  },
  {
    key: "signature-line",
    label: "Signature line (manual)",
    description: "Signed ____________",
    html:
      '<div style="display:flex; gap:40px; margin-top:40px;">' +
      '<div style="flex:1; border-top:1px solid #111; padding-top:4px; font-size:12px;">Signature</div>' +
      '<div style="flex:1; border-top:1px solid #111; padding-top:4px; font-size:12px;">Date</div>' +
      '</div>',
  },
  {
    key: "image",
    label: "Image (URL)",
    description: '{{ image .photo.url "alt text" }}',
    html: '<p>{{ image .photo.url "alt text" }}</p>',
  },
  {
    key: "chart-line",
    label: "Chart (line)",
    description: '{{ chart .series "line" 480 280 }}',
    html: '<p>{{ chart .series "line" 480 280 }}</p>',
  },
  {
    key: "chart-bar",
    label: "Chart (bar)",
    description: '{{ chart .series "bar" 480 280 }}',
    html: '<p>{{ chart .series "bar" 480 280 }}</p>',
  },
  {
    key: "chart-pie",
    label: "Chart (pie / donut)",
    description: '{{ chart .breakdown "doughnut" 360 280 }}',
    html: '<p>{{ chart .breakdown "doughnut" 360 280 }}</p>',
  },
];

const BLOCK_SNIPPETS: Array<{
  key: string;
  label: string;
  description: string;
  html: string;
}> = [
  {
    key: "if",
    label: "If condition",
    description: "{{ if .field }}…{{ end }}",
    html:
      '<p>{{ if .condition }}</p><p>Shown when true</p><p>{{ end }}</p>',
  },
  {
    key: "ifelse",
    label: "If / else",
    description: "{{ if .field }}…{{ else }}…{{ end }}",
    html:
      '<p>{{ if .condition }}</p><p>Shown when true</p><p>{{ else }}</p><p>Shown when false</p><p>{{ end }}</p>',
  },
  {
    key: "range",
    label: "Range (loop)",
    description: "{{ range .items }}…{{ end }}",
    html:
      '<ul>\n<li>{{ range .items }}{{ .name }}{{ end }}</li>\n</ul>',
  },
  {
    key: "with",
    label: "With (scope)",
    description: "{{ with .object }}…{{ end }}",
    html:
      '<p>{{ with .customer }}</p><p>{{ .name }}</p><p>{{ end }}</p>',
  },
];

export function RichEditor({ value, onChange, placeholders = [], height = "100%" }: Props) {
  const [isDark, setIsDark] = React.useState(false);

  React.useEffect(() => {
    const root = document.documentElement;
    const check = () => setIsDark(root.classList.contains("dark"));
    check();
    const observer = new MutationObserver(check);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return (
    <Editor
      tinymceScriptSrc="/tinymce/tinymce.min.js"
      licenseKey="gpl"
      value={value}
      onEditorChange={(v: string) => onChange(v)}
      init={{
        height,
        menubar: "file edit view insert format tools table",
        plugins: [
          "advlist",
          "autolink",
          "lists",
          "link",
          "image",
          "charmap",
          "preview",
          "anchor",
          "searchreplace",
          "visualblocks",
          "code",
          "fullscreen",
          "insertdatetime",
          "media",
          "table",
          "help",
          "wordcount",
          "codesample",
          "emoticons",
        ],
        toolbar:
          "undo redo | blocks | bold italic underline strikethrough | " +
          "forecolor backcolor | alignleft aligncenter alignright alignjustify | " +
          "bullist numlist outdent indent | link image table codesample | " +
          "insertplaceholder insertblock insertmedia | removeformat code fullscreen help",
        skin: isDark ? "oxide-dark" : "oxide",
        content_css: isDark ? "dark" : "default",
        branding: false,
        promotion: false,
        statusbar: true,
        resize: true,
        setup: (editor: any) => {
          editor.ui.registry.addMenuButton("insertmedia", {
            text: "🖼",
            tooltip: "Insert media (QR / barcode / signature / image)",
            fetch: (cb: any) => {
              cb(
                MEDIA_SNIPPETS.map((s) => ({
                  type: "menuitem" as const,
                  text: `${s.label}   ${s.description}`,
                  onAction: () => editor.insertContent(s.html),
                }))
              );
            },
          });

          editor.ui.registry.addMenuButton("insertblock", {
            text: "⟨/⟩",
            tooltip: "Insert block (if / range / with)",
            fetch: (cb: any) => {
              cb(
                BLOCK_SNIPPETS.map((s) => ({
                  type: "menuitem" as const,
                  text: `${s.label}   ${s.description}`,
                  onAction: () => {
                    editor.insertContent(s.html);
                  },
                }))
              );
            },
          });

          editor.ui.registry.addMenuButton("insertplaceholder", {
            text: "{{ }}",
            tooltip: "Insert placeholder",
            fetch: (cb: any) => {
              if (placeholders.length === 0) {
                cb([
                  {
                    type: "menuitem",
                    text: "Custom placeholder…",
                    onAction: () => {
                      const name = window.prompt("Placeholder name (e.g. customer.name)");
                      if (name) editor.insertContent(`{{${name}}}`);
                    },
                  },
                ]);
                return;
              }
              const items = placeholders.map((p) => ({
                type: "menuitem" as const,
                text: `{{${p}}}`,
                onAction: () => editor.insertContent(`{{${p}}}`),
              }));
              items.push({
                type: "menuitem" as const,
                text: "Custom placeholder…",
                onAction: () => {
                  const name = window.prompt("Placeholder name (e.g. customer.name)");
                  if (name) editor.insertContent(`{{${name}}}`);
                },
              });
              cb(items);
            },
          });
        },
      }}
    />
  );
}
