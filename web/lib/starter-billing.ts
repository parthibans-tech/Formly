// Typed wrappers for /v1/starters/billing/* — invoice/quote/PO arithmetic
// + the two AI helpers (line-item extraction, payment-reminder draft).
// Field shapes mirror the Go DTOs in internal/starterbilling verbatim.

import { api } from "./api";

// -- recalc ---------------------------------------------------------------

export interface RecalcItem {
  description?: string;
  qty: number;
  unitPrice: number;
}

export interface RecalcTax {
  rate: number; // 0..1
  label?: string;
}

export interface RecalcDiscount {
  rate?: number; // 0..1
  flat?: number;
}

export interface RecalcRequest {
  starterId?: string;
  items: RecalcItem[];
  tax?: RecalcTax;
  discount?: RecalcDiscount;
  currency?: string;
  precision?: number; // default 2
}

export interface RecalcResponse {
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  currency?: string;
  taxLabel?: string;
}

export function recalcBilling(body: RecalcRequest): Promise<RecalcResponse> {
  return api<RecalcResponse>("/v1/starters/billing/recalc", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// -- AI: line items -------------------------------------------------------

export interface LineItemsRequest {
  starterId?: string;
  description: string;
  currency?: string;
}

export interface LineItemsResponse {
  items: RecalcItem[];
  provider: string;
  model?: string;
}

export function extractLineItems(
  body: LineItemsRequest,
): Promise<LineItemsResponse> {
  return api<LineItemsResponse>("/v1/starters/billing/ai/line-items", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// -- AI: payment reminder -------------------------------------------------

export type PaymentReminderTone = "polite" | "firm" | "final";

export interface PaymentReminderRequest {
  starterId?: string;
  data: Record<string, unknown>;
  daysPastDue: number;
  tone?: PaymentReminderTone;
}

export interface PaymentReminderResponse {
  subject: string;
  body: string;
  provider: string;
  model?: string;
}

export function draftPaymentReminder(
  body: PaymentReminderRequest,
): Promise<PaymentReminderResponse> {
  return api<PaymentReminderResponse>(
    "/v1/starters/billing/ai/payment-reminder",
    { method: "POST", body: JSON.stringify(body) },
  );
}
