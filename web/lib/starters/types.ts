export type StarterCategory =
  | "Billing"
  | "Legal"
  | "HR"
  | "Certificates"
  | "Commerce";

export type Starter = {
  id: string;
  name: string;
  description: string;
  category: StarterCategory;
  tags: string[];
  html: string;
  sampleData: Record<string, unknown>;
};
