"use client";

// CsvImportDialog — paste or upload a CSV, preview parsed rows, pick one
// or more rows to save as named fixtures.
//
// Why keep the parser in-house
// ----------------------------
// A full CSV library would pull in tens of KB for what's basically a
// single-file workflow. The in-line parser here handles the quoted-field
// + embedded-newline edge cases that naïve split(",") misses, which is
// enough for anything a user exports from Excel, Sheets, or Numbers.
//
// Per-row import
// --------------
// The dialog shows every parsed row with its values collapsed into a
// preview. The user picks which row(s) to save and names each. Fixtures
// are created via `fx.importOne(name, data)` which delegates to the
// hook's `create`, so the name uniqueness + active-fixture rules apply.

import { useMemo, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { UseFixtures } from "@/hooks/use-acroform-fixtures";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fx: UseFixtures;
  // Known mapping data keys, used to flag header mismatches in the
  // preview pane so the user catches CSV columns that won't bind.
  mappingDataKeys: string[];
};

export function CsvImportDialog({
  open,
  onOpenChange,
  fx,
  mappingDataKeys,
}: Props) {
  const [csvText, setCsvText] = useState("");
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [rowNames, setRowNames] = useState<Record<number, string>>({});

  const parsed = useMemo(() => {
    if (!csvText.trim()) return null;
    try {
      return parseCsv(csvText);
    } catch (e: any) {
      return { error: e.message as string };
    }
  }, [csvText]);

  // Known-key lookup for highlighting header cells that map to a field.
  const knownKeys = useMemo(
    () => new Set(mappingDataKeys.filter(Boolean)),
    [mappingDataKeys]
  );

  function loadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result));
    reader.readAsText(file);
    e.target.value = "";
  }

  function toggleRow(i: number) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function runImport() {
    if (!parsed || "error" in parsed) return;
    const { headers, rows } = parsed;
    let count = 0;
    for (const i of selectedRows) {
      const row = rows[i];
      if (!row) continue;
      const data: Record<string, any> = {};
      for (let c = 0; c < headers.length; c++) {
        const key = headers[c];
        if (!key) continue;
        data[key] = row[c] ?? "";
      }
      const name =
        rowNames[i]?.trim() ||
        `Row ${i + 1}` +
          (typeof row[0] === "string" && row[0] ? ` — ${row[0]}` : "");
      fx.importOne(name, data);
      count++;
    }
    setParseErr(null);
    setCsvText("");
    setSelectedRows(new Set());
    setRowNames({});
    onOpenChange(false);
    if (count > 0) {
      // Parent can observe via fx.fixtures; a caller-level toast would
      // double up. Keep silent here.
    }
  }

  const rowCount = parsed && !("error" in parsed) ? parsed.rows.length : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import fixtures from CSV</DialogTitle>
          <DialogDescription>
            The first row is treated as column headers. Each header that
            matches a mapping data key is highlighted. Pick one or more
            data rows to save as fixtures.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted">
            <Upload className="h-3.5 w-3.5" />
            Upload CSV…
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={loadFile}
            />
          </label>
          <span className="text-xs text-muted-foreground">
            or paste below
          </span>
        </div>

        <textarea
          className="h-40 w-full rounded-md border bg-background p-2 font-mono text-xs"
          placeholder="firstName,lastName,email&#10;Ada,Lovelace,ada@example.com&#10;Alan,Turing,alan@example.com"
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
        />

        {parseErr && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {parseErr}
          </div>
        )}

        {parsed && "error" in parsed && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {parsed.error}
          </div>
        )}

        {parsed && !("error" in parsed) && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">
                {rowCount} row{rowCount === 1 ? "" : "s"} parsed •{" "}
                {parsed.headers.length} columns •{" "}
                {parsed.headers.filter((h) => knownKeys.has(h)).length} matching
                keys
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() =>
                    setSelectedRows(
                      new Set(Array.from({ length: rowCount }, (_, i) => i))
                    )
                  }
                >
                  Select all
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setSelectedRows(new Set())}
                >
                  Clear
                </Button>
              </div>
            </div>
            <div className="max-h-64 overflow-auto rounded-md border">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                  <tr>
                    <th className="w-8 px-2 py-1 text-left"></th>
                    <th className="w-36 px-2 py-1 text-left">Name</th>
                    {parsed.headers.map((h, i) => (
                      <th
                        key={i}
                        className={`px-2 py-1 text-left font-mono ${
                          knownKeys.has(h)
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-muted-foreground"
                        }`}
                      >
                        {h || <em className="text-destructive">(blank)</em>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.map((row, i) => {
                    const selected = selectedRows.has(i);
                    return (
                      <tr
                        key={i}
                        className={selected ? "bg-primary/5" : "hover:bg-muted/30"}
                      >
                        <td className="px-2 py-1">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-primary"
                            checked={selected}
                            onChange={() => toggleRow(i)}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="text"
                            className="h-6 w-full rounded border bg-background px-1 text-[11px]"
                            placeholder={`Row ${i + 1}`}
                            value={rowNames[i] ?? ""}
                            onChange={(e) =>
                              setRowNames((p) => ({ ...p, [i]: e.target.value }))
                            }
                          />
                        </td>
                        {parsed.headers.map((_, c) => (
                          <td
                            key={c}
                            className="max-w-[160px] truncate px-2 py-1 font-mono"
                            title={row[c]}
                          >
                            {row[c] ?? ""}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={selectedRows.size === 0}
            onClick={runImport}
          >
            Import {selectedRows.size} fixture
            {selectedRows.size === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// parseCsv — minimal RFC-4180-flavored parser. Handles quoted fields,
// embedded commas, embedded newlines, and doubled-quote escapes.
// Lines terminated by LF or CRLF. Returns headers + rows of strings.
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  // Strip a leading BOM if present — Excel likes to add one.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush the last field/row if we didn't end on a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) {
    throw new Error("CSV is empty");
  }
  const headers = rows[0].map((h) => h.trim());
  return { headers, rows: rows.slice(1) };
}
