"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AtSign, CheckCheck, Inbox } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { AppShell } from "@/components/app-shell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";

type Mention = {
  commentId: string;
  templateId: string;
  templateName: string;
  body: string;
  author: string;
  createdAt: string;
  read: boolean;
};

export default function MentionsInboxPage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Mention[]>([]);

  async function load() {
    setLoading(true);
    try {
      const r = await api<{ mentions: Mention[] }>("/v1/mentions");
      setRows(r.mentions);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setLoading(false);
    }
  }

  async function markRead() {
    try {
      await api("/v1/mentions/mark-read", { method: "POST" });
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unread = rows.filter((m) => !m.read).length;

  return (
    <AppShell>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mentions</h1>
          <p className="text-sm text-muted-foreground">
            Comments where a teammate tagged you with{" "}
            <code className="font-mono text-xs">@yourname</code>.
          </p>
        </div>
        {unread > 0 && (
          <Button variant="outline" size="sm" onClick={markRead}>
            <CheckCheck className="h-4 w-4" />
            Mark all read
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Inbox className="h-5 w-5 text-primary" />
            Recent mentions
            {unread > 0 && (
              <Badge variant="default" className="text-[10px]">
                {unread} new
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Click through to see the comment in context on the template.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={AtSign}
              title="Nothing here yet"
              description="Teammates can @mention you in a comment — it'll show up here."
              className="border-0"
            />
          ) : (
            <ul className="divide-y">
              {rows.map((m) => (
                <li key={m.commentId} className="py-3">
                  <Link
                    href={`/templates/${m.templateId}/designer`}
                    className="flex flex-wrap items-start gap-3 rounded-md p-2 transition-colors hover:bg-accent/40"
                  >
                    <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
                      <AtSign className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-semibold">{m.author}</span>
                        <span className="text-muted-foreground">
                          on <strong>{m.templateName}</strong>
                        </span>
                        {!m.read && (
                          <Badge variant="default" className="text-[10px]">
                            New
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground line-clamp-2">
                        {m.body}
                      </p>
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {new Date(m.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
