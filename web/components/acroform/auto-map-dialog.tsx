"use client";

// AutoMapDialog — paste sample JSON, fuzzy-match the JSON's dot-paths to
// each PDF field name, and bulk-apply the accepted matches as dataKeys.

import { useMemo, useState } from "react";
import { Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { bestMatches, flattenPaths } from "@/lib/fuzzy-match";
import type { AcroFormField } from "./types";

type Row = {
  fieldName: string;
  suggestedKey: string;
  score: number;
  accepted: boolean;
  allSuggestions: { candidate: string; score: number }[];
};

type Props = {
  open: boolean;
  fields: AcroFormField[];
  onOpenChange: (o: boolean) => void;
  onApply: (
    matches: Record<string, string>,
    sampleData: Record<string, any>
  ) => void;
};

export function AutoMapDialog({ open, fields, onOpenChange, onApply }: Props) {
  const [sample, setSample] = useState("");
  const [threshold, setThreshold] = useState(0.5);
  const [error, setError] = useState<string | null>(null);

  const analysis = useMemo<{ rows: Row[]; flat: Record<string, any> } | null>(() => {
    if (!sample.trim()) return null;
    try {
      const parsed = JSON.parse(sample);
      const flat = flattenPaths(parsed);
      const paths = Object.keys(flat);
      const rows: Row[] = fields.map((f) => {
        const matches = bestMatches(f.name, paths, 3);
        const top = matches[0];
        return {
          fieldName: f.name,
          suggestedKey: top?.candidate ?? "",
          score: top?.score ?? 0,
          accepted: (top?.score ?? 0) >= threshold,
          allSuggestions: matches,
        };
      });
      return { rows, flat };
    } catch (e: any) {
      return null;
    }
  }, [sample, fields, threshold]);

  const [rows, setRows] = useState<Row[] | null>(null);

  // Keep the local rows state in sync when analysis changes.
  useMemo(() => {
    if (analysis) setRows(analysis.rows);
    else setRows(null);
  }, [analysis]);

  function apply() {
    if (!rows || !analysis) {
      setError("Paste valid JSON first.");
      return;
    }
    const mp: Record<string, string> = {};
    for (const r of rows) {
      if (r.accepted && r.suggestedKey) mp[r.fieldName] = r.suggestedKey;
    }
    onApply(mp, analysis.flat);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Auto-map from sample data</DialogTitle>
          <DialogDescription>
            Paste a sample JSON payload. We&rsquo;ll suggest a JSON path for each PDF
            field using fuzzy matching.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Sample JSON</Label>
            <textarea
              className="h-64 w-full rounded-md border bg-background p-2 font-mono text-xs"
              placeholder='{"first_name":"Ada","address":{"city":"London"}}'
              value={sample}
              onChange={(e) => setSample(e.target.value)}
            />
            <div className="flex items-center gap-2 text-xs">
              <Label className="w-24 text-xs">Accept ≥</Label>
              <Input
                type="number"
                step="0.05"
                min="0"
                max="1"
                className="h-7 w-20 text-xs"
                value={threshold}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!Number.isNaN(v)) setThreshold(v);
                }}
              />
            </div>
          </div>

          <div className="h-64 overflow-y-auto rounded-md border text-xs">
            {rows ? (
              <table className="w-full">
                <thead className="bg-muted/50 text-[11px] uppercase text-muted-foreground">
                  <tr>
                    <th className="p-1.5 text-left">Field</th>
                    <th className="p-1.5 text-left">Suggested key</th>
                    <th className="p-1.5 w-12 text-right">Score</th>
                    <th className="p-1.5 w-10 text-center">✓</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.fieldName} className="border-t">
                      <td className="p-1.5 font-mono text-[11px]">{r.fieldName}</td>
                      <td className="p-1.5">
                        <select
                          className="w-full rounded border bg-background px-1 py-0.5 font-mono text-[11px]"
                          value={r.suggestedKey}
                          onChange={(e) => {
                            const next = [...rows];
                            next[i] = { ...r, suggestedKey: e.target.value };
                            setRows(next);
                          }}
                        >
                          <option value="">(skip)</option>
                          {r.allSuggestions.map((s) => (
                            <option key={s.candidate} value={s.candidate}>
                              {s.candidate} ({s.score.toFixed(2)})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-1.5 text-right font-mono">{r.score.toFixed(2)}</td>
                      <td className="p-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={r.accepted}
                          onChange={(e) => {
                            const next = [...rows];
                            next[i] = { ...r, accepted: e.target.checked };
                            setRows(next);
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="p-4 text-muted-foreground">
                {sample.trim()
                  ? "Waiting for valid JSON…"
                  : "Paste JSON on the left to see suggestions."}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={apply}>
            <Wand2 className="h-4 w-4" /> Apply accepted matches
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
