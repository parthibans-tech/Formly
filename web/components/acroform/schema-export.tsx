"use client";

// SchemaExportDialog — generate TypeScript interface / Zod schema / JSON Schema
// from the current mappings. Respects sections (nested objects) and infers
// types from PDF field type + transform.

import { useMemo, useState } from "react";
import { Copy, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { normalizeTransform } from "@/lib/acroform-transforms";
import type { AcroFormField, MappingMap } from "./types";

type Format = "typescript" | "zod" | "json-schema";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  fields: AcroFormField[];
  mappings: MappingMap;
};

export function SchemaExportDialog({ open, onOpenChange, fields, mappings }: Props) {
  const [format, setFormat] = useState<Format>("typescript");
  const [copied, setCopied] = useState(false);

  const output = useMemo(() => {
    return generate(format, fields, mappings);
  }, [format, fields, mappings]);

  function copy() {
    navigator.clipboard?.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Export schema</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={format} onValueChange={(v) => setFormat(v as Format)}>
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="typescript">TypeScript interface</SelectItem>
              <SelectItem value="zod">Zod schema</SelectItem>
              <SelectItem value="json-schema">JSON Schema (draft-07)</SelectItem>
            </SelectContent>
          </Select>

          <pre className="max-h-96 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs">
            {output}
          </pre>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={copy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type LeafType = { kind: "string" | "number" | "boolean" | "enum"; values?: string[]; required: boolean };

function inferLeafType(field: AcroFormField, txOp: string | undefined, required: boolean): LeafType {
  const t = field.type.toLowerCase();
  if (t.includes("check")) return { kind: "boolean", required };
  if ((t.includes("combo") || t.includes("dropdown") || t.includes("choice") || t.includes("radio") || t.includes("list")) && field.options && field.options.length > 0) {
    return { kind: "enum", values: field.options, required };
  }
  if (txOp === "number-format") return { kind: "number", required };
  return { kind: "string", required };
}

function generate(format: Format, fields: AcroFormField[], mappings: MappingMap): string {
  // Group leaves by section → list of {key,type}.
  type Leaf = { key: string; type: LeafType };
  const bySection = new Map<string, Leaf[]>();

  for (const f of fields) {
    const m = mappings[f.name];
    if (!m || !m.dataKey) continue;
    const tx = normalizeTransform(m.transform);
    const type = inferLeafType(f, tx.op, !!m.required);
    const section = m.section || "";
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section)!.push({ key: m.dataKey, type });
  }

  if (format === "typescript") return generateTS(bySection);
  if (format === "zod") return generateZod(bySection);
  return generateJSONSchema(bySection);
}

function tsFieldLine(leaf: { key: string; type: LeafType }): string {
  const opt = leaf.type.required ? "" : "?";
  let tp: string;
  switch (leaf.type.kind) {
    case "number":
      tp = "number";
      break;
    case "boolean":
      tp = "boolean";
      break;
    case "enum":
      tp = (leaf.type.values || []).map((v) => JSON.stringify(v)).join(" | ") || "string";
      break;
    default:
      tp = "string";
  }
  return `  ${JSON.stringify(leaf.key)}${opt}: ${tp};`;
}

function generateTS(bySection: Map<string, { key: string; type: LeafType }[]>): string {
  const lines: string[] = ["export interface FormData {"];
  const root = bySection.get("") || [];
  for (const l of root) lines.push(tsFieldLine(l));
  for (const [section, leaves] of bySection.entries()) {
    if (section === "") continue;
    lines.push(`  ${JSON.stringify(section)}: {`);
    for (const l of leaves) lines.push("  " + tsFieldLine(l));
    lines.push("  };");
  }
  lines.push("}");
  return lines.join("\n");
}

function zodLine(leaf: { key: string; type: LeafType }): string {
  let call: string;
  switch (leaf.type.kind) {
    case "number":
      call = "z.number()";
      break;
    case "boolean":
      call = "z.boolean()";
      break;
    case "enum":
      call = `z.enum([${(leaf.type.values || []).map((v) => JSON.stringify(v)).join(", ")}])`;
      break;
    default:
      call = "z.string()";
  }
  if (!leaf.type.required) call += ".optional()";
  return `  ${JSON.stringify(leaf.key)}: ${call},`;
}

function generateZod(bySection: Map<string, { key: string; type: LeafType }[]>): string {
  const lines: string[] = [
    `import { z } from "zod";`,
    "",
    "export const FormSchema = z.object({",
  ];
  const root = bySection.get("") || [];
  for (const l of root) lines.push(zodLine(l));
  for (const [section, leaves] of bySection.entries()) {
    if (section === "") continue;
    lines.push(`  ${JSON.stringify(section)}: z.object({`);
    for (const l of leaves) lines.push("  " + zodLine(l));
    lines.push("  }),");
  }
  lines.push("});");
  lines.push("");
  lines.push("export type FormData = z.infer<typeof FormSchema>;");
  return lines.join("\n");
}

function jsonTypeFor(kind: LeafType["kind"]): string {
  switch (kind) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

function generateJSONSchema(bySection: Map<string, { key: string; type: LeafType }[]>): string {
  const root = bySection.get("") || [];
  const properties: Record<string, any> = {};
  const required: string[] = [];
  for (const l of root) {
    const prop: any = { type: jsonTypeFor(l.type.kind) };
    if (l.type.kind === "enum") prop.enum = l.type.values;
    properties[l.key] = prop;
    if (l.type.required) required.push(l.key);
  }
  for (const [section, leaves] of bySection.entries()) {
    if (section === "") continue;
    const sectionProps: Record<string, any> = {};
    const sectionReq: string[] = [];
    for (const l of leaves) {
      const prop: any = { type: jsonTypeFor(l.type.kind) };
      if (l.type.kind === "enum") prop.enum = l.type.values;
      sectionProps[l.key] = prop;
      if (l.type.required) sectionReq.push(l.key);
    }
    properties[section] = {
      type: "object",
      properties: sectionProps,
      ...(sectionReq.length ? { required: sectionReq } : {}),
    };
  }
  const doc: Record<string, any> = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties,
  };
  if (required.length) doc.required = required;
  return JSON.stringify(doc, null, 2);
}
