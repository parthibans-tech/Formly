"use client";

import { useEffect, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  Clock,
  History,
  PauseCircle,
  PlayCircle,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/api";
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

type Schedule = {
  id: string;
  templateId: string;
  name: string;
  cron: string;
  timezone: string;
  active: boolean;
  data?: any;
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt: string;
};

type Run = {
  id: string;
  status: string;
  outputFileId?: string | null;
  error?: string | null;
  firedAt: string;
  finishedAt?: string;
};

const PRESETS = [
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Daily at 09:00", value: "0 9 * * *" },
  { label: "Weekdays 09:00", value: "0 9 * * 1-5" },
  { label: "Weekly (Mon 09:00)", value: "0 9 * * 1" },
  { label: "Monthly (1st 09:00)", value: "0 9 1 * *" },
];

export default function SchedulesPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Schedule[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [tplId, setTplId] = useState("");
  const [name, setName] = useState("Daily run");
  const [cronExpr, setCronExpr] = useState("0 9 * * *");
  const [tz, setTz] = useState("UTC");
  const [dataJSON, setDataJSON] = useState("{}");
  const [creating, setCreating] = useState(false);
  const [runsOpen, setRunsOpen] = useState<Schedule | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api<{ schedules: Schedule[] }>("/v1/schedules");
      setRows(r.schedules);
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setLoading(false);
    }
  }
  async function loadTemplates() {
    try {
      const r = await api<{ files: any[] }>("/v1/files");
      const templated = (r.files || [])
        .filter((f: any) => f.templateId)
        .map((f: any) => ({ id: f.templateId as string, name: f.name as string }));
      setTemplates(templated);
      if (!tplId && templated.length) setTplId(templated[0].id);
    } catch (e: any) {
      /* non-fatal */
    }
  }

  useEffect(() => {
    load();
    loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    setCreating(true);
    try {
      let data: any = {};
      try {
        data = JSON.parse(dataJSON);
      } catch {
        toast.show("error", "Invalid JSON");
        setCreating(false);
        return;
      }
      await api("/v1/schedules", {
        method: "POST",
        body: JSON.stringify({
          templateId: tplId,
          name: name.trim() || "Scheduled run",
          cron: cronExpr.trim(),
          timezone: tz,
          data,
          active: true,
        }),
      });
      toast.show("success", "Schedule created");
      setCreateOpen(false);
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    } finally {
      setCreating(false);
    }
  }

  async function toggle(row: Schedule) {
    try {
      await api(`/v1/schedules/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !row.active }),
      });
      toast.show("success", row.active ? "Paused" : "Resumed");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function remove(row: Schedule) {
    const ok = await confirm({
      title: `Delete "${row.name}"?`,
      description: "No further runs will be scheduled.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/v1/schedules/${row.id}`, { method: "DELETE" });
      toast.show("success", "Schedule deleted");
      await load();
    } catch (e: any) {
      toast.show("error", e.message);
    }
  }

  async function openRuns(row: Schedule) {
    setRunsOpen(row);
    setRunsLoading(true);
    try {
      const r = await api<{ runs: Run[] }>(`/v1/schedules/${row.id}/runs`);
      setRuns(r.runs);
    } finally {
      setRunsLoading(false);
    }
  }

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Scheduled generation
          </h1>
          <p className="text-sm text-muted-foreground">
            Run a template on a cron schedule. Each fire enqueues an async
            generate with the payload you configure.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New schedule
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-primary" />
            Active schedules
          </CardTitle>
          <CardDescription>
            The worker checks every minute. Cron is 5-field standard (min hour
            dom mon dow); seconds are supported if you prefix a 6th field.
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
              icon={CalendarClock}
              title="No schedules yet"
              description="Pick a template, a cron expression, and a data payload — Drive360 does the rest."
              action={
                <Button onClick={() => setCreateOpen(true)} size="sm">
                  <Plus className="h-4 w-4" />
                  Create your first schedule
                </Button>
              }
              className="border-0"
            />
          ) : (
            <ul className="space-y-2">
              {rows.map((row) => (
                <li key={row.id} className="rounded-md border bg-card p-3">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">{row.name}</span>
                        {row.active ? (
                          <Badge variant="success">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Paused</Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <code className="font-mono">{row.cron}</code>
                        <span>· {row.timezone}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                        {row.nextRunAt && (
                          <span>
                            next{" "}
                            <strong className="text-foreground">
                              {new Date(row.nextRunAt).toLocaleString()}
                            </strong>
                          </span>
                        )}
                        {row.lastRunAt && (
                          <span>
                            · last{" "}
                            {new Date(row.lastRunAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openRuns(row)}
                      >
                        <History className="h-4 w-4" />
                        Runs
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggle(row)}
                      >
                        {row.active ? (
                          <>
                            <PauseCircle className="h-4 w-4" />
                            Pause
                          </>
                        ) : (
                          <>
                            <PlayCircle className="h-4 w-4" />
                            Resume
                          </>
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => remove(row)}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-primary" />
              New schedule
            </DialogTitle>
            <DialogDescription>
              Every matching tick, the worker enqueues a generate with the
              data below. Output files appear in your drive.
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
            className="space-y-3"
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Template</Label>
                <Select value={tplId} onValueChange={setTplId}>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        templates.length === 0
                          ? "Upload a template first"
                          : "Pick a template"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Daily invoice run"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Cron expression</Label>
                <Input
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  className="font-mono text-xs"
                />
                <div className="flex flex-wrap gap-1">
                  {PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setCronExpr(p.value)}
                      className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Timezone</Label>
                <Input
                  value={tz}
                  onChange={(e) => setTz(e.target.value)}
                  placeholder="UTC, America/New_York, Europe/Berlin"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Data payload (JSON)</Label>
              <textarea
                className="h-40 w-full rounded-md border bg-background p-3 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={dataJSON}
                onChange={(e) => setDataJSON(e.target.value)}
                spellCheck={false}
              />
            </div>
          </form>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button onClick={create} loading={creating} disabled={!tplId}>
              <CalendarClock className="h-4 w-4" />
              Create schedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Runs drawer */}
      <Dialog
        open={!!runsOpen}
        onOpenChange={(o) => !o && setRunsOpen(null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5 text-primary" />
              Recent runs
            </DialogTitle>
            <DialogDescription>
              Latest 50 fires of <strong>{runsOpen?.name}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] overflow-y-auto">
            {runsLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : runs.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                No runs yet. The first one fires at the next cron match.
              </p>
            ) : (
              <ul className="divide-y">
                {runs.map((r) => (
                  <li key={r.id} className="py-2 text-xs">
                    <div className="flex items-start gap-2">
                      {r.status === "completed" ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
                      ) : r.status === "failed" ? (
                        <XCircle className="mt-0.5 h-4 w-4 text-destructive" />
                      ) : (
                        <Clock className="mt-0.5 h-4 w-4" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div>
                          <Badge
                            variant={
                              r.status === "completed"
                                ? "success"
                                : r.status === "failed"
                                ? "destructive"
                                : "secondary"
                            }
                            className="text-[10px]"
                          >
                            {r.status}
                          </Badge>{" "}
                          <span className="text-muted-foreground">
                            {new Date(r.firedAt).toLocaleString()}
                          </span>
                        </div>
                        {r.error && (
                          <pre className="mt-1 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px] text-destructive">
                            {r.error}
                          </pre>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => runsOpen && openRuns(runsOpen)}
            >
              <History className="h-4 w-4" />
              Refresh
            </Button>
            <Button onClick={() => setRunsOpen(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
