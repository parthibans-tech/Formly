import { api } from "@/lib/api";

export type FormFieldType =
  | "text"
  | "multiline"
  | "date"
  | "number"
  | "currency"
  | "checkbox"
  | "dropdown"
  | "radio";

export type FormField = {
  id: string; // local client id (not persisted)
  name: string;
  label: string;
  type: FormFieldType;
  options?: string[];
  required?: boolean;
};

export type CreateFormOpts = {
  name: string;
  title?: string;
  subtitle?: string;
  pageSize?: "Letter" | "A4" | "Legal" | "A3" | "A5";
  orientation?: "portrait" | "landscape";
  fields: FormField[];
  folderId?: string;
};

// Creates a form PDF with labels + input boxes auto-laid-out on the page, plus
// matching static-mode widgets so every field is mapped on arrival in the
// designer.
export async function createFormTemplate(
  opts: CreateFormOpts
): Promise<{ fileId: string; templateId: string }> {
  return api<{ fileId: string; templateId: string }>(
    "/v1/templates/form-builder",
    {
      method: "POST",
      body: JSON.stringify({
        name: opts.name,
        title: opts.title,
        subtitle: opts.subtitle,
        pageSize: opts.pageSize ?? "Letter",
        orientation: opts.orientation ?? "portrait",
        folderId: opts.folderId,
        fields: opts.fields.map((f) => ({
          name: f.name.trim(),
          label: f.label.trim(),
          type: f.type,
          options: f.options?.map((o) => o.trim()).filter(Boolean),
          required: !!f.required,
        })),
      }),
    }
  );
}
