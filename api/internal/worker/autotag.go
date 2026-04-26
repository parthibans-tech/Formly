package worker

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/docforge/api/internal/queue"
	"github.com/hibiken/asynq"
)

// autoTagFile is the asynq entry point for TaskAutoTagFile. The whole
// orchestration (extract → ask model → parse → persist) lives in
// autotag.Tagger.TagFile so the worker stays a thin adapter.
//
// As with embedFile, a nil Tagger means the worker started without AI
// configured (operator flipped AI off mid-flight). We log + ack rather
// than retry-storm; the file's auto_tag_status stays in whatever state
// it was (likely 'pending') and an operator can re-enqueue once AI is
// back on.
func (h *Handlers) autoTagFile(ctx context.Context, t *asynq.Task) error {
	var p queue.AutoTagFilePayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("bad payload: %w", err)
	}
	if h.Tagger == nil {
		h.Log.Warn("autotag: worker has no Tagger, dropping job",
			"file", p.FileID, "job", p.JobID)
		return nil
	}
	h.Log.Info("autotag started", "file", p.FileID, "job", p.JobID)
	if err := h.Tagger.TagFile(ctx, p.OrgID, p.FileID, p.StorageKey, p.MIME, p.Name); err != nil {
		h.Log.Error("autotag failed", "file", p.FileID, "job", p.JobID, "err", err)
		return err
	}
	return nil
}
