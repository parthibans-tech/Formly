package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/docforge/api/internal/queue"
	"github.com/docforge/api/internal/scanner"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
)

// scanFile is the asynq entry point for TaskScanFile. The flow is:
//
//  1. Mark scan_jobs.status='running', attempts++.
//  2. Fetch the blob bytes (streaming) from object storage.
//  3. Hand the reader to the configured Scanner.
//  4. Stamp the verdict back onto files.scan_status / scan_signature /
//     scan_engine / scanned_at, and flip files.status to 'active' on
//     a clean/skipped verdict so the download gate releases.
//  5. Update scan_jobs with the verdict + finished_at.
//
// Why we don't return the scanner error to asynq on engine "Errored"
// outcomes: those mean the engine answered (e.g. archive-bomb, parse
// failure) — retrying won't change the answer. Network / TCP failures
// surface as a Go error from Scan() and DO bubble to asynq so its
// retry budget kicks in.
func (h *Handlers) scanFile(ctx context.Context, t *asynq.Task) error {
	var p queue.ScanFilePayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("bad payload: %w", err)
	}
	if h.Scanner == nil {
		// Mis-wired worker — without a scanner we can't process the job.
		// Don't loop on retries; fail loudly so the operator notices.
		return fmt.Errorf("scan worker not configured (Handlers.Scanner is nil)")
	}
	h.Log.Info("scan started", "job", p.JobID, "file", p.FileID, "engine", h.Scanner.Name())

	// Mark the job running. If the row vanished (file deleted between
	// enqueue and run) we ack the task — nothing to do.
	if _, err := h.DB.Exec(ctx,
		`UPDATE scan_jobs
		    SET status='running', attempts=attempts+1, started_at=now()
		  WHERE id=$1`,
		p.JobID,
	); err != nil {
		return fmt.Errorf("mark running: %w", err)
	}

	// Pull the file metadata so the scanner has a name to log against and
	// we can short-circuit if the file is already deleted.
	var name string
	var size int64
	err := h.DB.QueryRow(ctx,
		`SELECT name, COALESCE(size, 0) FROM files WHERE id=$1 AND org_id=$2`,
		p.FileID, p.OrgID,
	).Scan(&name, &size)
	if errors.Is(err, pgx.ErrNoRows) {
		h.Log.Warn("scan: file vanished, dropping job", "file", p.FileID, "job", p.JobID)
		_ = h.markScanJobError(ctx, p.JobID, "file deleted before scan")
		return nil
	}
	if err != nil {
		return fmt.Errorf("load file: %w", err)
	}

	// Stream the blob into the scanner. Using GetReader (not GetBytes)
	// keeps memory bounded even on multi-hundred-MB uploads.
	rc, _, gerr := h.Storage.GetReader(ctx, p.StorageKey)
	if gerr != nil {
		_ = h.markScanJobError(ctx, p.JobID, "fetch blob: "+gerr.Error())
		_ = h.markFileScan(ctx, p.FileID, scanner.Verdict{
			Errored: true, Engine: h.Scanner.Name(),
			Message: "fetch blob: " + gerr.Error(),
		})
		// Returning the error lets asynq retry — transient S3 hiccups
		// recover quickly; persistent ones get logged and eventually
		// land in scan_jobs.last_error.
		return gerr
	}
	defer rc.Close()

	verdict, scanErr := h.Scanner.Scan(ctx, name, rc, size)
	if scanErr != nil {
		// Transport-level failure (TCP, timeout). The verdict is already
		// Errored=true; we still persist it so the gate stays
		// fail-closed, then bubble the error so asynq retries.
		_ = h.markFileScan(ctx, p.FileID, verdict)
		_ = h.markScanJobError(ctx, p.JobID, scanErr.Error())
		return scanErr
	}

	if err := h.markFileScan(ctx, p.FileID, verdict); err != nil {
		return fmt.Errorf("persist file verdict: %w", err)
	}
	if err := h.markScanJobDone(ctx, p.JobID, verdict); err != nil {
		return fmt.Errorf("persist scan_job verdict: %w", err)
	}

	h.Log.Info("scan done",
		"job", p.JobID,
		"file", p.FileID,
		"verdict", verdict.String(),
		"signature", verdict.Signature,
		"engine", verdict.Engine,
	)
	return nil
}

// markFileScan stamps the verdict onto the files row. On a clean or
// skipped verdict we ALSO flip files.status from 'scanning' to 'active'
// so the download gate releases the file. Infected / errored verdicts
// leave status alone (the gate checks scan_status separately and refuses
// release).
func (h *Handlers) markFileScan(ctx context.Context, fileID string, v scanner.Verdict) error {
	// Single UPDATE so the row transitions atomically. The CASE on
	// status preserves any non-scanning state (e.g. operator manually
	// quarantined the file mid-scan) instead of clobbering it.
	_, err := h.DB.Exec(ctx, `
		UPDATE files
		   SET scan_status    = $1,
		       scan_signature = NULLIF($2, ''),
		       scan_engine    = NULLIF($3, ''),
		       scanned_at     = now(),
		       status         = CASE
		           WHEN status = 'scanning' AND $1 IN ('clean', 'skipped') THEN 'active'
		           ELSE status
		       END,
		       updated_at     = now()
		 WHERE id = $4`,
		v.String(), v.Signature, v.Engine, fileID,
	)
	return err
}

func (h *Handlers) markScanJobDone(ctx context.Context, jobID string, v scanner.Verdict) error {
	status := "done"
	if v.Errored {
		status = "error"
	}
	_, err := h.DB.Exec(ctx, `
		UPDATE scan_jobs
		   SET status      = $1,
		       verdict     = $2,
		       signature   = NULLIF($3, ''),
		       engine      = NULLIF($4, ''),
		       last_error  = NULLIF($5, ''),
		       finished_at = now()
		 WHERE id = $6`,
		status, v.String(), v.Signature, v.Engine, v.Message, jobID,
	)
	return err
}

func (h *Handlers) markScanJobError(ctx context.Context, jobID, msg string) error {
	_, err := h.DB.Exec(ctx, `
		UPDATE scan_jobs
		   SET status='error', last_error=$1, finished_at=now()
		 WHERE id=$2`,
		msg, jobID,
	)
	return err
}
