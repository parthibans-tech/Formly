package worker

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/docforge/api/internal/queue"
	"github.com/hibiken/asynq"
)

// embedFile is the asynq entry point for TaskEmbedFile. The heavy
// lifting (extract → chunk → embed → INSERT) lives in
// embeddings.Embedder.EmbedFile, mirroring how scanFile delegates to
// scanner.Scanner. Keeping the handler thin means tests of the
// orchestrator don't need to spin up asynq.
//
// Why we don't return an error to asynq when the Embedder marks the
// file 'skipped': those are non-recoverable "this file isn't textual"
// outcomes. Retrying a non-textual file produces the same skip;
// returning the error would chew through the retry budget for no gain.
// Genuine transport failures (Ollama down, DB hiccup) DO bubble up so
// asynq's exponential-backoff covers them.
func (h *Handlers) embedFile(ctx context.Context, t *asynq.Task) error {
	var p queue.EmbedFilePayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("bad payload: %w", err)
	}
	if h.Embedder == nil {
		// AI was on at enqueue time but the worker started without an
		// embedder configured (operator flipped AI off, or misconfigured
		// AI_PROVIDER). Don't retry-storm; ack and move on. The file's
		// embed_status stays whatever it was (typically pending) and
		// an operator can re-enqueue once the worker is properly wired.
		h.Log.Warn("embed: worker has no Embedder, dropping job",
			"file", p.FileID, "job", p.JobID)
		return nil
	}
	h.Log.Info("embed started", "file", p.FileID, "job", p.JobID)
	if err := h.Embedder.EmbedFile(ctx, p.OrgID, p.FileID, p.StorageKey, p.MIME); err != nil {
		h.Log.Error("embed failed", "file", p.FileID, "job", p.JobID, "err", err)
		return err
	}
	return nil
}
