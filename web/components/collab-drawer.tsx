"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AtSign,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  MessageSquare,
  MessageSquareText,
  MessageSquareWarning,
  Send,
  Share2,
  Trash2,
  Users as UsersIcon,
  X,
} from "lucide-react";
import { api, getUser } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/ui/confirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
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
  name: string;
  email: string;
  role: string;
  isSelf: boolean;
};
type Comment = {
  id: string;
  parentId?: string | null;
  authorId?: string | null;
  authorName: string;
  authorEmail?: string;
  anchor?: string | null;
  body: string;
  resolvedAt?: string;
  createdAt: string;
};
type Review = {
  id: string;
  templateId: string;
  version: number;
  status: string;
  comment?: string;
  requestedBy: string;
  reviewer: string;
  reviewerId: string;
  createdAt: string;
  decidedAt?: string;
};
type Peer = {
  userId: string;
  email: string;
  name: string;
  lastSeenAt: string;
  isSelf: boolean;
};
type ReviewLink = {
  id: string;
  token: string;
  guestEmail?: string;
  guestName?: string;
  status: string;
  active: boolean;
  createdAt: string;
  expiresAt?: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateId: string;
  templateName: string;
};

type Tab = "comments" | "reviews" | "share";

export function CollabDrawer({
  open,
  onOpenChange,
  templateId,
  templateName,
}: Props) {
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>("comments");
  const [me, setMe] = useState<any>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [links, setLinks] = useState<ReviewLink[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [newBody, setNewBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [reviewerId, setReviewerId] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [guestEmail, setGuestEmail] = useState("");
  const [guestName, setGuestName] = useState("");
  const [creatingLink, setCreatingLink] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setMe(getUser());
  }, []);

  // Presence heartbeat — fires once on mount and every 15s while mounted.
  useEffect(() => {
    if (!templateId) return;
    const beat = async () => {
      try {
        const r = await api<{ peers: Peer[] }>(
          `/v1/templates/${templateId}/presence`
        );
        setPeers(r.peers);
      } catch {
        /* non-fatal */
      }
    };
    beat();
    pollRef.current = setInterval(beat, 15_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      // best-effort leave on unmount
      api(`/v1/templates/${templateId}/presence`, { method: "DELETE" }).catch(
        () => {}
      );
    };
  }, [templateId]);

  // Data fetch when drawer opens.
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const [c, r, l, m] = await Promise.all([
          api<{ comments: Comment[] }>(`/v1/templates/${templateId}/comments`),
          api<{ reviews: Review[] }>(`/v1/templates/${templateId}/reviews`),
          api<{ links: ReviewLink[] }>(
            `/v1/templates/${templateId}/review-links`
          ),
          api<{ members: Member[] }>("/v1/team/members"),
        ]);
        setComments(c.comments);
        setReviews(r.reviews);
        setLinks(l.links);
        setMembers(m.members);
        const other = m.members.find((x) => !x.isSelf);
        if (other && !reviewerId) setReviewerId(other.id);
      } catch (e: any) {
        toast.show("error", e.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templateId]);

  async function postComment() {
    if (!newBody.trim()) return;
    setPosting(true);
    try {
      await api(`/v1/templates/${templateId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: newBody.trim() }),
      });
      setNewBody("");
      const c = await api<{ comments: Comment[] }>(
        `/v1/templates/${templateId}/comments`
      );
      setComments(c.comments);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setPosting(false);
    }
  }

  async function toggleResolve(c: Comment) {
    try {
      await api(`/v1/comments/${c.id}/resolve`, {
        method: "PATCH",
        body: JSON.stringify({ resolved: !c.resolvedAt }),
      });
      const r = await api<{ comments: Comment[] }>(
        `/v1/templates/${templateId}/comments`
      );
      setComments(r.comments);
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function deleteComment(c: Comment) {
    const ok = await confirm({
      title: "Delete this comment?",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/comments/${c.id}`, { method: "DELETE" });
      setComments((prev) => prev.filter((x) => x.id !== c.id));
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function requestReview() {
    if (!reviewerId) {
      toast.show("error", "Pick a reviewer");
      return;
    }
    setRequesting(true);
    try {
      await api(`/v1/templates/${templateId}/reviews`, {
        method: "POST",
        body: JSON.stringify({ reviewerId, comment: reviewNote.trim() }),
      });
      toast.show("success", "Review requested");
      setReviewNote("");
      const r = await api<{ reviews: Review[] }>(
        `/v1/templates/${templateId}/reviews`
      );
      setReviews(r.reviews);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setRequesting(false);
    }
  }

  async function createLink() {
    setCreatingLink(true);
    try {
      await api(`/v1/templates/${templateId}/review-links`, {
        method: "POST",
        body: JSON.stringify({
          guestEmail: guestEmail.trim(),
          guestName: guestName.trim(),
        }),
      });
      toast.show("success", "Review link created");
      setGuestEmail("");
      setGuestName("");
      const l = await api<{ links: ReviewLink[] }>(
        `/v1/templates/${templateId}/review-links`
      );
      setLinks(l.links);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setCreatingLink(false);
    }
  }

  async function revokeLink(l: ReviewLink) {
    try {
      await api(`/v1/review-links/${l.id}`, { method: "DELETE" });
      setLinks((prev) =>
        prev.map((x) => (x.id === l.id ? { ...x, active: false } : x))
      );
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function copyLink(l: ReviewLink) {
    const url = `${window.location.origin}/review/${l.token}`;
    await navigator.clipboard.writeText(url);
    setCopiedId(l.id);
    toast.show("success", "Review URL copied");
    setTimeout(() => setCopiedId((c) => (c === l.id ? null : c)), 2000);
  }

  const activePeers = useMemo(
    () => peers.filter((p) => !p.isSelf).slice(0, 5),
    [peers]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l bg-background shadow-xl">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Collaboration
          </div>
          <h2 className="truncate text-sm font-semibold">{templateName}</h2>
        </div>
        <div className="flex items-center gap-1">
          {activePeers.length > 0 && (
            <div className="mr-1 flex -space-x-2">
              {activePeers.map((p) => (
                <Avatar
                  key={p.userId}
                  className="h-6 w-6 border-2 border-background"
                  title={p.name || p.email}
                >
                  <AvatarFallback className="text-[10px]">
                    {initials(p.name || p.email)}
                  </AvatarFallback>
                </Avatar>
              ))}
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex gap-1 border-b px-3 py-2 text-xs">
        <TabBtn active={tab === "comments"} onClick={() => setTab("comments")}>
          <MessageSquareText className="h-3.5 w-3.5" />
          Comments
        </TabBtn>
        <TabBtn active={tab === "reviews"} onClick={() => setTab("reviews")}>
          <CheckCircle2 className="h-3.5 w-3.5" />
          Reviews
        </TabBtn>
        <TabBtn active={tab === "share"} onClick={() => setTab("share")}>
          <Share2 className="h-3.5 w-3.5" />
          Share
        </TabBtn>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === "comments" && (
          <div className="space-y-3 p-4">
            {comments.length === 0 && (
              <p className="rounded-md border border-dashed bg-muted/30 p-4 text-center text-xs text-muted-foreground">
                Start the conversation. Use{" "}
                <code className="font-mono">@name</code> to ping a teammate.
              </p>
            )}
            <ul className="space-y-3">
              {comments.map((c) => {
                const canDelete = c.authorId === me?.id || me?.role === "admin";
                return (
                  <li
                    key={c.id}
                    className={cn(
                      "rounded-md border bg-card p-2.5",
                      c.resolvedAt && "opacity-60"
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <Avatar className="h-7 w-7">
                        <AvatarFallback className="text-[10px]">
                          {initials(c.authorName || c.authorEmail || "G")}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-semibold">
                            {c.authorName || c.authorEmail || "Guest"}
                          </span>
                          {!c.authorId && (
                            <Badge variant="secondary" className="text-[9px]">
                              Guest
                            </Badge>
                          )}
                          <span className="text-muted-foreground">
                            {new Date(c.createdAt).toLocaleString()}
                          </span>
                        </div>
                        {c.anchor && (
                          <Badge
                            variant="outline"
                            className="mt-0.5 font-mono text-[9px]"
                          >
                            @ {c.anchor}
                          </Badge>
                        )}
                        <p className="mt-1 whitespace-pre-wrap text-sm">
                          {renderBody(c.body)}
                        </p>
                      </div>
                      <div className="flex flex-col gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => toggleResolve(c)}
                          aria-label={c.resolvedAt ? "Reopen" : "Resolve"}
                          title={c.resolvedAt ? "Reopen" : "Mark resolved"}
                          className="h-7 w-7"
                        >
                          <Check
                            className={cn(
                              "h-3.5 w-3.5",
                              c.resolvedAt && "text-success"
                            )}
                          />
                        </Button>
                        {canDelete && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => deleteComment(c)}
                            aria-label="Delete"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {tab === "reviews" && (
          <div className="space-y-4 p-4">
            <div className="rounded-md border bg-card p-3 space-y-2">
              <Label className="text-xs">Request a review</Label>
              <Select value={reviewerId} onValueChange={setReviewerId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Pick a reviewer" />
                </SelectTrigger>
                <SelectContent>
                  {members
                    .filter((m) => !m.isSelf)
                    .map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name || m.email} · {m.role}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Input
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                placeholder="Optional note for the reviewer"
                className="text-xs h-8"
              />
              <Button
                size="sm"
                onClick={requestReview}
                loading={requesting}
                className="w-full"
              >
                <CheckCircle2 className="h-4 w-4" />
                Request review
              </Button>
            </div>

            <Separator />

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                History
              </div>
              {reviews.length === 0 ? (
                <p className="rounded-md border border-dashed bg-muted/30 p-4 text-center text-xs text-muted-foreground">
                  No reviews yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {reviews.map((r) => (
                    <li
                      key={r.id}
                      className="rounded-md border bg-card p-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <ReviewStatusBadge status={r.status} />
                        <span className="text-muted-foreground">
                          v{r.version} · {r.reviewer} ·{" "}
                          {new Date(r.createdAt).toLocaleString()}
                        </span>
                      </div>
                      {r.comment && (
                        <p className="mt-1 text-muted-foreground">
                          “{r.comment}”
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {tab === "share" && (
          <div className="space-y-4 p-4">
            <div className="rounded-md border bg-card p-3 space-y-2">
              <Label className="text-xs">Invite an external reviewer</Label>
              <p className="text-[10px] text-muted-foreground">
                Creates a one-time review URL. Guests can leave comments and
                approve without a Drive360 account.
              </p>
              <Input
                value={guestEmail}
                onChange={(e) => setGuestEmail(e.target.value)}
                type="email"
                placeholder="reviewer@client.example"
                className="h-8 text-xs"
              />
              <Input
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="Name (optional)"
                className="h-8 text-xs"
              />
              <Button
                size="sm"
                onClick={createLink}
                loading={creatingLink}
                className="w-full"
              >
                <ExternalLink className="h-4 w-4" />
                Create link
              </Button>
            </div>

            <Separator />

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Active review links
              </div>
              {links.filter((l) => l.active).length === 0 ? (
                <p className="rounded-md border border-dashed bg-muted/30 p-4 text-center text-xs text-muted-foreground">
                  No active links.
                </p>
              ) : (
                <ul className="space-y-2">
                  {links
                    .filter((l) => l.active)
                    .map((l) => (
                      <li
                        key={l.id}
                        className="rounded-md border bg-card p-2 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">
                            {l.guestName || l.guestEmail || "Anonymous guest"}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => copyLink(l)}
                          >
                            {copiedId === l.id ? (
                              <Check className="h-3.5 w-3.5 text-success" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => revokeLink(l)}
                            aria-label="Revoke"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {l.guestEmail} · created{" "}
                          {new Date(l.createdAt).toLocaleDateString()}
                          {l.expiresAt && (
                            <>
                              {" "}· expires{" "}
                              {new Date(l.expiresAt).toLocaleDateString()}
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                </ul>
              )}
            </div>

            {activePeers.length > 0 && (
              <>
                <Separator />
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <UsersIcon className="h-3.5 w-3.5" />
                  <span>
                    {activePeers.map((p) => p.name || p.email).join(", ")}{" "}
                    {activePeers.length === 1 ? "is" : "are"} also viewing
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {tab === "comments" && (
        <div className="border-t p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              postComment();
            }}
            className="flex items-end gap-2"
          >
            <textarea
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              placeholder="Write a comment… (@mention teammates by name)"
              className="h-20 flex-1 resize-none rounded-md border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  postComment();
                }
              }}
            />
            <Button
              type="submit"
              size="sm"
              loading={posting}
              disabled={!newBody.trim()}
            >
              <Send className="h-4 w-4" />
              Post
            </Button>
          </form>
          <p className="mt-1 text-[10px] text-muted-foreground">
            <strong>⌘/Ctrl+Enter</strong> to post
          </p>
        </div>
      )}
    </div>
  );
}

function ReviewStatusBadge({ status }: { status: string }) {
  if (status === "approved")
    return (
      <Badge variant="success" className="text-[9px]">
        <CheckCircle2 className="h-3 w-3" />
        Approved
      </Badge>
    );
  if (status === "changes_requested")
    return (
      <Badge variant="warning" className="text-[9px]">
        <MessageSquareWarning className="h-3 w-3" />
        Changes requested
      </Badge>
    );
  if (status === "cancelled" || status === "revoked")
    return (
      <Badge variant="secondary" className="text-[9px]">
        {status}
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-[9px]">
      Pending
    </Badge>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium transition-colors",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function initials(s: string): string {
  return s
    .split(/[.\-_ @]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

// Highlight @mentions in rendered comment bodies.
function renderBody(body: string): React.ReactNode {
  const parts = body.split(/(@[A-Za-z0-9._-]+)/g);
  return parts.map((p, i) =>
    p.startsWith("@") ? (
      <span key={i} className="font-medium text-primary">
        {p}
      </span>
    ) : (
      <span key={i}>{p}</span>
    )
  );
}

// Unused, but exported so designers can easily import the shape if they want.
export type { Comment, Review, Peer, Member, ReviewLink };
