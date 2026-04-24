"use client";

// AcroForm interactive-field section for the right inspector.
// Rendered below the standard property panels when a widget type that maps
// to a PDF AcroForm field is selected.
//
// Tier A: Required/ReadOnly/NoExport, Tooltip, MaxLen+Comb, Format picker,
//         Radio group, Dropdown options, Tab order.
// Tier B: Signature field lock, Push-button actions, Appearance streams
//         (acroBgColor / acroBorderColor / acroBorderWidth / acroBorderStyle),
//         Calculated fields (acroCalcOp / acroCalcFields / acroCalcScript),
//         Validation script (acroValidateScript).

import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import {
  type AcroFormat,
  type AcroOption,
  type AcroCalcOp,
  type AcroBorderStyle,
  type AcroButtonAction,
  ACRO_FORMAT_LABELS,
  DATE_FORMAT_PRESETS,
  ACRO_CALC_OP_LABELS,
  ACRO_BORDER_STYLE_LABELS,
  ACRO_BUTTON_ACTION_LABELS,
} from "@/lib/acroform-types";
import { cn } from "@/lib/utils";

type AvailableField = { id: string; dataKey: string; type: string };

type Props = {
  type: string;
  props: Record<string, any>;
  onChange: (key: string, value: any) => void;
  /** Other widgets on the canvas — used to populate the calc source picker. */
  allWidgets?: AvailableField[];
};

export function AcroFormPanel({ type, props, onChange, allWidgets = [] }: Props) {
  const [open, setOpen] = useState(false);

  const isText = ["text", "multiline", "number", "currency", "date"].includes(type);
  const isCalcCapable = ["text", "number", "currency"].includes(type);
  const isValidateCapable = ["text", "multiline", "number", "currency", "date"].includes(type);
  const isRadio = type === "radio";
  const isDropdown = type === "dropdown";
  const isSigField = type === "signature-field";
  const isButton = type === "button";

  // Candidate source fields for calculations: text/number/currency widgets on canvas.
  const calcCandidates = allWidgets.filter((w) =>
    ["text", "number", "currency"].includes(w.type)
  );

  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Interactive field (AcroForm)
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t px-3 pb-3 pt-2">

          {/* ── Flags (all non-button types) ─────────────────────────────── */}
          {!isButton && (
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={!!props.acroRequired}
                  onChange={(e) => onChange("acroRequired", e.target.checked)}
                />
                Required field
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={!!props.acroReadOnly}
                  onChange={(e) => onChange("acroReadOnly", e.target.checked)}
                />
                Read only
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={!!props.acroNoExport}
                  onChange={(e) => onChange("acroNoExport", e.target.checked)}
                />
                No export (exclude from form data)
              </label>
            </div>
          )}

          {/* ── Tooltip (/TU) ────────────────────────────────────────────── */}
          <AcroRow label="Tooltip (/TU)">
            <input
              className="w-full rounded border px-2 py-1 text-xs"
              value={(props.acroTooltip as string) || ""}
              onChange={(e) => onChange("acroTooltip", e.target.value)}
              placeholder="Hover text shown in PDF viewers"
            />
          </AcroRow>

          {/* ── Text-field extras ─────────────────────────────────────────── */}
          {isText && (
            <>
              <AcroRow label="Max length">
                <input
                  type="number"
                  min={0}
                  className="w-full rounded border px-2 py-1 text-xs"
                  value={props.acroMaxLen != null ? String(props.acroMaxLen) : ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : parseInt(e.target.value, 10);
                    onChange("acroMaxLen", v);
                  }}
                  placeholder="Unlimited"
                />
              </AcroRow>

              {type === "text" && props.acroMaxLen != null && props.acroMaxLen > 0 && (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={!!props.acroComb}
                    onChange={(e) => onChange("acroComb", e.target.checked)}
                  />
                  Comb (divide into equal cells)
                </label>
              )}

              <AcroRow label="Format">
                <select
                  className="w-full rounded border px-2 py-1 text-xs"
                  value={(props.acroFormat as string) || "none"}
                  onChange={(e) => {
                    onChange("acroFormat", e.target.value as AcroFormat);
                    if (e.target.value !== "number") onChange("acroDecimals", null);
                    if (e.target.value !== "date") onChange("acroDateFmt", null);
                  }}
                >
                  {(Object.entries(ACRO_FORMAT_LABELS) as [AcroFormat, string][]).map(
                    ([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    )
                  )}
                </select>
              </AcroRow>

              {(props.acroFormat === "number" ||
                props.acroFormat === "currency" ||
                props.acroFormat === "percent") && (
                <AcroRow label="Decimal places">
                  <input
                    type="number"
                    min={0}
                    max={10}
                    className="w-full rounded border px-2 py-1 text-xs"
                    value={props.acroDecimals != null ? String(props.acroDecimals) : "2"}
                    onChange={(e) =>
                      onChange("acroDecimals", parseInt(e.target.value, 10))
                    }
                  />
                </AcroRow>
              )}

              {props.acroFormat === "date" && (
                <AcroRow label="Date format">
                  <select
                    className="w-full rounded border px-2 py-1 text-xs"
                    value={(props.acroDateFmt as string) || "mm/dd/yyyy"}
                    onChange={(e) => onChange("acroDateFmt", e.target.value)}
                  >
                    {DATE_FORMAT_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </AcroRow>
              )}
            </>
          )}

          {/* ── Radio group ──────────────────────────────────────────────── */}
          {isRadio && (
            <>
              <AcroRow label="Group name">
                <input
                  className="w-full rounded border px-2 py-1 font-mono text-xs"
                  value={(props.acroGroupName as string) || ""}
                  onChange={(e) => onChange("acroGroupName", e.target.value)}
                  placeholder="e.g. gender"
                />
              </AcroRow>
              <AcroRow label="Export value">
                <input
                  className="w-full rounded border px-2 py-1 font-mono text-xs"
                  value={(props.acroExportValue as string) || ""}
                  onChange={(e) => onChange("acroExportValue", e.target.value)}
                  placeholder="e.g. male"
                />
              </AcroRow>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={!!props.acroCheckedByDefault}
                  onChange={(e) => onChange("acroCheckedByDefault", e.target.checked)}
                />
                Checked by default
              </label>
              <p className="text-[10px] text-muted-foreground">
                All radio buttons sharing the same <strong>Group name</strong> form
                one mutually-exclusive group in the PDF.
              </p>
            </>
          )}

          {/* ── Dropdown options ─────────────────────────────────────────── */}
          {isDropdown && (
            <>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={!!props.acroEditable}
                  onChange={(e) => onChange("acroEditable", e.target.checked)}
                />
                Editable (free text allowed)
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={!!props.acroMultiSelect}
                  onChange={(e) => onChange("acroMultiSelect", e.target.checked)}
                />
                Multi-select
              </label>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold text-muted-foreground">
                    Options
                  </span>
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-muted/60"
                    onClick={() => {
                      const opts: AcroOption[] = Array.isArray(props.acroOptions)
                        ? [...props.acroOptions]
                        : [];
                      opts.push({ label: "", value: "" });
                      onChange("acroOptions", opts);
                    }}
                  >
                    <Plus className="h-3 w-3" />
                    Add option
                  </button>
                </div>
                <OptionsEditor
                  options={
                    Array.isArray(props.acroOptions)
                      ? (props.acroOptions as AcroOption[])
                      : []
                  }
                  onChange={(opts) => onChange("acroOptions", opts)}
                />
              </div>
            </>
          )}

          {/* ── Signature field ──────────────────────────────────────────── */}
          {isSigField && (
            <>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={!!props.acroLockAfterSign}
                  onChange={(e) => onChange("acroLockAfterSign", e.target.checked)}
                />
                Lock all fields after signing
              </label>
              <p className="text-[10px] text-muted-foreground">
                Creates a PDF digital signature placeholder. The signer uses a PDF
                viewer to apply their certificate or drawn signature.
              </p>
            </>
          )}

          {/* ── Push button ──────────────────────────────────────────────── */}
          {isButton && (
            <>
              <AcroRow label="Button label">
                <input
                  className="w-full rounded border px-2 py-1 text-xs"
                  value={(props.acroButtonLabel as string) || ""}
                  onChange={(e) => onChange("acroButtonLabel", e.target.value)}
                  placeholder="Button"
                />
              </AcroRow>
              <AcroRow label="Action">
                <select
                  className="w-full rounded border px-2 py-1 text-xs"
                  value={(props.acroButtonAction as string) || "none"}
                  onChange={(e) => {
                    onChange("acroButtonAction", e.target.value as AcroButtonAction);
                    if (e.target.value !== "submit") onChange("acroSubmitUrl", "");
                    if (e.target.value !== "js") onChange("acroJsAction", "");
                  }}
                >
                  {(Object.entries(ACRO_BUTTON_ACTION_LABELS) as [AcroButtonAction, string][]).map(
                    ([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    )
                  )}
                </select>
              </AcroRow>

              {props.acroButtonAction === "submit" && (
                <AcroRow label="Submit URL">
                  <input
                    className="w-full rounded border px-2 py-1 font-mono text-xs"
                    value={(props.acroSubmitUrl as string) || ""}
                    onChange={(e) => onChange("acroSubmitUrl", e.target.value)}
                    placeholder="https://example.com/form"
                  />
                </AcroRow>
              )}

              {props.acroButtonAction === "js" && (
                <AcroRow label="JavaScript">
                  <textarea
                    className="w-full rounded border px-2 py-1 font-mono text-xs"
                    rows={4}
                    value={(props.acroJsAction as string) || ""}
                    onChange={(e) => onChange("acroJsAction", e.target.value)}
                    placeholder={`app.alert("Hello!");`}
                    spellCheck={false}
                  />
                </AcroRow>
              )}
            </>
          )}

          {/* ── Appearance (PDF viewer) ────────────────────────────────────
              acroBgColor / acroBorderColor → /MK /BG, /BC
              acroBorderWidth / acroBorderStyle → /BS /W, /S
              These control how the field looks inside interactive PDF viewers
              and are separate from the static overlay background/border.       */}
          <SectionHeader label="Appearance (PDF viewer)" />
          <div className="grid grid-cols-2 gap-2">
            <AcroRow label="Background">
              <div className="flex items-center gap-1">
                <input
                  type="color"
                  className="h-7 w-8 rounded border p-0.5"
                  value={(props.acroBgColor as string) || "#ffffff"}
                  onChange={(e) => onChange("acroBgColor", e.target.value)}
                />
                <button
                  type="button"
                  className="text-[9px] text-muted-foreground hover:text-foreground"
                  onClick={() => onChange("acroBgColor", "")}
                  title="Clear (transparent)"
                >
                  ✕
                </button>
              </div>
            </AcroRow>
            <AcroRow label="Border color">
              <div className="flex items-center gap-1">
                <input
                  type="color"
                  className="h-7 w-8 rounded border p-0.5"
                  value={(props.acroBorderColor as string) || "#000000"}
                  onChange={(e) => onChange("acroBorderColor", e.target.value)}
                />
                <button
                  type="button"
                  className="text-[9px] text-muted-foreground hover:text-foreground"
                  onClick={() => onChange("acroBorderColor", "")}
                  title="Clear"
                >
                  ✕
                </button>
              </div>
            </AcroRow>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <AcroRow label="Border width">
              <input
                type="number"
                min={0}
                step={0.5}
                className="w-full rounded border px-2 py-1 text-xs"
                value={props.acroBorderWidth != null ? String(props.acroBorderWidth) : ""}
                onChange={(e) => {
                  const v = e.target.value === "" ? null : parseFloat(e.target.value);
                  onChange("acroBorderWidth", v);
                }}
                placeholder="None"
              />
            </AcroRow>
            <AcroRow label="Border style">
              <select
                className="w-full rounded border px-2 py-1 text-xs"
                value={(props.acroBorderStyle as string) || ""}
                onChange={(e) =>
                  onChange("acroBorderStyle", e.target.value as AcroBorderStyle || null)
                }
              >
                <option value="">— none —</option>
                {(Object.entries(ACRO_BORDER_STYLE_LABELS) as [AcroBorderStyle, string][]).map(
                  ([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  )
                )}
              </select>
            </AcroRow>
          </div>

          {/* ── Calculated field ─────────────────────────────────────────── */}
          {isCalcCapable && (
            <>
              <SectionHeader label="Calculation" />
              <AcroRow label="Operation">
                <select
                  className="w-full rounded border px-2 py-1 text-xs"
                  value={(props.acroCalcOp as string) || "none"}
                  onChange={(e) => {
                    onChange("acroCalcOp", e.target.value as AcroCalcOp);
                    if (e.target.value !== "custom") onChange("acroCalcScript", "");
                    if (e.target.value === "none") onChange("acroCalcFields", []);
                  }}
                >
                  {(Object.entries(ACRO_CALC_OP_LABELS) as [AcroCalcOp, string][]).map(
                    ([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    )
                  )}
                </select>
              </AcroRow>

              {props.acroCalcOp && props.acroCalcOp !== "none" && props.acroCalcOp !== "custom" && (
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground">
                    Source fields
                  </label>
                  {calcCandidates.length === 0 ? (
                    <p className="text-[10px] text-muted-foreground">
                      No text/number/currency fields on canvas yet.
                    </p>
                  ) : (
                    <div className="max-h-32 space-y-1 overflow-y-auto rounded border p-1.5">
                      {calcCandidates.map((w) => {
                        const selected = Array.isArray(props.acroCalcFields)
                          ? (props.acroCalcFields as string[]).includes(w.dataKey)
                          : false;
                        return (
                          <label key={w.id} className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={(e) => {
                                const current: string[] = Array.isArray(props.acroCalcFields)
                                  ? [...(props.acroCalcFields as string[])]
                                  : [];
                                const next = e.target.checked
                                  ? [...new Set([...current, w.dataKey])]
                                  : current.filter((v) => v !== w.dataKey);
                                onChange("acroCalcFields", next);
                              }}
                            />
                            <span className="font-mono">{w.dataKey}</span>
                            <span className="text-muted-foreground">({w.type})</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {props.acroCalcOp === "custom" && (
                <AcroRow label="Calculate script">
                  <textarea
                    className="w-full rounded border px-2 py-1 font-mono text-xs"
                    rows={4}
                    value={(props.acroCalcScript as string) || ""}
                    onChange={(e) => onChange("acroCalcScript", e.target.value)}
                    placeholder={`event.value = this.getField("qty").value * this.getField("price").value;`}
                    spellCheck={false}
                  />
                </AcroRow>
              )}

              {props.acroCalcOp && props.acroCalcOp !== "none" && (
                <p className="text-[10px] text-muted-foreground">
                  This field recalculates automatically when source fields change.
                  Calculation order follows the Tab order panel.
                </p>
              )}
            </>
          )}

          {/* ── Validation script ────────────────────────────────────────── */}
          {isValidateCapable && (
            <>
              <SectionHeader label="Validation" />
              <AcroRow label="Validate script (JS)">
                <div className="space-y-1">
                  <div className="flex flex-wrap gap-1">
                    {VALIDATE_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        className="rounded bg-muted/60 px-1.5 py-0.5 text-[9px] hover:bg-muted"
                        onClick={() => onChange("acroValidateScript", p.script)}
                      >
                        {p.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="rounded bg-muted/60 px-1.5 py-0.5 text-[9px] text-destructive hover:bg-muted"
                      onClick={() => onChange("acroValidateScript", "")}
                    >
                      Clear
                    </button>
                  </div>
                  <textarea
                    className="w-full rounded border px-2 py-1 font-mono text-xs"
                    rows={4}
                    value={(props.acroValidateScript as string) || ""}
                    onChange={(e) => onChange("acroValidateScript", e.target.value)}
                    placeholder={`// event.rc = false to reject\nif (event.value < 0) {\n  app.alert("Must be positive");\n  event.rc = false;\n}`}
                    spellCheck={false}
                  />
                </div>
              </AcroRow>
            </>
          )}

          {/* ── Tab order ────────────────────────────────────────────────── */}
          <AcroRow label="Tab order (1 = first)">
            <input
              type="number"
              min={1}
              className="w-full rounded border px-2 py-1 text-xs"
              value={props.acroTabOrder != null ? String(props.acroTabOrder) : ""}
              onChange={(e) => {
                const v = e.target.value === "" ? null : parseInt(e.target.value, 10);
                onChange("acroTabOrder", v);
              }}
              placeholder="Auto"
            />
          </AcroRow>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation presets
// ---------------------------------------------------------------------------

const VALIDATE_PRESETS: { label: string; script: string }[] = [
  {
    label: "> 0",
    script: `if (event.value !== "" && Number(event.value) <= 0) {\n  app.alert("Value must be greater than 0.");\n  event.rc = false;\n}`,
  },
  {
    label: "≥ 0",
    script: `if (event.value !== "" && Number(event.value) < 0) {\n  app.alert("Value must be 0 or greater.");\n  event.rc = false;\n}`,
  },
  {
    label: "Non-empty",
    script: `if (event.value.trim() === "") {\n  app.alert("This field cannot be blank.");\n  event.rc = false;\n}`,
  },
  {
    label: "Email",
    script: `if (event.value !== "" && !/^[^@]+@[^@]+\\.[^@]+$/.test(event.value)) {\n  app.alert("Please enter a valid email address.");\n  event.rc = false;\n}`,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {label}
    </div>
  );
}

function AcroRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <label className="text-[10px] text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function OptionsEditor({
  options,
  onChange,
}: {
  options: AcroOption[];
  onChange: (opts: AcroOption[]) => void;
}) {
  if (options.length === 0) {
    return (
      <p className="text-[10px] text-muted-foreground">No options yet. Click Add option.</p>
    );
  }
  return (
    <div className="space-y-1">
      {options.map((opt, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            className="flex-1 rounded border px-2 py-0.5 text-xs"
            placeholder="Label"
            value={opt.label}
            onChange={(e) => {
              const next = options.map((o, j) =>
                j === i ? { ...o, label: e.target.value } : o
              );
              onChange(next);
            }}
          />
          <input
            className="w-20 rounded border px-2 py-0.5 font-mono text-xs"
            placeholder="Value"
            value={opt.value}
            onChange={(e) => {
              const next = options.map((o, j) =>
                j === i ? { ...o, value: e.target.value } : o
              );
              onChange(next);
            }}
          />
          <button
            type="button"
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-destructive"
            onClick={() => onChange(options.filter((_, j) => j !== i))}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
