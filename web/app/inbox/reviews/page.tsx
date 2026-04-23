"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, CheckSquare, MessageSquareWarning } from "lucide-react";
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

type Review = {
  id: string;
  templateId: string;
  version: number;
  status: string;
  comment?: string;
  requestedBy: string;
  reviewer: string;
  createdAt: string;
};

export default function ReviewsInboxPage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Review[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await api<{ reviews: Review[] }>("/v1/reviews/inbox");
      setRows(r.reviews);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setLoading(false);
    }
  }

  async function decide(id: string, decision: "approved" | "changes_requested") {
    setBusy(id);
    try {
      await api(`/v1/reviews/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      toast.show(
        "success",
        decision === "approved" ? "Approved" : "Changes requested"
      );
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppShell>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Review requests</h1>
        <p className="text-sm text-muted-foreground">
          Templates teammates have asked you to sign off on.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckSquare className="h-5 w-5 text-primary" />
            Waiting on you
          </CardTitle>
          <CardDescription>
            Approving promotes the template to <strong>approved</strong>;
            requesting changes sends it back to the author.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={CheckSquare}
              title="Nothing to review"
              description="When a teammate asks you to review a template, it appears here."
              className="border-0"
            />
          ) : (
            <ul className="divide-y">
              {rows.map((r) => (
                <li key={r.id} className="py-3">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/templates/${r.templateId}/designer`}
                        className="text-sm font-semibold hover:underline"
                      >
                        Review requested on template
                      </Link>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        v{r.version} · by{" "}
                        <strong className="text-foreground">{r.requestedBy}</strong> ·{" "}
                        {new Date(r.createdAt).toLocaleString()}
                      </div>
                      {r.comment && (
                        <p className="mt-1 text-sm text-muted-foreground">
                          “{r.comment}”
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        loading={busy === r.id}
                        onClick={() => decide(r.id, "changes_requested")}
                      >
                        <MessageSquareWarning className="h-4 w-4" />
                        Request changes
                      </Button>
                      <Button
                        size="sm"
                        loading={busy === r.id}
                        onClick={() => decide(r.id, "approved")}
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        Approve
                      </Button>
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-1">
                    <Badge variant="secondary" className="text-[10px]">
                      pending
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
