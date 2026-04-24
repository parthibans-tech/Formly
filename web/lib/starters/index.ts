import { invoiceStarter } from "./invoice";
import { receiptStarter } from "./receipt";
import { ndaStarter } from "./nda";
import { offerLetterStarter } from "./offer-letter";
import { certificateStarter } from "./certificate";
import { blankStarter } from "./blank";
import type { Starter, StarterCategory } from "./types";

export const STARTERS: Starter[] = [
  invoiceStarter,
  receiptStarter,
  offerLetterStarter,
  ndaStarter,
  certificateStarter,
];

// Shown separately in the dialog header as a "fresh start" option.
export const BLANK_STARTER: Starter = blankStarter;

export const STARTER_CATEGORIES: StarterCategory[] = [
  "Billing",
  "Legal",
  "HR",
  "Certificates",
  "Commerce",
];

export type { Starter, StarterCategory };
export { getStarterDoc } from "./to-doc";
export type { StarterDocResult } from "./to-doc";
