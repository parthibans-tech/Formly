"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";

type PromptOptions = {
  title: string;
  description?: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  validate?: (v: string) => string | null;
};

type PromptContextValue = (opts: PromptOptions) => Promise<string | null>;

const PromptContext = React.createContext<PromptContextValue | null>(null);

export function PromptProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<{
    open: boolean;
    opts: PromptOptions | null;
    resolve: ((v: string | null) => void) | null;
  }>({ open: false, opts: null, resolve: null });
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const prompt = React.useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(opts.defaultValue ?? "");
        setError(null);
        setState({ open: true, opts, resolve });
      }),
    []
  );

  const close = (result: string | null) => {
    state.resolve?.(result);
    setState((s) => ({ ...s, open: false }));
  };

  const submit = () => {
    const opts = state.opts;
    if (opts?.validate) {
      const err = opts.validate(value);
      if (err) {
        setError(err);
        return;
      }
    }
    close(value);
  };

  const opts = state.opts;

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      <Dialog
        open={state.open}
        onOpenChange={(open) => {
          if (!open) close(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{opts?.title}</DialogTitle>
            {opts?.description && (
              <DialogDescription>{opts.description}</DialogDescription>
            )}
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="space-y-2"
          >
            {opts?.label && <Label htmlFor="prompt-input">{opts.label}</Label>}
            <Input
              id="prompt-input"
              autoFocus
              placeholder={opts?.placeholder}
              value={value}
              error={!!error}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
            />
            {error && <p className="text-xs font-medium text-destructive">{error}</p>}
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(null)}>
              {opts?.cancelLabel ?? "Cancel"}
            </Button>
            <Button onClick={submit}>{opts?.confirmLabel ?? "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PromptContext.Provider>
  );
}

export function usePrompt() {
  const ctx = React.useContext(PromptContext);
  if (!ctx) throw new Error("usePrompt must be used inside <PromptProvider>");
  return ctx;
}
