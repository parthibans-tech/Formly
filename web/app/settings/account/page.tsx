"use client";

// Profile page. Surfaces the data an enterprise user expects to find:
// identity (name + email + avatar), org context (org name + role + ID),
// security posture (MFA, recovery codes, password reset flag), session
// info (active count + this device), recent activity for self-audit, and
// quick-jump links to the related settings pages.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Building2,
  Calendar,
  CheckCircle2,
  Copy,
  Globe,
  IdCard,
  KeyRound,
  Loader2,
  Mail,
  MonitorSmartphone,
  RefreshCcw,
  ShieldCheck,
  ShieldOff,
  User as UserIcon,
  Users as UsersIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/components/toast";
import { api, updateUser } from "@/lib/api";

type Profile = {
  id: string;
  email: string;
  name: string;
  role: string;
  isSuperAdmin: boolean;
  orgId: string;
  orgName: string;
  createdAt: string;
  lockedAt?: string | null;
  forcePasswordReset: boolean;
  mfaEnabled: boolean;
  mfaEnrolledAt?: string | null;
  recoveryCodesLeft: number;
  activeSessions: number;
  currentSession?: {
    ipAddr?: string | null;
    userAgent?: string | null;
    createdAt: string;
    lastActiveAt: string;
  } | null;
  membershipCount: number;
  recentActivity: {
    action: string;
    ipAddr?: string | null;
    createdAt: string;
  }[];
};

function initials(name: string, email: string) {
  const src = (name || email || "?").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function relTime(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function browserFromUA(ua: string | null | undefined) {
  if (!ua) return "Unknown device";
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return "Chrome";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Safari\//.test(ua) && !/Chrome/.test(ua)) return "Safari";
  return "Browser";
}

function osFromUA(ua: string | null | undefined) {
  if (!ua) return "";
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return "";
}

export default function AccountSettings() {
  const toast = useToast();
  const [data, setData] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await api<Profile>("/v1/me/profile");
      setData(p);
      setName(p.name || "");
      // Keep the cached user blob in sync with the server-derived
      // isSuperAdmin flag so the sidebar's Platform section reflects
      // the current truth even if the JWT was minted before the env
      // var changed.
      updateUser({ isSuperAdmin: p.isSuperAdmin });
    } catch (e: any) {
      toast.show("error", "Couldn't load profile", { description: e?.message });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = !!data && name.trim() !== (data.name || "");

  const onSave = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const res = await api<{ ok: boolean; name: string }>("/v1/me/profile", {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) {
        updateUser({ name: res.name });
        setData((d) => (d ? { ...d, name: res.name } : d));
        toast.show("success", "Profile updated");
      }
    } catch (e: any) {
      toast.show("error", "Couldn't save", { description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast.show("success", `${label} copied`);
    });
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <UserIcon className="h-6 w-6" />
            Profile
          </h1>
          <p className="text-sm text-muted-foreground">
            Identity, security posture, and recent activity for your account.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={load}
          disabled={loading}
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {/* Banners */}
      {data?.forcePasswordReset && (
        <Banner
          tone="warn"
          icon={<AlertTriangle className="h-5 w-5 text-amber-600" />}
          title="Password reset required"
          desc="An admin has flagged this account for a fresh password."
          action={
            <Button asChild size="sm" variant="outline" className="h-8">
              <Link href="/set-password">Set new password</Link>
            </Button>
          }
        />
      )}
      {data?.lockedAt && (
        <Banner
          tone="warn"
          icon={<AlertTriangle className="h-5 w-5 text-amber-600" />}
          title="This account is locked"
          desc={`Locked ${relTime(data.lockedAt)}. Contact your admin to unlock.`}
        />
      )}
      {data && !data.mfaEnabled && (
        <Banner
          tone="info"
          icon={<ShieldOff className="h-5 w-5 text-muted-foreground" />}
          title="Two-factor authentication is off"
          desc="Add a second factor to protect this account from password leaks."
          action={
            <Button asChild size="sm" variant="outline" className="h-8">
              <Link href="/settings/security">Enable 2FA</Link>
            </Button>
          }
        />
      )}

      {/* Identity card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <IdCard className="h-4 w-4" />
            Identity
          </CardTitle>
          <CardDescription>
            Your display name appears on shares, comments, and audit events.
            Email is set at signup and can't be changed here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-4">
            {!data ? (
              <Skeleton className="h-16 w-16 rounded-full" />
            ) : (
              <Avatar className="h-16 w-16">
                <AvatarFallback className="text-lg">
                  {initials(data.name, data.email)}
                </AvatarFallback>
              </Avatar>
            )}
            <div className="flex-1 space-y-3">
              <div className="space-y-1">
                <Label htmlFor="name">Display name</Label>
                {!data ? (
                  <Skeleton className="h-9 w-full max-w-md" />
                ) : (
                  <div className="flex max-w-md gap-2">
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your name"
                      maxLength={200}
                    />
                    <Button
                      size="sm"
                      onClick={onSave}
                      disabled={!dirty || saving || !name.trim()}
                      className="h-9"
                    >
                      {saving && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      Save
                    </Button>
                  </div>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <ReadOnlyField
                  label="Email"
                  icon={<Mail className="h-4 w-4 text-muted-foreground" />}
                  value={data?.email}
                />
                <ReadOnlyField
                  label="Role"
                  icon={<UsersIcon className="h-4 w-4 text-muted-foreground" />}
                  value={
                    data ? (
                      <span className="inline-flex items-center gap-1">
                        <Badge variant="outline" className="capitalize">
                          {data.role || "—"}
                        </Badge>
                        {data.isSuperAdmin && (
                          <Badge
                            variant="outline"
                            className="border-primary/40 text-primary"
                          >
                            Platform operator
                          </Badge>
                        )}
                      </span>
                    ) : undefined
                  }
                />
                <ReadOnlyField
                  label="Member since"
                  icon={<Calendar className="h-4 w-4 text-muted-foreground" />}
                  value={
                    data
                      ? new Date(data.createdAt).toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                        })
                      : undefined
                  }
                />
                <ReadOnlyField
                  label="User ID"
                  icon={<UserIcon className="h-4 w-4 text-muted-foreground" />}
                  value={
                    data ? (
                      <button
                        type="button"
                        className="group inline-flex items-center gap-1 font-mono text-xs hover:text-foreground"
                        onClick={() => copy(data.id, "User ID")}
                        aria-label="Copy user ID"
                      >
                        <span className="truncate">{data.id}</span>
                        <Copy className="h-3 w-3 opacity-50 group-hover:opacity-100" />
                      </button>
                    ) : undefined
                  }
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Workspace + Security side-by-side */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4" />
              Workspace
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <DetailRow
              label="Organization"
              value={data ? data.orgName || "—" : undefined}
            />
            <DetailRow
              label="Memberships"
              value={
                data
                  ? data.membershipCount === 1
                    ? "1 organization"
                    : `${data.membershipCount} organizations`
                  : undefined
              }
            />
            <DetailRow
              label="Org ID"
              value={
                data ? (
                  <button
                    type="button"
                    className="group inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => copy(data.orgId, "Org ID")}
                  >
                    <span className="truncate">{data.orgId}</span>
                    <Copy className="h-3 w-3 opacity-50 group-hover:opacity-100" />
                  </button>
                ) : undefined
              }
            />
            <Separator />
            <div className="flex flex-wrap gap-2">
              {data?.role === "admin" && (
                <Button asChild size="sm" variant="outline" className="h-8">
                  <Link href="/settings/team">
                    <UsersIcon className="h-3.5 w-3.5" />
                    Manage team
                  </Link>
                </Button>
              )}
              {data && data.membershipCount > 1 && (
                <Button asChild size="sm" variant="outline" className="h-8">
                  <Link href="/settings/account">Switch organization</Link>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" />
              Security
            </CardTitle>
            <CardDescription>
              Password and 2FA changes happen on the Security page; this is the
              read-only summary.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <DetailRow
              label="Two-factor"
              value={
                data ? (
                  data.mfaEnabled ? (
                    <Badge
                      variant="outline"
                      className="border-emerald-500/40 text-emerald-700"
                    >
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                      Enabled
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-amber-500/40 text-amber-700"
                    >
                      Off
                    </Badge>
                  )
                ) : undefined
              }
            />
            {data?.mfaEnabled && data.mfaEnrolledAt && (
              <DetailRow
                label="Enrolled"
                value={new Date(data.mfaEnrolledAt).toLocaleDateString()}
              />
            )}
            {data?.mfaEnabled && (
              <DetailRow
                label="Recovery codes left"
                value={
                  <span
                    className={
                      data.recoveryCodesLeft <= 2
                        ? "font-medium text-amber-700"
                        : ""
                    }
                  >
                    {data.recoveryCodesLeft}
                  </span>
                }
              />
            )}
            <DetailRow
              label="Password reset flag"
              value={
                data ? (
                  data.forcePasswordReset ? (
                    <Badge
                      variant="outline"
                      className="border-amber-500/40 text-amber-700"
                    >
                      Required
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">Not set</span>
                  )
                ) : undefined
              }
            />
            <Separator />
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline" className="h-8">
                <Link href="/settings/security">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Security settings
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline" className="h-8">
                <Link href="/set-password">
                  <KeyRound className="h-3.5 w-3.5" />
                  Change password
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sessions + Recent activity */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MonitorSmartphone className="h-4 w-4" />
              Active sessions
            </CardTitle>
            <CardDescription>
              Each browser sign-in counts as one session. Sign out other devices
              from the Security page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!data ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-semibold">
                    {data.activeSessions}
                  </span>
                  <span className="text-muted-foreground">
                    {data.activeSessions === 1 ? "session" : "sessions"}
                  </span>
                </div>
                {data.currentSession ? (
                  <div className="rounded-md border bg-muted/30 p-3 text-xs">
                    <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      This device
                    </div>
                    <div className="grid gap-1 text-muted-foreground">
                      <div>
                        {browserFromUA(data.currentSession.userAgent)}
                        {osFromUA(data.currentSession.userAgent)
                          ? ` · ${osFromUA(data.currentSession.userAgent)}`
                          : ""}
                      </div>
                      {data.currentSession.ipAddr && (
                        <div className="flex items-center gap-1">
                          <Globe className="h-3 w-3" />
                          {data.currentSession.ipAddr}
                        </div>
                      )}
                      <div>
                        Signed in {relTime(data.currentSession.createdAt)} ·
                        last active {relTime(data.currentSession.lastActiveAt)}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    Session details unavailable for this request.
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4" />
              Recent activity
            </CardTitle>
            <CardDescription>
              The last 10 audit events recorded for your user.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {!data ? (
              <div className="p-4">
                <Skeleton className="h-24 w-full" />
              </div>
            ) : data.recentActivity.length === 0 ? (
              <div className="grid place-items-center gap-2 p-8 text-center text-sm text-muted-foreground">
                <Activity className="h-6 w-6" />
                No recorded activity yet.
              </div>
            ) : (
              <ul className="divide-y text-sm">
                {data.recentActivity.map((ev, i) => (
                  <li
                    key={`${ev.action}-${ev.createdAt}-${i}`}
                    className="flex items-center gap-3 px-4 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs">
                        {ev.action}
                      </div>
                      {ev.ipAddr && (
                        <div className="truncate text-[11px] text-muted-foreground">
                          {ev.ipAddr}
                        </div>
                      )}
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      {relTime(ev.createdAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function ReadOnlyField({
  label,
  icon,
  value,
}: {
  label: string;
  icon?: React.ReactNode;
  value?: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/30 px-3 text-sm">
        {icon}
        {value === undefined ? (
          <Skeleton className="h-4 w-24" />
        ) : (
          <span className="min-w-0 flex-1 truncate">{value}</span>
        )}
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-sm">
        {value === undefined ? <Skeleton className="h-4 w-20" /> : value}
      </span>
    </div>
  );
}

function Banner({
  tone,
  icon,
  title,
  desc,
  action,
}: {
  tone: "warn" | "info";
  icon: React.ReactNode;
  title: string;
  desc: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={
        "flex items-center gap-3 rounded-md border p-3 text-sm " +
        (tone === "warn"
          ? "border-amber-500/40 bg-amber-50 dark:bg-amber-950/30"
          : "border-border bg-muted/30")
      }
    >
      <div className="shrink-0">{icon}</div>
      <div className="flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
      {action}
    </div>
  );
}
