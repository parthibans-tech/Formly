"use client";

// Design-time QA panel — surfaces structural issues in the mapping config
// (duplicate data keys, unmapped required fields, type mismatches between
// PDF field type and chosen transform, etc.) and hosts the cross-validation
// editor. Shown as a right-side drawer.

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Info as InfoIcon,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { normalizePipeline } from "@/lib/acroform-transforms";
import type {
  AcroFormField,
  CrossValidation,
  MappingMap,
} from "./types";
import { validateAll, type FieldError } from "@/lib/acroform-validation";

export type AcroIssue = {
  id: string;
  fieldName: string;
  severity: "error" | "warning" | "info";
  message: string;
};

type Props = {
  open: boolean;
  fields: AcroFormField[];
  mappings: MappingMap;
  sampleData: Record<string, any>;
  crossValidations: CrossValidation[];
  onClose: () => void;
  onSelectField: (name: string) => void;
  onChangeCross: (list: CrossValidation[]) => void;
};

export function DesignQAPanel({
  open,
  fields,
  mappings,
  sampleData,
  crossValidations,
  onClose,
  onSelectField,
  onChangeCross,
}: Props) {
  const issues = useMemo(
    () => runAcroQA(fields, mappings, sampleData, crossValidations),
    [fields, mappings, sampleData, crossValidations]
  );

  // Group issues by kind. At scale, a flat list of "50 duplicate dataKeys"
  // is noise — users want to see "Duplicate data keys (50)" and drill in.
  // Kind is derived from the ID prefix emitted by runAcroQA.
  const groups = useMemo(() => groupIssuesByKind(issues), [issues]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Auto-expand tiny groups (<=5 rows) so they don't require a click.
  const effectiveExpanded = useMemo(() => {
    const s = new Set(expanded);
    for (const g of groups) if (g.issues.length <= 5) s.add(g.kind);
    return s;
  }, [expanded, groups]);

  if (!open) return null;

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warning").length;
  const infoCount = issues.filter((i) => i.severity === "info").length;

  function toggleGroup(kind: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function addCross() {
    onChangeCross([
      ...crossValidations,
      { id: `cv_${Date.now()}`, expression: "", message: "" },
    ]);
  }
  function updateCross(id: string, patch: Partial<CrossValidation>) {
    onChangeCross(
      crossValidations.map((c) => (c.id === id ? { ...c, ...patch } : c))
    );
  }
  function removeCross(id: string) {
    onChangeCross(crossValidations.filter((c) => c.id !== id));
  }

  return (
    <aside className="fixed inset-y-0 right-0 z-50 flex w-[420px] flex-col border-l bg-background shadow-xl">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Design QA</h2>
          <p className="text-[11px] text-muted-foreground">
            {errorCount} error{errorCount === 1 ? "" : "s"},{" "}
            {warnCount} warning{warnCount === 1 ? "" : "s"},{" "}
            {infoCount} info
          </p>
        </div>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <section className="divide-y">
          {issues.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No issues detected. 🎉
            </div>
          )}
          {groups.map((g) => {
            const isOpen = effectiveExpanded.has(g.kind);
            return (
              <div key={g.kind}>
                <button
                  type="button"
                  onClick={() => toggleGroup(g.kind)}
                  className="flex w-full items-center gap-2 bg-muted/30 px-4 py-2 text-left text-xs hover:bg-muted/60"
                >
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <SeverityIcon severity={g.severity} />
                  <span className="flex-1 font-medium">{g.label}</span>
                  <span className="rounded bg-background px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    {g.issues.length}
                  </span>
                </button>
                {isOpen && (
                  <div className="divide-y">
                    {g.issues.map((iss) => (
                      <button
                        key={iss.id}
                        type="button"
                        onClick={() =>
                          iss.fieldName && !iss.fieldName.startsWith("__")
                            ? onSelectField(iss.fieldName)
                            : undefined
                        }
                        className="flex w-full items-start gap-2 px-6 py-2 text-left text-xs hover:bg-muted/50"
                      >
                        <div className="min-w-0 flex-1">
                          {iss.fieldName && !iss.fieldName.startsWith("__") && (
                            <div className="truncate font-mono text-[10px] text-muted-foreground">
                              {iss.fieldName}
                            </div>
                          )}
                          <div className="text-foreground">{iss.message}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>

        <section className="border-t p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold">Cross-field validations</h3>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={addCross}
            >
              <Plus className="h-3 w-3" /> Add rule
            </Button>
          </div>
          {crossValidations.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              e.g. <code className="font-mono">startDate &lt; endDate</code>
            </p>
          ) : (
            <div className="space-y-2">
              {crossValidations.map((cv) => (
                <div key={cv.id} className="space-y-1.5 rounded-md border p-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">
                      Expression
                    </Label>
                    <Input
                      className="h-7 font-mono text-xs"
                      placeholder="startDate < endDate"
                      value={cv.expression}
                      onChange={(e) =>
                        updateCross(cv.id, { expression: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">
                      Message
                    </Label>
                    <Input
                      className="h-7 text-xs"
                      placeholder="Start date must be before end"
                      value={cv.message}
                      onChange={(e) =>
                        updateCross(cv.id, { message: e.target.value })
                      }
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px] text-destructive"
                      onClick={() => removeCross(cv.id)}
                    >
                      <Trash2 className="h-3 w-3" /> Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function SeverityIcon({ severity }: { severity: AcroIssue["severity"] }) {
  const common = "mt-0.5 h-3.5 w-3.5 shrink-0";
  switch (severity) {
    case "error":
      return <CircleAlert className={cn(common, "text-red-500")} />;
    case "warning":
      return <AlertTriangle className={cn(common, "text-amber-500")} />;
    default:
      return <InfoIcon className={cn(common, "text-blue-500")} />;
  }
}

// runAcroQA walks the mappings and returns a list of design-time issues.
// Kept pure so it can be unit-tested later.
export function runAcroQA(
  fields: AcroFormField[],
  mappings: MappingMap,
  sampleData: Record<string, any>,
  crossValidations: CrossValidation[] = []
): AcroIssue[] {
  const out: AcroIssue[] = [];
  const hasSample = Object.keys(sampleData).length > 0;

  // 1) Duplicate dataKeys across multiple fields.
  const dkToFields = new Map<string, string[]>();
  for (const f of fields) {
    const dk = mappings[f.name]?.dataKey;
    if (!dk) continue;
    if (!dkToFields.has(dk)) dkToFields.set(dk, []);
    dkToFields.get(dk)!.push(f.name);
  }
  for (const [dk, names] of dkToFields.entries()) {
    if (names.length > 1) {
      for (const n of names) {
        out.push({
          id: `dup:${dk}:${n}`,
          fieldName: n,
          severity: "error",
          message: `Duplicate data key "${dk}" (shared with ${names
            .filter((x) => x !== n)
            .join(", ")})`,
        });
      }
    }
  }

  for (const f of fields) {
    const m = mappings[f.name];

    // 2) Required field has no dataKey.
    if (m?.required && !m.dataKey) {
      out.push({
        id: `req-no-key:${f.name}`,
        fieldName: f.name,
        severity: "error",
        message: "Field is marked required but has no data key",
      });
    }

    // 3) Unmapped field.
    if (!m || !m.dataKey) {
      out.push({
        id: `unmapped:${f.name}`,
        fieldName: f.name,
        severity: "warning",
        message: "Field has no data key mapping",
      });
      continue;
    }

    // 4) dataKey not in sample data (only check when sample exists).
    if (hasSample && !(m.dataKey in sampleData) && !keyInNestedSample(sampleData, m.dataKey)) {
      out.push({
        id: `no-sample:${f.name}`,
        fieldName: f.name,
        severity: "warning",
        message: `Data key "${m.dataKey}" is not present in sample data`,
      });
    }

    // 5) Type mismatch: checkbox with non-boolean transform.
    const ft = (f.type || "").toLowerCase();
    const pipeline = normalizePipeline(m.transform);
    if (ft.includes("check")) {
      const hasBoolean = pipeline.some((p) => p.op === "boolean-label");
      const hasStringOp = pipeline.some((p) =>
        ["uppercase", "lowercase", "titlecase", "date-format", "number-format"].includes(p.op)
      );
      if (hasStringOp && !hasBoolean) {
        out.push({
          id: `type-mismatch:${f.name}`,
          fieldName: f.name,
          severity: "warning",
          message: "Checkbox field uses a string-ish transform — consider Boolean → label",
        });
      }
    }

    // 6) fillWhen references unknown data key.
    if (m.fillWhen) {
      const pathMatch = /^([\w.]+)\s*(===|!==|==|!=|>=|<=|>|<)/.exec(m.fillWhen.trim());
      if (pathMatch && hasSample) {
        const path = pathMatch[1];
        if (!(path in sampleData) && !keyInNestedSample(sampleData, path)) {
          out.push({
            id: `fillwhen-unknown:${f.name}`,
            fieldName: f.name,
            severity: "info",
            message: `fillWhen references "${path}" which isn't in sample data`,
          });
        }
      }
    }

    // 7) Redundant transform chain (uppercase then lowercase, etc.).
    if (pipeline.length >= 2) {
      for (let i = 0; i < pipeline.length - 1; i++) {
        const pair = [pipeline[i].op, pipeline[i + 1].op];
        const redundant =
          (pair[0] === "uppercase" && pair[1] === "lowercase") ||
          (pair[0] === "lowercase" && pair[1] === "uppercase") ||
          (pair[0] === pair[1] && ["uppercase", "lowercase", "titlecase", "trim"].includes(pair[0]));
        if (redundant) {
          out.push({
            id: `redundant:${f.name}:${i}`,
            fieldName: f.name,
            severity: "warning",
            message: `Transform step ${i + 1} (${pair[0]}) → ${i + 2} (${pair[1]}) looks redundant`,
          });
        }
      }
    }
  }

  // 8) Runtime validation failures (mirror of inline errors) so the panel
  //    surfaces them in one place.
  const runtimeErrs: FieldError[] = validateAll(fields, mappings, sampleData, crossValidations);
  for (const e of runtimeErrs) {
    out.push({
      id: `runtime:${e.fieldName}:${e.message}`,
      fieldName: e.fieldName,
      severity: e.severity,
      message: e.message,
    });
  }

  return out;
}

// Human-readable label per issue kind. Keys must match the ID prefixes
// emitted by runAcroQA — if you add a new prefix there, add its label
// here so the group header reads nicely instead of showing the raw
// prefix.
const KIND_LABELS: Record<string, string> = {
  dup: "Duplicate data keys",
  "req-no-key": "Required without data key",
  unmapped: "Unmapped fields",
  "no-sample": "Data key missing from sample",
  "type-mismatch": "Type mismatches",
  "fillwhen-unknown": "fillWhen references unknown key",
  redundant: "Redundant transforms",
  runtime: "Validation failures",
};

// Severity priority for sorting groups — errors first, then warnings,
// then info. Within a priority we fall back to the insertion order of
// KIND_LABELS so the panel reads consistently across renders.
const SEVERITY_RANK: Record<AcroIssue["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

type IssueGroup = {
  kind: string;
  label: string;
  severity: AcroIssue["severity"];
  issues: AcroIssue[];
};

function groupIssuesByKind(issues: AcroIssue[]): IssueGroup[] {
  const byKind = new Map<string, IssueGroup>();
  for (const iss of issues) {
    const kind = iss.id.split(":", 1)[0] || "other";
    let g = byKind.get(kind);
    if (!g) {
      g = {
        kind,
        label: KIND_LABELS[kind] ?? kind,
        // A group's severity is the worst severity any of its issues
        // has. Start from the first issue; upgrade below.
        severity: iss.severity,
        issues: [],
      };
      byKind.set(kind, g);
    }
    g.issues.push(iss);
    if (SEVERITY_RANK[iss.severity] < SEVERITY_RANK[g.severity]) {
      g.severity = iss.severity;
    }
  }
  return Array.from(byKind.values()).sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  );
}

function keyInNestedSample(data: Record<string, any>, path: string): boolean {
  const parts = path.split(".");
  let cur: any = data;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return false;
    if (!(p in cur)) return false;
    cur = cur[p];
  }
  return true;
}
