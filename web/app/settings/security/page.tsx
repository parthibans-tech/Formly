"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Laptop,
  LogOut,
  ShieldCheck,
  ShieldOff,
  Smartphone,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/ui/confirm";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

/* ---------- Types ---------- */

type MFAStatus = { enabled: boolean; verified: boolean };
type EnrollResp = {
  secret: string;
  otpauthUrl: string;
  accountName: string;
  issuer: string;
};
type Session = {
  id: string;
  ip?: string;
  userAgent?: string;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
};

/* ---------- Page ---------- */

export default function SecuritySettingsPage() {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
        <p className="text-sm text-muted-foreground">
          Manage two-factor authentication, active sessions, and account
          password.
        </p>
      </div>
      <MFASection />
      <SessionsSection />
    </>
  );
}

/* ---------- MFA section ---------- */

function MFASection() {
  const toast = useToast();
  const [status, setStatus] = useState<MFAStatus | null>(null);
  const [enroll, setEnroll] = useState<EnrollResp | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api<MFAStatus>("/v1/mfa/status");
      setStatus(s);
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Generate a QR data-URL whenever we receive a fresh enroll response.
  useEffect(() => {
    if (!enroll) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(enroll.otpauthUrl, { margin: 1, width: 220 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [enroll]);

  async function beginEnroll() {
    setBusy(true);
    try {
      const r = await api<EnrollResp>("/v1/mfa/enroll", { method: "POST" });
      setEnroll(r);
      setRecovery(null);
      setCode("");
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll() {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ verified: boolean; recoveryCodes?: string[] }>(
        "/v1/mfa/verify",
        { method: "POST", body: JSON.stringify({ code: code.trim() }) }
      );
      if (r.verified) {
        toast.show("success", "Two-factor authentication enabled");
        setRecovery(r.recoveryCodes ?? []);
        setEnroll(null);
        await load();
      }
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    const c = prompt("Enter your current 6-digit code (or a recovery code) to disable 2FA");
    if (!c) return;
    setBusy(true);
    try {
      await api("/v1/mfa/disable", {
        method: "POST",
        body: JSON.stringify({ code: c.trim() }),
      });
      toast.show("success", "Two-factor authentication disabled");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setBusy(false);
    }
  }

  if (status === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Two-factor authentication</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-48" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Two-factor authentication</CardTitle>
          {status.verified ? (
            <Badge
              variant="secondary"
              className="bg-success/10 text-success"
            >
              <ShieldCheck className="mr-1 h-3 w-3" />
              Enabled
            </Badge>
          ) : (
            <Badge
              variant="secondary"
              className="bg-muted text-muted-foreground"
            >
              <ShieldOff className="mr-1 h-3 w-3" />
              Disabled
            </Badge>
          )}
        </div>
        <CardDescription>
          Add a second factor to protect your account even if your password is
          compromised. Use any TOTP app — Google Authenticator, 1Password,
          Authy.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.verified && !enroll && (
          <div className="flex items-center gap-3 rounded-md border bg-success/5 p-3 text-sm">
            <ShieldCheck className="h-5 w-5 text-success" />
            Your account is protected by two-factor authentication.
          </div>
        )}
        {!status.verified && !enroll && (
          <div className="flex items-center gap-3 rounded-md border bg-warning/5 p-3 text-sm">
            <AlertTriangle className="h-5 w-5 text-warning" />
            We strongly recommend enabling 2FA for every admin account.
          </div>
        )}

        {enroll && (
          <div className="space-y-4 rounded-md border bg-muted/30 p-4">
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              <div className="grid h-56 w-56 shrink-0 place-items-center rounded-md border bg-background p-2">
                {qrDataUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={qrDataUrl} alt="2FA QR code" className="h-full w-full" />
                ) : (
                  <Skeleton className="h-full w-full" />
                )}
              </div>
              <div className="flex-1 space-y-3">
                <div>
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                    1. Scan with your authenticator
                  </Label>
                  <p className="mt-1 text-sm">
                    Open your TOTP app and scan the QR code. Can&apos;t scan?
                    Enter this secret manually:
                  </p>
                  <div className="mt-2 flex items-center gap-1">
                    <code className="flex-1 truncate rounded bg-background px-2 py-1 font-mono text-xs">
                      {enroll.secret}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => {
                        navigator.clipboard.writeText(enroll.secret);
                        toast.show("success", "Secret copied");
                      }}
                      aria-label="Copy secret"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div>
                  <Label
                    htmlFor="mfa-code"
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    2. Enter the 6-digit code
                  </Label>
                  <Input
                    id="mfa-code"
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    placeholder="123456"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    className="mt-1 w-32 font-mono tracking-widest"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {recovery && (
          <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
            <div className="flex items-center gap-2 font-semibold">
              <KeyRound className="h-4 w-4 text-amber-600" />
              Save your recovery codes
            </div>
            <p className="text-muted-foreground">
              Each code can be used once to sign in if you lose your device.
              Store them somewhere safe — you won&apos;t see them again.
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {recovery.map((rc) => (
                <code
                  key={rc}
                  className="rounded bg-background px-2 py-1 text-center font-mono text-xs"
                >
                  {rc}
                </code>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(recovery.join("\n"));
                toast.show("success", "Recovery codes copied");
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              Copy all
            </Button>
          </div>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        {enroll ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setEnroll(null);
                setCode("");
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmEnroll}
              loading={busy}
              disabled={code.length !== 6}
            >
              <Check className="h-4 w-4" />
              Confirm & enable
            </Button>
          </>
        ) : status.verified ? (
          <Button
            variant="outline"
            onClick={disable}
            loading={busy}
            className="text-destructive hover:text-destructive"
          >
            <ShieldOff className="h-4 w-4" />
            Disable 2FA
          </Button>
        ) : (
          <Button onClick={beginEnroll} loading={busy}>
            <Smartphone className="h-4 w-4" />
            Set up 2FA
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

/* ---------- Sessions section ---------- */

function SessionsSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ sessions: Session[] }>("/v1/sessions");
      setSessions(r.sessions);
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function revoke(s: Session) {
    if (s.current) {
      toast.show("error", "Can't revoke the current session — sign out instead");
      return;
    }
    const ok = await confirm({
      title: "Revoke this session?",
      description: "The device will be signed out immediately.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`/v1/sessions/${s.id}`, { method: "DELETE" });
      toast.show("success", "Session revoked");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeOthers() {
    const ok = await confirm({
      title: "Sign out of all other devices?",
      description: "Your current session will stay active.",
      confirmLabel: "Sign out others",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api<{ revoked: number }>(
        "/v1/sessions/revoke-others",
        { method: "POST" }
      );
      toast.show(
        "success",
        r.revoked > 0 ? `Revoked ${r.revoked} session(s)` : "No other sessions"
      );
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active sessions</CardTitle>
        <CardDescription>
          Devices currently signed in to your account. Revoke any that
          you don&apos;t recognise.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sessions === null ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="rounded-md border border-dashed bg-muted/20 p-4 text-center text-sm text-muted-foreground">
            No tracked sessions yet.
          </p>
        ) : (
          <ul className="divide-y">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
              >
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted">
                  <Laptop className="h-4 w-4 text-muted-foreground" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {parseUA(s.userAgent)}
                    </span>
                    {s.current && (
                      <Badge
                        variant="secondary"
                        className="bg-success/10 text-success"
                      >
                        This device
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {s.ip || "unknown IP"} · last active{" "}
                    {new Date(s.lastActiveAt).toLocaleString()}
                  </div>
                </div>
                {!s.current && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revoke(s)}
                    disabled={busy}
                    className="text-destructive hover:text-destructive"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {sessions && sessions.length > 1 && (
        <>
          <Separator />
          <CardFooter className="justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={revokeOthers}
              loading={busy}
            >
              <LogOut className="h-4 w-4" />
              Sign out of all other devices
            </Button>
          </CardFooter>
        </>
      )}
    </Card>
  );
}

/* ---------- helpers ---------- */

function parseUA(ua?: string): string {
  if (!ua) return "Unknown device";
  // Cheap heuristics — good enough for a sessions list.
  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = "Safari";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  let os = "";
  if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Linux/.test(ua)) os = "Linux";
  else if (/iPhone|iPad/.test(ua)) os = "iOS";
  else if (/Android/.test(ua)) os = "Android";
  return os ? `${browser} on ${os}` : browser;
}
