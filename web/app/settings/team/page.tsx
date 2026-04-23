"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Crown,
  Eye,
  Mail,
  PencilLine,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import { api, getUser } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/ui/confirm";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Member = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "editor" | "viewer";
  createdAt: string;
  isSelf: boolean;
};

type Invite = {
  id: string;
  email: string;
  role: string;
  token: string;
  createdAt: string;
  expiresAt?: string;
  acceptedAt?: string;
  revokedAt?: string;
  invitedBy?: string;
};

const ROLES: { value: Member["role"]; label: string; hint: string }[] = [
  { value: "admin", label: "Admin", hint: "Full control — can manage team, billing, API keys." },
  { value: "editor", label: "Editor", hint: "Can create and edit templates, run generations." },
  { value: "viewer", label: "Viewer", hint: "Read-only access to the drive." },
];

function roleBadge(role: string) {
  if (role === "admin")
    return (
      <Badge variant="default" className="gap-1">
        <Crown className="h-3 w-3" />
        Admin
      </Badge>
    );
  if (role === "viewer")
    return (
      <Badge variant="secondary" className="gap-1">
        <Eye className="h-3 w-3" />
        Viewer
      </Badge>
    );
  return (
    <Badge variant="outline" className="gap-1">
      <PencilLine className="h-3 w-3" />
      Editor
    </Badge>
  );
}

export default function TeamSettingsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [me, setMe] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Member["role"]>("editor");
  const [inviting, setInviting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    setMe(getUser());
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [m, i] = await Promise.all([
        api<{ members: Member[] }>("/v1/team/members"),
        api<{ invites: Invite[] }>("/v1/team/invites"),
      ]);
      setMembers(m.members);
      setInvites(i.invites);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setLoading(false);
    }
  }

  const isAdmin = me?.role === "admin";

  async function invite() {
    setInviting(true);
    try {
      await api("/v1/team/invites", {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      toast.show("success", "Invitation created", {
        description: "Copy the invite link below and send it to your teammate.",
      });
      setInviteEmail("");
      setInviteRole("editor");
      setInviteOpen(false);
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setInviting(false);
    }
  }

  async function changeRole(m: Member, next: Member["role"]) {
    try {
      await api(`/v1/team/members/${m.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: next }),
      });
      toast.show("success", `Role updated for ${m.email}`);
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function removeMember(m: Member) {
    const ok = await confirm({
      title: `Remove ${m.name || m.email}?`,
      description:
        "They'll lose access immediately. Files they own stay in the organization.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/team/members/${m.id}`, { method: "DELETE" });
      toast.show("success", "Member removed");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function revokeInvite(inv: Invite) {
    try {
      await api(`/v1/team/invites/${inv.id}`, { method: "DELETE" });
      toast.show("success", "Invitation revoked");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function copyInvite(inv: Invite) {
    const url = `${window.location.origin}/accept/${inv.token}`;
    await navigator.clipboard.writeText(url);
    setCopiedId(inv.id);
    toast.show("success", "Invite link copied");
    setTimeout(() => setCopiedId((c) => (c === inv.id ? null : c)), 2000);
  }

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
          <p className="text-sm text-muted-foreground">
            Invite teammates, manage roles, and keep track of pending
            invitations.
          </p>
        </div>
        {isAdmin && (
          <Button onClick={() => setInviteOpen(true)}>
            <Plus className="h-4 w-4" />
            Invite teammate
          </Button>
        )}
      </div>

      {!isAdmin && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Only admins can invite new members or change roles. Ask an admin if
            you need access.
          </span>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            Members
          </CardTitle>
          <CardDescription>
            Everyone in this workspace. Your teammates see the same list.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : members.length === 0 ? (
            <EmptyState
              icon={Users}
              title="Just you"
              description="Invite teammates to collaborate on templates and generations."
              className="border-0"
            />
          ) : (
            <ul className="divide-y">
              {members.map((m) => (
                <li
                  key={m.id}
                  className="flex flex-wrap items-center gap-3 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-semibold">
                        {m.name || m.email.split("@")[0]}
                      </span>
                      {m.isSelf && (
                        <Badge variant="secondary" className="text-[10px]">
                          You
                        </Badge>
                      )}
                      {roleBadge(m.role)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {m.email}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {isAdmin && !m.isSelf && (
                      <>
                        <Select
                          value={m.role}
                          onValueChange={(v) =>
                            changeRole(m, v as Member["role"])
                          }
                        >
                          <SelectTrigger className="h-8 w-[120px] text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLES.map((r) => (
                              <SelectItem key={r.value} value={r.value}>
                                {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeMember(m)}
                          aria-label="Remove member"
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            Pending invitations
          </CardTitle>
          <CardDescription>
            Invitations are links — copy and send them. A person clicks the
            link, creates a password, and joins immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-12 w-full" />
          ) : invites.filter((i) => !i.acceptedAt && !i.revokedAt).length ===
            0 ? (
            <p className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              No pending invites. {isAdmin && "Hit \"Invite teammate\" above."}
            </p>
          ) : (
            <ul className="divide-y">
              {invites
                .filter((i) => !i.acceptedAt && !i.revokedAt)
                .map((inv) => {
                  const expired =
                    inv.expiresAt && new Date(inv.expiresAt) < new Date();
                  return (
                    <li
                      key={inv.id}
                      className="flex flex-wrap items-center gap-3 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {inv.email}
                          {roleBadge(inv.role)}
                          {expired && (
                            <Badge variant="warning">Expired</Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Sent {new Date(inv.createdAt).toLocaleDateString()}
                          {inv.invitedBy && <> · by {inv.invitedBy}</>}
                          {inv.expiresAt && (
                            <>
                              {" "}
                              · expires{" "}
                              {new Date(inv.expiresAt).toLocaleDateString()}
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copyInvite(inv)}
                        >
                          {copiedId === inv.id ? (
                            <>
                              <Check className="h-4 w-4 text-success" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="h-4 w-4" />
                              Copy link
                            </>
                          )}
                        </Button>
                        {isAdmin && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => revokeInvite(inv)}
                            aria-label="Revoke invitation"
                            className={cn(
                              "text-muted-foreground hover:text-destructive"
                            )}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-primary" />
              Invite a teammate
            </DialogTitle>
            <DialogDescription>
              We&apos;ll create a one-time link — copy it and share via your
              preferred channel (email, Slack, carrier pigeon).
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              invite();
            }}
            className="space-y-3"
          >
            <div className="space-y-1.5">
              <Label htmlFor="inv-email">Email</Label>
              <Input
                id="inv-email"
                autoFocus
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@company.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select
                value={inviteRole}
                onValueChange={(v) => setInviteRole(v as Member["role"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      <div>
                        <div className="font-medium">{r.label}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {r.hint}
                        </div>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </form>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInviteOpen(false)}
              disabled={inviting}
            >
              Cancel
            </Button>
            <Button onClick={invite} loading={inviting}>
              <Mail className="h-4 w-4" />
              Create invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
