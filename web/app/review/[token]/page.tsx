"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  CheckCircle2,
  FileSignature,
  MessageSquareText,
  MessageSquareWarning,
  Send,
  ShieldAlert,
} from "lucide-react";
import { API_URL } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

type Resolve = {
  templateId: string;
  templateName: string;
  mode: string;
  status: string;
  guestEmail?: string;
  guestName?: string;
  decided: boolean;
};

type Comment = {
  id: string;
  parentId?: string | null;
  author: string;
  anchor?: string | null;
  body: string;
  createdAt: string;
};

export default function ExternalReviewPage() {
  const params = useParams<{ token: string }>();
  const [info, setInfo] = useState<Resolve | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [newBody, setNewBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [done, setDone] = useState<"approved" | "changes_requested" | null>(
    null
  );
  const [decisionNote, setDecisionNote] = useState("");

  async function load() {
    try {
      const r = await fetch(`${API_URL}/v1/public/reviews/${params.token}`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error?.message || "review link not found");
      }
      setInfo(await r.json());
      const c = await fetch(
        `${API_URL}/v1/public/reviews/${params.token}/comments`
      );
      if (c.ok) {
        const j = await c.json();
        setComments(j.comments);
      }
    } catch (e: any) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function post() {
    if (!newBody.trim()) return;
    setPosting(true);
    try {
      const r = await fetch(
        `${API_URL}/v1/public/reviews/${params.token}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: newBody.trim() }),
        }
      );
      if (!r.ok) throw new Error("couldn't post comment");
      setNewBody("");
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setPosting(false);
    }
  }

  async function decide(decision: "approved" | "changes_requested") {
    setDeciding(decision);
    try {
      const r = await fetch(
        `${API_URL}/v1/public/reviews/${params.token}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, comment: decisionNote.trim() }),
        }
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error?.message || "couldn't submit decision");
      }
      setDone(decision);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setDeciding(null);
    }
  }

  if (err) return <Shell><Err title="Review unavailable" msg={err} /></Shell>;
  if (!info) return <Shell><div className="h-6 w-40 animate-pulse rounded bg-muted" /></Shell>;

  if (done || info.decided) {
    const d = done || (info.status === "approved" ? "approved" : "changes_requested");
    return (
      <Shell>
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-success/15 text-success">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <CardTitle className="text-center">
              {d === "approved" ? "Review approved" : "Changes requested"}
            </CardTitle>
            <CardDescription className="text-center">
              Thanks for reviewing &quot;{info.templateName}&quot;. The team has
              been notified.
            </CardDescription>
          </CardHeader>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="grid w-full max-w-5xl grid-cols-1 gap-4 lg:grid-cols-[1fr_400px]">
        <Card>
          <CardHeader>
            <div className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <MessageSquareText className="h-3.5 w-3.5" />
              Review request · {info.mode.toUpperCase()}
            </div>
            <CardTitle>{info.templateName}</CardTitle>
            <CardDescription>
              Leave comments below, then approve or request changes.
              {info.guestName && (
                <>
                  {" "}
                  You are reviewing as{" "}
                  <strong className="text-foreground">{info.guestName}</strong>.
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              The reviewer preview is simplified (full rendering lives in the
              main editor). For every question you have, add a comment on the
              right — the author will address them and re-share.
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Overall note (optional)
              </label>
              <textarea
                value={decisionNote}
                onChange={(e) => setDecisionNote(e.target.value)}
                className="h-24 w-full resize-none rounded-md border bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Share a summary with the author — e.g. 'Looks great, just confirm the address.'"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                loading={deciding === "changes_requested"}
                onClick={() => decide("changes_requested")}
              >
                <MessageSquareWarning className="h-4 w-4" />
                Request changes
              </Button>
              <Button
                loading={deciding === "approved"}
                onClick={() => decide("approved")}
              >
                <CheckCircle2 className="h-4 w-4" />
                Approve
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Comments */}
        <Card className="max-h-[70vh] overflow-hidden">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquareText className="h-4 w-4 text-primary" />
              Comments
              <Badge variant="secondary" className="text-[10px]">
                {comments.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex h-[55vh] flex-col gap-3 pt-0">
            <div className="flex-1 space-y-3 overflow-y-auto pr-1">
              {comments.length === 0 ? (
                <p className="rounded-md border border-dashed bg-muted/30 p-4 text-center text-xs text-muted-foreground">
                  No comments yet.
                </p>
              ) : (
                comments.map((c) => (
                  <div
                    key={c.id}
                    className="rounded-md border bg-card p-2 text-sm"
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-semibold">{c.author}</span>
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
                    <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
                  </div>
                ))
              )}
            </div>
            <Separator />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                post();
              }}
              className="flex items-end gap-2"
            >
              <textarea
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                className="h-16 flex-1 resize-none rounded-md border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Write a comment…"
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
          </CardContent>
        </Card>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-muted/40">
      <header className="border-b bg-background px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-5xl items-center gap-2 text-sm font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <FileSignature className="h-4 w-4" />
          </span>
          Formly · Review
        </div>
      </header>
      <div className="flex flex-1 items-start justify-center p-6">
        {children}
      </div>
      <footer className="border-t bg-background px-4 py-3 text-center text-[11px] text-muted-foreground">
        Powered by Formly · This link was shared for one-time review.
      </footer>
    </div>
  );
}

function Err({ title, msg }: { title: string; msg: string }) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-destructive/10 text-destructive">
          <ShieldAlert className="h-6 w-6" />
        </div>
        <CardTitle className="text-center">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-center text-sm text-muted-foreground">
        {msg}
      </CardContent>
    </Card>
  );
}
