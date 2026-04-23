"use client";

// Schema tree sidebar — left rail of the designer. Shows every key the
// sample JSON exposes. Click a key to bind it to the currently-selected
// widget. Also warns about dataKeys that don't exist in the sample.

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  ChevronRight,
  Hash,
  List,
  Search,
  ToggleLeft,
  Type,
} from "lucide-react";
import { buildSchema, collectPaths, keyExists, type SchemaNode } from "@/lib/schema-utils";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

type Props = {
  sampleJSON: string;
  usedKeys: string[];             // all widget dataKeys in the template
  selectedDataKey?: string;       // highlight when it matches
  onBind: (path: string) => void; // click a leaf → bind to selected widget
  onEditSample: () => void;       // "Edit sample" opens textarea elsewhere
};

export function SchemaPanel({
  sampleJSON,
  usedKeys,
  selectedDataKey,
  onBind,
  onEditSample,
}: Props) {
  const [query, setQuery] = useState("");
  const { tree, paths, parseErr } = useMemo(() => {
    try {
      const data = JSON.parse(sampleJSON || "{}");
      return { tree: buildSchema(data), paths: collectPaths(data), parseErr: null as string | null };
    } catch (e: any) {
      return { tree: null as SchemaNode | null, paths: new Set<string>(), parseErr: e.message };
    }
  }, [sampleJSON]);

  const unknownKeys = useMemo(
    () => usedKeys.filter((k) => k && !keyExists(paths, k)),
    [usedKeys, paths]
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Data schema
        </span>
        <button
          type="button"
          onClick={onEditSample}
          className="text-[11px] text-primary hover:underline"
        >
          Edit sample
        </button>
      </div>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter keys…"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>
      {parseErr ? (
        <div className="mx-3 mb-2 flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          Sample data is not valid JSON.
        </div>
      ) : null}

      {unknownKeys.length > 0 && (
        <div className="mx-3 mb-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-700">
          <div className="font-medium">
            {unknownKeys.length} widget{unknownKeys.length === 1 ? "" : "s"} bound to missing keys
          </div>
          <ul className="mt-0.5 truncate">
            {unknownKeys.slice(0, 5).map((k) => (
              <li key={k} className="truncate font-mono text-[10px]">
                • {k}
              </li>
            ))}
            {unknownKeys.length > 5 && (
              <li className="font-mono text-[10px]">…and {unknownKeys.length - 5} more</li>
            )}
          </ul>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {tree ? (
          <ul className="space-y-0.5">
            {(tree.children || []).map((c) => (
              <TreeNode
                key={c.path}
                node={c}
                depth={0}
                query={query.toLowerCase()}
                selectedDataKey={selectedDataKey}
                onBind={onBind}
              />
            ))}
            {tree.children?.length === 0 && (
              <li className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                Sample is empty. Click <em>Edit sample</em>.
              </li>
            )}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function TreeNode({
  node,
  depth,
  query,
  selectedDataKey,
  onBind,
}: {
  node: SchemaNode;
  depth: number;
  query: string;
  selectedDataKey?: string;
  onBind: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = !!node.children && node.children.length > 0;
  const isMatch = !query || node.path.toLowerCase().includes(query);
  const isSelected = selectedDataKey === node.path;

  // If filtering, hide nodes that neither match nor have matching descendants.
  const childMatches = hasChildren &&
    (node.children || []).some((c) => subtreeMatches(c, query));
  if (query && !isMatch && !childMatches) return null;

  const label = node.path.split(".").pop() || "root";
  const Icon = iconFor(node.kind);

  return (
    <li style={{ paddingLeft: depth * 10 }}>
      <div
        className={cn(
          "group flex items-center gap-1 rounded px-1 py-0.5 text-xs",
          isSelected ? "bg-primary/15 text-primary" : "hover:bg-muted/60"
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="grid h-4 w-4 place-items-center text-muted-foreground"
          >
            {open ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : (
          <span className="h-4 w-4" />
        )}
        <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={() => onBind(node.path)}
          className="min-w-0 flex-1 truncate text-left font-mono"
          title={node.path}
        >
          {label}
        </button>
        {node.kind !== "object" && node.kind !== "array" && (
          <span className="max-w-[120px] truncate text-[10px] text-muted-foreground">
            {formatSample(node.sample)}
          </span>
        )}
      </div>
      {hasChildren && open && (
        <ul className="space-y-0.5">
          {(node.children || []).map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              query={query}
              selectedDataKey={selectedDataKey}
              onBind={onBind}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function subtreeMatches(n: SchemaNode, q: string): boolean {
  if (!q) return true;
  if (n.path.toLowerCase().includes(q)) return true;
  return (n.children || []).some((c) => subtreeMatches(c, q));
}

function iconFor(k: SchemaNode["kind"]) {
  switch (k) {
    case "object":
      return Braces;
    case "array":
      return List;
    case "number":
      return Hash;
    case "boolean":
      return ToggleLeft;
    default:
      return Type;
  }
}

function formatSample(v: any): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v.length > 16 ? `"${v.slice(0, 16)}…"` : `"${v}"`;
  return String(v);
}
