"use client";

/**
 * DocChatPanel — the "Summarize / Ask" side panel that mounts inside
 * PdfViewerDialog (and any other preview surface that wants it). It
 * talks to two endpoints:
 *
 *   POST /v1/files/{id}/summarize
 *   POST /v1/files/{id}/ask          body: { question }
 *
 * # State machine
 *
 * The panel lives in three modes, in order:
 *
 *   1. idle      — nothing has been requested yet. We auto-fire a
 *                  Summarize on first mount so the user gets the
 *                  document's gist without an extra click; failing
 *                  silently if AI is off (the parent already gates
 *                  this panel behind AIFeature, so this branch is
 *                  defense in depth for stale page loads).
 *   2. running   — a request is in flight. The composer is locked to
 *                  prevent the "ask while summarizing" race that, on
 *                  a slow provider, would interleave responses out of
 *                  order. We could in principle cancel, but the cost
 *                  of a wasted summary is small enough not to bother.
 *   3. answered  — at least one turn has resolved. The conversation
 *                  list is append-only; "Summarize" can be re-run and
 *                  shows up as a new turn rather than replacing the
 *                  prior one.
 *
 * # Why a turn list, not a chat thread
 *
 * Each /ask call is independent — the backend doesn't carry prior
 * turns into the prompt context (one document, one question). Showing
 * the turns visually as if they were a real chat would suggest
 * follow-up references work ("what about clause 4?" after "summarize
 * clause 3"), which they don't. Each turn is rendered as a self-
 * contained Q&A card so the affordance matches the actual model
 * behaviour.
 *
 * # Truncation disclosure
 *
 * The backend tells us when it had to clip the document to fit the
 * prompt window. The footnote on truncated turns is critical for the
 * "the model said the doc doesn't mention X but it actually does"
 * support case — the user can see the answer was based on a partial
 * read.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Send, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";

type SummaryResponse = {
  summary: string;
  keyPoints: string[];
  suggestedQuestions: string[];
  truncated: boolean;
  provider: string;
  model?: string;
};

type AskResponse = {
  answer: string;
  truncated: boolean;
  provider: string;
  model?: string;
};

type Turn =
  | {
      kind: "summary";
      id: string;
      data: SummaryResponse;
    }
  | {
      kind: "ask";
      id: string;
      question: string;
      data: AskResponse;
    };

export interface DocChatPanelProps {
  fileId: string;
  fileName: string;
  /** Notifier from the dialog — when the dialog closes we want to
   *  abort any in-flight request and reset state on next open. */
  open: boolean;
  /** Close-the-panel handler from the dialog header. */
  onClose?: () => void;
}

export function DocChatPanel({
  fileId,
  fileName,
  open,
  onClose,
}: DocChatPanelProps) {
  const toast = useToast();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<"summary" | "ask" | null>(null);
  // Track the most recent fileId we mounted against so we can reset
  // turns when the dialog is reused for a different file (Drive list
  // → click row A → close → click row B all without unmounting the
  // dialog). React key reassignment on the parent would also work,
  // but resetting here keeps the panel a drop-in regardless of how
  // the parent manages the dialog lifecycle.
  const lastFileIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Reset on file change OR on close. We don't preserve turns across
  // dialog opens — they were specific to that document and persisting
  // them would just confuse "wait, I closed the panel a minute ago,
  // why is the answer still here?"
  useEffect(() => {
    if (!open) {
      setTurns([]);
      setQuestion("");
      setBusy(null);
      lastFileIdRef.current = null;
      return;
    }
    if (lastFileIdRef.current !== fileId) {
      setTurns([]);
      setQuestion("");
      setBusy(null);
      lastFileIdRef.current = fileId;
    }
  }, [open, fileId]);

  // Auto-scroll to the latest turn whenever turns change. The
  // conversation grows downward; a user who has scrolled up to read
  // an earlier turn shouldn't be slammed back to the bottom — but in
  // practice the panel is short enough that the gain from "always
  // see the latest answer" outweighs the friction.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns.length, busy]);

  const runSummarize = useCallback(async () => {
    if (busy) return;
    setBusy("summary");
    try {
      const res = await api<SummaryResponse>(
        `/v1/files/${fileId}/summarize`,
        { method: "POST" },
      );
      setTurns((xs) => [
        ...xs,
        { kind: "summary", id: cryptoId(), data: res },
      ]);
    } catch (e: any) {
      // 503 ai_disabled and 415 not_textual both surface here. The
      // toast is the only place the user sees the cause; we don't
      // bake an error into the turn list because every turn there
      // implies a successful round-trip with the model.
      toast.show("error", "Summarize failed", { description: e.message });
    } finally {
      setBusy(null);
    }
  }, [busy, fileId, toast]);

  const runAsk = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (!q || busy) return;
      setQuestion("");
      setBusy("ask");
      try {
        const res = await api<AskResponse>(`/v1/files/${fileId}/ask`, {
          method: "POST",
          body: JSON.stringify({ question: q }),
        });
        setTurns((xs) => [
          ...xs,
          { kind: "ask", id: cryptoId(), question: q, data: res },
        ]);
      } catch (e: any) {
        toast.show("error", "Ask failed", { description: e.message });
        // Restore the question on failure so the user doesn't have to
        // retype it after a network blip.
        setQuestion(q);
      } finally {
        setBusy(null);
      }
    },
    [busy, fileId, toast],
  );

  // Auto-summarize on first open. Wrapped in a ref-guarded effect so a
  // re-render doesn't refetch — only the first transition into open
  // for a given fileId fires this.
  const autoFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    if (autoFiredRef.current === fileId) return;
    autoFiredRef.current = fileId;
    runSummarize();
  }, [open, fileId, runSummarize]);

  // Keyboard shortcut: Enter sends, Shift+Enter newline. Same shape
  // as ChatGPT/Claude composers so muscle memory carries over.
  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runAsk(question);
    }
  };

  // Truncation footer text shared by both turn types. Clipped at 16KB
  // on the backend; we don't surface the exact byte count because it
  // would invite "why this byte limit?" questions that distract from
  // the headline message ("answer is based on a partial read").
  const truncationNote = useMemo(
    () =>
      "Based on the first portion of the document — longer files are clipped before summarising.",
    [],
  );

  return (
    <aside
      className={cn(
        "flex h-full w-[360px] shrink-0 flex-col border-l bg-background",
        // The shadow is intentionally subtle — the dialog already has
        // its own elevation; double-shadow looks crowded.
        "shadow-[inset_1px_0_0_0_rgba(0,0,0,0.04)]",
      )}
      aria-label={`AI assistant for ${fileName}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Sparkles className="h-4 w-4 text-sky-500" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold">AI assistant</div>
          <div className="truncate text-[10px] text-muted-foreground">
            Summary + Q&amp;A for this document
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={runSummarize}
          disabled={busy === "summary"}
          aria-label="Re-run summary"
          title="Re-run summary"
          className="h-7 w-7"
        >
          {busy === "summary" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close AI panel"
            className="h-7 w-7"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Body — conversation list */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {turns.length === 0 && busy !== "summary" && (
          <EmptyHint onSummarize={runSummarize} />
        )}
        {busy === "summary" && turns.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Reading the document…
          </div>
        )}
        <div className="space-y-3">
          {turns.map((t) =>
            t.kind === "summary" ? (
              <SummaryCard
                key={t.id}
                data={t.data}
                truncationNote={truncationNote}
                onAsk={runAsk}
              />
            ) : (
              <AskCard
                key={t.id}
                question={t.question}
                data={t.data}
                truncationNote={truncationNote}
              />
            ),
          )}
          {busy === "ask" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Thinking…
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t p-2">
        <div className="relative">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onComposerKey}
            placeholder="Ask a question about this document…"
            rows={2}
            disabled={busy !== null}
            className="flex w-full resize-none rounded-md border border-input bg-background px-3 py-2 pr-10 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Button
            size="icon"
            onClick={() => runAsk(question)}
            disabled={busy !== null || !question.trim()}
            aria-label="Ask"
            className="absolute right-1.5 top-1.5 h-7 w-7"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="mt-1 text-[9px] text-muted-foreground">
          Press Enter to send · Shift+Enter for newline
        </div>
      </div>
    </aside>
  );
}

/* ---------------------- card sub-components --------------------- */

function SummaryCard({
  data,
  truncationNote,
  onAsk,
}: {
  data: SummaryResponse;
  truncationNote: string;
  onAsk: (q: string) => void;
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Sparkles className="h-3 w-3 text-sky-500" />
        Summary
      </div>
      {data.summary ? (
        <p className="text-xs leading-relaxed text-foreground">
          {data.summary}
        </p>
      ) : (
        <p className="text-xs italic text-muted-foreground">
          The model didn&rsquo;t produce a summary for this document.
        </p>
      )}
      {data.keyPoints.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] leading-snug">
          {data.keyPoints.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {data.suggestedQuestions.length > 0 && (
        <div className="mt-2.5">
          <div className="mb-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
            Try asking
          </div>
          <div className="flex flex-wrap gap-1">
            {data.suggestedQuestions.map((q, i) => (
              <button
                key={i}
                onClick={() => onAsk(q)}
                className="rounded-full border bg-background px-2 py-0.5 text-[10px] text-foreground transition-colors hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700 dark:hover:border-sky-700 dark:hover:bg-sky-950 dark:hover:text-sky-200"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
      {data.truncated && (
        <div className="mt-2 text-[10px] italic text-muted-foreground">
          {truncationNote}
        </div>
      )}
    </div>
  );
}

function AskCard({
  question,
  data,
  truncationNote,
}: {
  question: string;
  data: AskResponse;
  truncationNote: string;
}) {
  return (
    <div className="rounded-md border bg-background p-2.5">
      <div className="mb-1 text-[11px] font-medium text-foreground">
        {question}
      </div>
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
        {data.answer}
      </p>
      {data.truncated && (
        <div className="mt-1.5 text-[10px] italic text-muted-foreground">
          {truncationNote}
        </div>
      )}
    </div>
  );
}

function EmptyHint({ onSummarize }: { onSummarize: () => void }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 p-3 text-center">
      <Sparkles className="mx-auto h-4 w-4 text-sky-500" />
      <div className="mt-1.5 text-xs font-medium">Ask anything about this file</div>
      <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
        I can summarise it, pick out key points, and answer questions
        based on its contents.
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={onSummarize}
        className="mt-2 h-7 gap-1.5 text-[10px]"
      >
        <Sparkles className="h-3 w-3" />
        Summarise this document
      </Button>
    </div>
  );
}

/* --------------------------- helpers --------------------------- */

// cryptoId is a tiny stable-id generator. We don't pull in a uuid lib
// for two-character IDs that are scoped to a single dialog instance.
function cryptoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}
