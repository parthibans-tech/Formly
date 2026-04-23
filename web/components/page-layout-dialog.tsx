"use client";

import { useEffect, useState } from "react";
import {
  Settings2,
  RectangleHorizontal,
  RectangleVertical,
  LayoutPanelLeft,
  Hash,
  Droplet,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  DEFAULT_LAYOUT,
  mergeLayout,
  type PageLayout,
  type PageNumberPosition,
  type PageSize,
  type Orientation,
} from "@/lib/layout";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value?: PageLayout;
  onSave: (next: PageLayout) => Promise<void> | void;
  supportsHeaderFooter?: boolean; // off for static mode
  busy?: boolean;
};

export function PageLayoutDialog({
  open,
  onOpenChange,
  value,
  onSave,
  supportsHeaderFooter = true,
  busy,
}: Props) {
  const [draft, setDraft] = useState(() => mergeLayout(value));

  useEffect(() => {
    if (open) setDraft(mergeLayout(value));
  }, [open, value]);

  function updateMargin(side: keyof typeof DEFAULT_LAYOUT.margins, val: number) {
    setDraft((d) => ({ ...d, margins: { ...d.margins, [side]: val } }));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5 text-primary" />
            Page layout
          </DialogTitle>
          <DialogDescription>
            Controls how the template is paginated when rendered to PDF.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 max-h-[65vh] overflow-y-auto px-1">
          {/* Page & orientation */}
          <Section icon={LayoutPanelLeft} title="Page">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Size">
                <Select
                  value={draft.pageSize}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, pageSize: v as PageSize }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Letter">Letter (8.5 × 11 in)</SelectItem>
                    <SelectItem value="Legal">Legal (8.5 × 14 in)</SelectItem>
                    <SelectItem value="A4">A4 (210 × 297 mm)</SelectItem>
                    <SelectItem value="A3">A3 (297 × 420 mm)</SelectItem>
                    <SelectItem value="A5">A5 (148 × 210 mm)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Orientation">
                <div className="flex gap-2">
                  <OrientBtn
                    active={draft.orientation === "portrait"}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        orientation: "portrait" as Orientation,
                      }))
                    }
                  >
                    <RectangleVertical className="h-4 w-4" />
                    Portrait
                  </OrientBtn>
                  <OrientBtn
                    active={draft.orientation === "landscape"}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        orientation: "landscape" as Orientation,
                      }))
                    }
                  >
                    <RectangleHorizontal className="h-4 w-4" />
                    Landscape
                  </OrientBtn>
                </div>
              </Field>
            </div>

            <Field label="Margins (inches)">
              <div className="grid grid-cols-4 gap-2">
                {(["top", "right", "bottom", "left"] as const).map((side) => (
                  <div key={side} className="space-y-1">
                    <Label
                      htmlFor={`m-${side}`}
                      className="text-[10px] uppercase tracking-wide text-muted-foreground"
                    >
                      {side}
                    </Label>
                    <Input
                      id={`m-${side}`}
                      type="number"
                      step={0.05}
                      min={0}
                      max={3}
                      value={draft.margins[side]}
                      onChange={(e) =>
                        updateMargin(side, parseFloat(e.target.value) || 0)
                      }
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {[0.25, 0.4, 0.5, 0.75, 1].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        margins: { top: n, right: n, bottom: n, left: n },
                      }))
                    }
                  >
                    {n}&quot; all
                  </button>
                ))}
              </div>
            </Field>
          </Section>

          {supportsHeaderFooter && (
            <>
              <Separator />
              <Section icon={LayoutPanelLeft} title="Header & footer">
                <ToggleRow
                  label="Show header on every page"
                  checked={draft.header.enabled}
                  onChange={(v) =>
                    setDraft((d) => ({
                      ...d,
                      header: { ...d.header, enabled: v },
                    }))
                  }
                />
                {draft.header.enabled && (
                  <textarea
                    className="mt-2 h-20 w-full rounded-md border bg-background p-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder='<span style="float:right">{{ .title }}</span>'
                    value={draft.header.html}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        header: { ...d.header, html: e.target.value },
                      }))
                    }
                  />
                )}
                <ToggleRow
                  label="Show footer on every page"
                  checked={draft.footer.enabled}
                  onChange={(v) =>
                    setDraft((d) => ({
                      ...d,
                      footer: { ...d.footer, enabled: v },
                    }))
                  }
                />
                {draft.footer.enabled && (
                  <textarea
                    className="mt-2 h-20 w-full rounded-md border bg-background p-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder="© Acme, Inc. · Confidential"
                    value={draft.footer.html}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        footer: { ...d.footer, html: e.target.value },
                      }))
                    }
                  />
                )}
              </Section>

              <Separator />
              <Section icon={Hash} title="Page numbers">
                <ToggleRow
                  label="Show page numbers"
                  checked={draft.pageNumbers.enabled}
                  onChange={(v) =>
                    setDraft((d) => ({
                      ...d,
                      pageNumbers: { ...d.pageNumbers, enabled: v },
                    }))
                  }
                />
                {draft.pageNumbers.enabled && (
                  <div className="mt-2 grid grid-cols-[2fr_1fr] gap-2">
                    <Field label="Format">
                      <Input
                        value={draft.pageNumbers.format}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            pageNumbers: {
                              ...d.pageNumbers,
                              format: e.target.value,
                            },
                          }))
                        }
                        placeholder="Page {page} of {total}"
                      />
                    </Field>
                    <Field label="Position">
                      <Select
                        value={draft.pageNumbers.position}
                        onValueChange={(v) =>
                          setDraft((d) => ({
                            ...d,
                            pageNumbers: {
                              ...d.pageNumbers,
                              position: v as PageNumberPosition,
                            },
                          }))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="bottom-center">
                            Bottom center
                          </SelectItem>
                          <SelectItem value="bottom-left">Bottom left</SelectItem>
                          <SelectItem value="bottom-right">
                            Bottom right
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                )}
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Use <code>{"{page}"}</code> and <code>{"{total}"}</code> in the
                  format.
                </p>
              </Section>
            </>
          )}

          <Separator />
          <Section icon={Droplet} title="Watermark">
            <ToggleRow
              label="Show text watermark on every page"
              checked={draft.watermark.enabled}
              onChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  watermark: { ...d.watermark, enabled: v },
                }))
              }
            />
            {draft.watermark.enabled && (
              <div className="mt-2 grid grid-cols-2 gap-3">
                <Field label="Text">
                  <Input
                    value={draft.watermark.text}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        watermark: { ...d.watermark, text: e.target.value },
                      }))
                    }
                    placeholder="DRAFT"
                  />
                </Field>
                <Field label="Color">
                  <Input
                    type="color"
                    value={draft.watermark.color}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        watermark: { ...d.watermark, color: e.target.value },
                      }))
                    }
                    className="h-9 p-1"
                  />
                </Field>
                <Field label={`Opacity: ${Math.round(draft.watermark.opacity * 100)}%`}>
                  <input
                    type="range"
                    min={0.05}
                    max={0.6}
                    step={0.01}
                    value={draft.watermark.opacity}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        watermark: {
                          ...d.watermark,
                          opacity: parseFloat(e.target.value),
                        },
                      }))
                    }
                    className="w-full accent-primary"
                  />
                </Field>
                <Field label={`Angle: ${draft.watermark.angle}°`}>
                  <input
                    type="range"
                    min={-90}
                    max={90}
                    step={5}
                    value={draft.watermark.angle}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        watermark: {
                          ...d.watermark,
                          angle: parseInt(e.target.value, 10),
                        },
                      }))
                    }
                    className="w-full accent-primary"
                  />
                </Field>
                <Field label={`Font size: ${draft.watermark.fontSize}px`}>
                  <input
                    type="range"
                    min={40}
                    max={240}
                    step={5}
                    value={draft.watermark.fontSize}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        watermark: {
                          ...d.watermark,
                          fontSize: parseInt(e.target.value, 10),
                        },
                      }))
                    }
                    className="w-full accent-primary"
                  />
                </Field>
              </div>
            )}
          </Section>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={async () => {
              await onSave(draft);
            }}
            loading={busy}
          >
            <Settings2 className="h-4 w-4" />
            Save layout
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Settings2;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold">
        <Icon className="h-4 w-4 text-primary" />
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="h-4 w-4 accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function OrientBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-input hover:bg-accent"
      )}
    >
      {children}
    </button>
  );
}
