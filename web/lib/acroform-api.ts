// Client wrappers for Tier C AcroForm structure endpoints.
//
// The server takes a batch of patches and atomically:
//   1. Reopens the source PDF
//   2. Applies each patch (move, resize, rename, delete, add, prop change)
//   3. Writes the modified PDF back to storage
//   4. Re-extracts fields + bumps template version
//   5. Returns refreshed fields + a new preview URL

import { api } from "./api";
import type { AcroFormField, FieldRect } from "@/components/acroform/types";

// StructurePatch mirrors api/internal/generate/acroform/mutate.go StructurePatch.
export type StructurePatch =
  | UpdateRectPatch
  | RenamePatch
  | DeletePatch
  | AddTextPatch
  | UpdatePropsPatch;

export type UpdateRectPatch = {
  op: "update-rect";
  name: string;
  page: number;
  rect: FieldRect;
};

export type RenamePatch = {
  op: "rename";
  name: string;
  newName: string;
};

export type DeletePatch = {
  op: "delete";
  name: string;
};

export type AddTextPatch = {
  op: "add-text";
  name: string;
  page: number;
  rect: FieldRect;
  props?: PatchFieldProps;
};

export type UpdatePropsPatch = {
  op: "update-props";
  name: string;
  props: PatchFieldProps;
};

export type PatchFieldProps = {
  flags?: number;
  readOnly?: boolean;
  required?: boolean;
  multiline?: boolean;
  password?: boolean;
  maxLen?: number;
  tooltip?: string;
  default?: string;
  options?: string[];
  clearOptions?: boolean;
};

export type StructureResponse = {
  version: number;
  fields: AcroFormField[];
  previewUrl: string;
};

export async function applyStructurePatches(
  templateId: string,
  patches: StructurePatch[],
  expectedVersion?: number
): Promise<StructureResponse> {
  return api<StructureResponse>(`/v1/templates/${templateId}/acroform/structure`, {
    method: "PUT",
    body: JSON.stringify({ patches, expectedVersion }),
  });
}
