"use client";
// Backward-compatible shim over the shadcn toast system.
// Existing call sites `useToast().show("success" | "error" | "info", text)` continue to work.

import { toast as shadcnToast } from "@/hooks/use-toast";

type Kind = "success" | "error" | "info";

const kindToVariant = {
  success: "success",
  error: "destructive",
  info: "info",
} as const;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function useToast() {
  return {
    show(kind: Kind, text: string, opts?: { description?: string }) {
      shadcnToast({
        variant: kindToVariant[kind],
        title: text,
        description: opts?.description,
      });
    },
  };
}
