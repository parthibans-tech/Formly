"use client";

import { useEffect, useMemo, useState } from "react";
import { Globe, Plus, Trash2, Star } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { LOCALES, type LocaleCode } from "@/lib/locales";
import { cn } from "@/lib/utils";

export type Translations = {
  locale?: string;
  locales?: string[];
  translations?: Record<string, Record<string, string>>;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value?: Translations;
  onSave: (next: Translations) => Promise<void> | void;
  busy?: boolean;
};

export function TranslationsDialog({
  open,
  onOpenChange,
  value,
  onSave,
  busy,
}: Props) {
  const [defaultLocale, setDefaultLocale] = useState<LocaleCode>("en-US");
  const [locales, setLocales] = useState<string[]>(["en-US"]);
  const [rows, setRows] = useState<string[]>([]); // ordered translation keys
  const [byLocale, setByLocale] = useState<Record<string, Record<string, string>>>({});

  useEffect(() => {
    if (!open) return;
    const dl = (value?.locale as LocaleCode) || "en-US";
    const locs = value?.locales && value.locales.length ? value.locales : [dl];
    setDefaultLocale(dl);
    setLocales(locs);
    // Collect unique keys preserving insertion order.
    const src = value?.translations || {};
    const seen = new Set<string>();
    const keyList: string[] = [];
    for (const loc of locs) {
      for (const k of Object.keys(src[loc] || {})) {
        if (!seen.has(k)) {
          seen.add(k);
          keyList.push(k);
        }
      }
    }
    setRows(keyList);
    setByLocale({ ...src });
  }, [open, value]);

  const availableToAdd = useMemo(
    () => LOCALES.filter((l) => !locales.includes(l.code)),
    [locales]
  );

  function renameKey(idx: number, nextKey: string) {
    const prev = rows[idx];
    setRows((r) => r.map((k, i) => (i === idx ? nextKey : k)));
    setByLocale((m) => {
      const out: Record<string, Record<string, string>> = {};
      for (const loc of Object.keys(m)) {
        out[loc] = {};
        for (const k of Object.keys(m[loc])) {
          out[loc][k === prev ? nextKey : k] = m[loc][k];
        }
      }
      return out;
    });
  }

  function setCell(locale: string, key: string, val: string) {
    setByLocale((m) => ({
      ...m,
      [locale]: { ...(m[locale] || {}), [key]: val },
    }));
  }

  function addKey() {
    const candidate = uniqueKey(rows, "key");
    setRows((r) => [...r, candidate]);
    setByLocale((m) => {
      const out = { ...m };
      for (const loc of locales) out[loc] = { ...(out[loc] || {}) };
      return out;
    });
  }

  function removeKey(idx: number) {
    const key = rows[idx];
    setRows((r) => r.filter((_, i) => i !== idx));
    setByLocale((m) => {
      const out: Record<string, Record<string, string>> = {};
      for (const loc of Object.keys(m)) {
        const { [key]: _drop, ...rest } = m[loc] || {};
        out[loc] = rest;
      }
      return out;
    });
  }

  function addLocale(code: string) {
    if (locales.includes(code)) return;
    setLocales((l) => [...l, code]);
    setByLocale((m) => ({ ...m, [code]: m[code] || {} }));
  }

  function removeLocale(code: string) {
    if (code === defaultLocale) return;
    setLocales((l) => l.filter((c) => c !== code));
    setByLocale((m) => {
      const { [code]: _drop, ...rest } = m;
      return rest;
    });
  }

  function save() {
    // Prune empty cells + preserve row order in each locale's map.
    const out: Record<string, Record<string, string>> = {};
    for (const loc of locales) {
      const src = byLocale[loc] || {};
      const dict: Record<string, string> = {};
      for (const k of rows) {
        const v = src[k];
        if (v && k.trim()) dict[k] = v;
      }
      out[loc] = dict;
    }
    onSave({
      locale: defaultLocale,
      locales,
      translations: out,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5 text-primary" />
            Translations
          </DialogTitle>
          <DialogDescription>
            Add locale-specific strings your template can reference via{" "}
            <code className="font-mono text-xs">{'{{ t "key" }}'}</code>.
            Formatters (<code className="font-mono">formatCurrency</code>,{" "}
            <code className="font-mono">formatNumber</code>,{" "}
            <code className="font-mono">formatDate</code>) auto-localize to the
            active locale at render time.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-5 overflow-y-auto px-1">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Default locale</Label>
              <Select
                value={defaultLocale}
                onValueChange={(v) => {
                  const code = v as LocaleCode;
                  setDefaultLocale(code);
                  if (!locales.includes(code)) addLocale(code);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOCALES.map((l) => (
                    <SelectItem key={l.code} value={l.code}>
                      {l.flag} {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">
                Used when the data payload omits <code>locale</code>.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Add another locale</Label>
              <Select
                value=""
                onValueChange={(v) => v && addLocale(v)}
                disabled={availableToAdd.length === 0}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      availableToAdd.length === 0
                        ? "All locales added"
                        : "Pick a locale…"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {availableToAdd.map((l) => (
                    <SelectItem key={l.code} value={l.code}>
                      {l.flag} {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {locales.map((code) => {
              const opt = LOCALES.find((l) => l.code === code);
              const isDefault = code === defaultLocale;
              return (
                <span
                  key={code}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                    isDefault && "border-primary bg-primary/10 text-primary"
                  )}
                >
                  {isDefault && <Star className="h-3 w-3" />}
                  {opt ? `${opt.flag} ${opt.label}` : code}
                  {!isDefault && (
                    <button
                      onClick={() => removeLocale(code)}
                      className="ml-1 opacity-60 hover:opacity-100"
                      aria-label="Remove locale"
                    >
                      ×
                    </button>
                  )}
                </span>
              );
            })}
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Translation keys</h3>
              <Button variant="outline" size="sm" onClick={addKey}>
                <Plus className="h-4 w-4" />
                Add key
              </Button>
            </div>
            {rows.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                No translation keys yet. Add one to get started — use{" "}
                <code className="font-mono text-xs">{'{{ t "invoice.title" }}'}</code>{" "}
                in the template source.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="p-2 font-medium">Key</th>
                      {locales.map((loc) => {
                        const opt = LOCALES.find((l) => l.code === loc);
                        return (
                          <th key={loc} className="p-2 font-medium">
                            {opt ? `${opt.flag} ${loc}` : loc}
                            {loc === defaultLocale && (
                              <Badge
                                variant="secondary"
                                className="ml-1 text-[9px]"
                              >
                                default
                              </Badge>
                            )}
                          </th>
                        );
                      })}
                      <th className="p-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((k, i) => (
                      <tr
                        key={i}
                        className="border-b last:border-0 align-top"
                      >
                        <td className="p-1 w-56">
                          <Input
                            value={k}
                            onChange={(e) => renameKey(i, e.target.value)}
                            placeholder="invoice.title"
                            className="font-mono text-xs h-8"
                          />
                        </td>
                        {locales.map((loc) => (
                          <td key={loc} className="p-1">
                            <Input
                              value={(byLocale[loc] || {})[k] || ""}
                              onChange={(e) => setCell(loc, k, e.target.value)}
                              placeholder={
                                loc === defaultLocale
                                  ? "Invoice"
                                  : "Translation"
                              }
                              className="text-xs h-8"
                            />
                          </td>
                        ))}
                        <td className="p-1 w-10">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => removeKey(i)}
                            aria-label="Remove key"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <details className="rounded-md border bg-muted/30 p-3 text-xs">
            <summary className="cursor-pointer font-semibold">
              Usage in templates
            </summary>
            <div className="mt-2 space-y-1.5 font-mono text-[11px]">
              <div>
                <span className="text-muted-foreground">Lookup:</span>{" "}
                {'{{ t "invoice.title" }}'}
              </div>
              <div>
                <span className="text-muted-foreground">With args:</span>{" "}
                {'{{ t "greeting" .customer.name }}'} → uses {"{0}"}, {"{1}"}, …
              </div>
              <div>
                <span className="text-muted-foreground">Override locale:</span>{" "}
                data: <code>{'{ "locale": "es-ES" }'}</code>
              </div>
              <div>
                <span className="text-muted-foreground">Formatters:</span>{" "}
                {'{{ .amount | formatCurrency "USD" }}'} auto-localizes ($ vs €
                · comma vs period · etc.)
              </div>
            </div>
          </details>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            <Globe className="h-4 w-4" />
            Save translations
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function uniqueKey(rows: string[], base: string): string {
  let candidate = base;
  let n = 1;
  while (rows.includes(candidate)) {
    n++;
    candidate = `${base}${n}`;
  }
  return candidate;
}
