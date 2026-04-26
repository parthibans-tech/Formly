"use client";

// VaultUnlockProvider — top-level <Provider> that owns the re-auth modal
// for "locked folders". When any api() call returns 423, lib/api transfers
// control here: the modal opens, the user confirms password (+ MFA if
// enrolled), and a fresh /v1/vault/unlock issues a 5-minute server-side
// session. The original request retries automatically once unlock
// succeeds; if the user cancels, the underlying request fails with
// vault_locked and the calling page can show its own message.
//
// Mounted once in app/layout.tsx. Pages don't need to know it exists —
// they just call api() like normal and the UX falls out automatically.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { api, setVaultUnlocker } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type VaultStatus = {
  unlocked: boolean;
  expiresAt?: string;
  mfaRequired?: boolean;
  ttlSeconds?: number;
};

type Ctx = {
  status: VaultStatus;
  refresh: () => Promise<void>;
  // Imperative open — used by the "Lock folder" UI when it wants to
  // proactively prompt (e.g. user clicked a folder we already know is
  // locked, before the API has a chance to 423).
  promptUnlock: () => Promise<boolean>;
  lockNow: () => Promise<void>;
};

const VaultCtx = createContext<Ctx | null>(null);

export function useVault() {
  const ctx = useContext(VaultCtx);
  if (!ctx) {
    // Sane defaults so components on pages outside the provider (login,
    // public form view) don't crash if they accidentally call useVault.
    return {
      status: { unlocked: false },
      refresh: async () => {},
      promptUnlock: async () => false,
      lockNow: async () => {},
    } as Ctx;
  }
  return ctx;
}

export function VaultUnlockProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<VaultStatus>({ unlocked: false });

  // The promise that lib/api is awaiting. When the user confirms or
  // cancels the modal, we resolve(true|false) so the original request
  // can retry (or surrender). A ref because resolvers must survive
  // re-renders.
  const pendingResolve = useRef<((ok: boolean) => void) | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<VaultStatus>("/v1/vault/status");
      setStatus(s);
    } catch {
      // Don't break the app if status is unreachable — treat as locked.
      setStatus({ unlocked: false });
    }
  }, []);

  // Imperative entry point: returns a promise that resolves true after
  // a successful unlock, false on cancel. Used by the api wrapper for
  // 423 retries and by the sidebar lock button for proactive prompts.
  const promptUnlock = useCallback(() => {
    return new Promise<boolean>((resolve) => {
      pendingResolve.current = resolve;
      setOpen(true);
    });
  }, []);

  const lockNow = useCallback(async () => {
    try {
      await api("/v1/vault/lock", { method: "POST" });
    } finally {
      setStatus({ unlocked: false });
    }
  }, []);

  // Wire into lib/api so 423 responses pop the modal automatically.
  // Cleanup on unmount (e.g. logout → layout re-mount) clears the hook.
  useEffect(() => {
    setVaultUnlocker(promptUnlock);
    return () => setVaultUnlocker(null);
  }, [promptUnlock]);

  // Refresh status on mount so the lock chip is accurate immediately.
  useEffect(() => {
    refresh();
  }, [refresh]);

  function handleClose(ok: boolean) {
    setOpen(false);
    const r = pendingResolve.current;
    pendingResolve.current = null;
    if (r) r(ok);
  }

  const value = useMemo<Ctx>(
    () => ({ status, refresh, promptUnlock, lockNow }),
    [status, refresh, promptUnlock, lockNow]
  );

  return (
    <VaultCtx.Provider value={value}>
      {children}
      <UnlockModal
        open={open}
        mfaRequired={!!status.mfaRequired}
        onResolve={handleClose}
        onUnlocked={refresh}
      />
    </VaultCtx.Provider>
  );
}

function UnlockModal({
  open,
  mfaRequired,
  onResolve,
  onUnlocked,
}: {
  open: boolean;
  mfaRequired: boolean;
  onResolve: (ok: boolean) => void;
  onUnlocked: () => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset on every open so a previous wrong password doesn't linger.
  useEffect(() => {
    if (open) {
      setPassword("");
      setMfaCode("");
      setErr(null);
    }
  }, [open]);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      await api("/v1/vault/unlock", {
        method: "POST",
        body: JSON.stringify({
          password,
          mfaCode: mfaCode || undefined,
        }),
      });
      await onUnlocked();
      onResolve(true);
    } catch (e: any) {
      setErr(e?.message || "Unable to unlock");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !submitting) onResolve(false);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-2 inline-flex w-fit items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <ShieldCheck className="h-3.5 w-3.5" />
            Locked folder
          </div>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            Confirm it&apos;s you
          </DialogTitle>
          <DialogDescription>
            Re-enter your password
            {mfaRequired ? " and a 2FA code" : ""} to unlock for the next
            5&nbsp;minutes. We&apos;ll lock again automatically.
          </DialogDescription>
        </DialogHeader>
        {/*
          Privacy disclosure. We can't actually block screen-sharing or
          OS-level screenshots from a browser tab, so the honest framing
          is: "you're being watched, attempts are logged." The shield
          (vault-privacy-shield.tsx) blurs on tab-hide / focus-loss and
          beacons every PrintScreen / copy attempt to the audit log.
          Showing this here gives the user one explicit acknowledgement
          per session.
        */}
        <div
          role="note"
          className="rounded-md border border-amber-200/60 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
        >
          Files in this folder are confidential. While unlocked, we hide
          the view if your tab loses focus and log every screenshot,
          copy, and right-click attempt. Screen recordings made by other
          apps cannot be blocked from a browser — please keep the tab
          private.
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label htmlFor="vault-password">Password</Label>
            <Input
              id="vault-password"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1"
              disabled={submitting}
            />
          </div>
          {mfaRequired && (
            <div>
              <Label htmlFor="vault-mfa">2FA code</Label>
              <Input
                id="vault-mfa"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                className="mt-1 font-mono tracking-widest"
                placeholder="123456"
                maxLength={16}
                disabled={submitting}
              />
            </div>
          )}
          {err && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {err}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onResolve(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={submitting}
              disabled={!password || (mfaRequired && mfaCode.length < 6)}
            >
              <Lock className="h-4 w-4" />
              Unlock
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
