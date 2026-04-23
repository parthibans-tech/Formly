"use client";

import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";
import { buttonVariants } from "./button";
import { cn } from "@/lib/utils";

type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type ConfirmContextValue = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<{
    open: boolean;
    opts: ConfirmOptions | null;
    resolve: ((v: boolean) => void) | null;
  }>({ open: false, opts: null, resolve: null });

  const confirm = React.useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ open: true, opts, resolve });
      }),
    []
  );

  const close = (result: boolean) => {
    state.resolve?.(result);
    setState((s) => ({ ...s, open: false }));
  };

  const opts = state.opts;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={state.open}
        onOpenChange={(open) => {
          if (!open) close(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
            {opts?.description && (
              <AlertDialogDescription>{opts.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => close(false)}>
              {opts?.cancelLabel ?? "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                opts?.destructive &&
                  buttonVariants({ variant: "destructive" })
              )}
              onClick={() => close(true)}
            >
              {opts?.confirmLabel ?? "Continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}
