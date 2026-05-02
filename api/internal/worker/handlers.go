// Package worker contains Asynq task handlers that consume generation jobs.
package worker

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/docforge/api/internal/autotag"
	"github.com/docforge/api/internal/batchdata"
	"github.com/docforge/api/internal/docconvert"
	"github.com/docforge/api/internal/embeddings"
	"github.com/docforge/api/internal/generate"
	"github.com/docforge/api/internal/jobs"
	"github.com/docforge/api/internal/mergerecipes"
	"github.com/docforge/api/internal/pdfmerge"
	"github.com/docforge/api/internal/queue"
	"github.com/docforge/api/internal/scanner"
	"github.com/docforge/api/internal/storage"
	"github.com/docforge/api/internal/uploadpolicy"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
)


type Handlers struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
	Runner  *generate.Runner
	Log     *slog.Logger
	// PDFMerge is reused from the HTTP layer so the worker shares the
	// same preflight / assemble / persist code path. Constructed in
	// cmd/worker/main.go after DB + Storage are up.
	PDFMerge *pdfmerge.Handler
	// MergeRecipes powers TaskRunMergeRecipe — the worker side of saved
	// recipe runs. Same handler the HTTP layer uses; the worker just
	// invokes RunForJob instead of the HTTP entry.
	MergeRecipes *mergerecipes.Handler
	// Scanner powers TaskScanFile. Selected by scanner.FromEnv at
	// startup so dev/CI default to Noop and prod attaches to ClamAV.
	// Nil = scan handler refuses to run (fail-loud, not silent-pass).
	Scanner scanner.Scanner
	// Embedder powers TaskEmbedFile (AI smart-search index build).
	// Nil = embed handler logs a warning and acks the job rather than
	// retry-storming; that path runs when AI was on at enqueue time
	// but the worker started without an AI client (operator flipped
	// AI_ENABLED off between enqueue and process).
	Embedder *embeddings.Embedder
	// Tagger powers TaskAutoTagFile (AI auto-tag + auto-rename). Same
	// nil-safety as Embedder above: a nil Tagger means the worker has
	// no AI client and we ack-without-retry on incoming jobs so flipping
	// AI off between enqueue and dequeue doesn't strand the queue.
	Tagger *autotag.Tagger
}

func (h *Handlers) Register(mux *asynq.ServeMux) {
	mux.HandleFunc(queue.TaskGenerateOne, h.generateOne)
	mux.HandleFunc(queue.TaskGenerateBatch, h.generateBatch)
	mux.HandleFunc(queue.TaskConvertToPDF, h.convertToPDF)
	mux.HandleFunc(queue.TaskMergePDF, h.mergePDF)
	mux.HandleFunc(queue.TaskRunMergeRecipe, h.runMergeRecipe)
	mux.HandleFunc(queue.TaskScanFile, h.scanFile)
	mux.HandleFunc(queue.TaskEmbedFile, h.embedFile)
	mux.HandleFunc(queue.TaskAutoTagFile, h.autoTagFile)
}

// runMergeRecipe is the asynq entry point for TaskRunMergeRecipe. The
// real work (loading the recipe, rendering each template component,
// fetching each file component, stitching, persisting) lives in
// mergerecipes.Handler.RunForJob so the HTTP and worker paths share
// identical code.
func (h *Handlers) runMergeRecipe(ctx context.Context, t *asynq.Task) error {
	var p queue.RunMergeRecipePayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("bad payload: %w", err)
	}
	if h.MergeRecipes == nil {
		return fmt.Errorf("merge-recipes worker not configured")
	}
	h.Log.Info("recipe run started", "job", p.JobID, "recipe", p.RecipeID)
	if err := h.MergeRecipes.RunForJob(ctx, p); err != nil {
		h.Log.Error("recipe run failed", "job", p.JobID, "err", err)
		return err
	}
	h.Log.Info("recipe run done", "job", p.JobID)
	return nil
}

// mergePDF is the asynq entry point for TaskMergePDF. The actual work
// (preflight, fetch, soffice convert, pdfcpu merge, persist, link
// merge_jobs row) lives in pdfmerge.Handler.RunQueuedMerge so the HTTP
// fast path and the worker run identical code.
func (h *Handlers) mergePDF(ctx context.Context, t *asynq.Task) error {
	var p queue.MergePDFPayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("bad payload: %w", err)
	}
	if h.PDFMerge == nil {
		// Mis-wired worker — without the merge handler we can't process
		// the job. Don't loop on retries; fail loudly.
		return fmt.Errorf("merge worker not configured")
	}
	h.Log.Info("merge started", "job", p.JobID, "sources", len(p.Sources))

	srcs := make([]pdfmerge.MergeSource, len(p.Sources))
	for i, s := range p.Sources {
		srcs[i] = pdfmerge.MergeSource{FileID: s.FileID, Pages: s.Pages}
	}
	err := h.PDFMerge.RunQueuedMerge(ctx, pdfmerge.JobInput{
		JobID:    p.JobID,
		OrgID:    p.OrgID,
		UserID:   p.UserID,
		Name:     p.Name,
		FolderID: p.FolderID,
		Sources:  srcs,
	})
	if err != nil {
		h.Log.Error("merge failed", "job", p.JobID, "err", err)
		return err
	}
	h.Log.Info("merge done", "job", p.JobID)
	return nil
}

// convertToPDF runs LibreOffice on a previously-uploaded source file
// and stores the resulting PDF as a new files row, linked back to the
// source via files.preview_pdf_id. Idempotent on the link side — a
// second run for the same source overwrites preview_pdf_id but leaves
// orphan rows behind (cleanup is a separate sweeper concern).
func (h *Handlers) convertToPDF(ctx context.Context, t *asynq.Task) error {
	var p queue.ConvertToPDFPayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("bad payload: %w", err)
	}
	h.Log.Info("convert started", "file", p.FileID)

	// Pull source metadata + bytes. If the file is gone (deleted before
	// the worker picked the job up) we ack the task instead of retrying.
	var name, mime, key string
	if err := h.DB.QueryRow(ctx,
		`SELECT name, mime, storage_key FROM files WHERE id=$1 AND org_id=$2`,
		p.FileID, p.OrgID,
	).Scan(&name, &mime, &key); err != nil {
		h.Log.Warn("convert: source file not found, dropping", "file", p.FileID, "err", err)
		return nil
	}

	src, err := h.Storage.GetBytes(ctx, key)
	if err != nil {
		_ = h.markConvertFailed(ctx, p.FileID, "read source: "+err.Error())
		return err
	}

	res, err := docconvert.Convert(ctx, src, name)
	if err != nil {
		switch {
		case errors.Is(err, docconvert.ErrUnsupported):
			_ = h.markConvertStatus(ctx, p.FileID, "unsupported", err.Error())
			return nil // don't retry — soffice can't read this format
		case errors.Is(err, docconvert.ErrSofficeMissing):
			h.Log.Error("convert: soffice not installed; leaving file pending", "file", p.FileID)
			// Keep status='pending' so a retry on a properly-provisioned
			// worker will succeed. Returning the error makes asynq
			// retry per the task's MaxRetry budget.
			return err
		default:
			_ = h.markConvertFailed(ctx, p.FileID, err.Error())
			return err
		}
	}

	// Upload the rendered PDF as a sibling object. Key follows the
	// `previews/` namespace so it never collides with org/files/<id>
	// (sources) or org/outputs/<id> (generated docs).
	pdfName := strings.TrimSuffix(filepath.Base(name), filepath.Ext(name)) + ".pdf"
	// Slugify the source-derived name before it lands in a key — the
	// stem traces back to whatever the user uploaded, so it carries
	// the same risks as a fresh upload.
	pdfKey := fmt.Sprintf("orgs/%s/previews/%s/%s",
		p.OrgID, p.FileID, uploadpolicy.SafeStorageSlug(pdfName))
	if err := h.Storage.PutBytes(ctx, pdfKey, "application/pdf", res.PDF); err != nil {
		_ = h.markConvertFailed(ctx, p.FileID, "store pdf: "+err.Error())
		return err
	}

	// Insert the preview file row (active immediately — not a pending
	// upload). Same org/owner as the source so visibility/sharing rules
	// continue to work without a second ACL entry.
	var previewID string
	if err := h.DB.QueryRow(ctx, `
		INSERT INTO files (org_id, owner_id, name, mime, size, storage_key, status)
		SELECT $1, owner_id, $2, 'application/pdf', $3, $4, 'active'
		  FROM files WHERE id=$5 AND org_id=$1
		RETURNING id`,
		p.OrgID, pdfName, len(res.PDF), pdfKey, p.FileID,
	).Scan(&previewID); err != nil {
		_ = h.markConvertFailed(ctx, p.FileID, "insert preview: "+err.Error())
		return err
	}

	status := "ready"
	warning := res.Warning
	if warning != "" {
		status = "macro_warning"
	}
	if _, err := h.DB.Exec(ctx, `
		UPDATE files
		   SET preview_pdf_id=$1, convert_status=$2, convert_warning=$3, updated_at=now()
		 WHERE id=$4`,
		previewID, status, warning, p.FileID,
	); err != nil {
		return err
	}
	h.Log.Info("convert done", "file", p.FileID, "preview", previewID, "warning", warning)
	return nil
}

func (h *Handlers) markConvertStatus(ctx context.Context, fileID, status, warning string) error {
	_, err := h.DB.Exec(ctx,
		`UPDATE files SET convert_status=$1, convert_warning=$2, updated_at=now() WHERE id=$3`,
		status, warning, fileID,
	)
	return err
}

func (h *Handlers) markConvertFailed(ctx context.Context, fileID, msg string) error {
	return h.markConvertStatus(ctx, fileID, "failed", msg)
}

func (h *Handlers) generateOne(ctx context.Context, t *asynq.Task) error {
	var p queue.GenerateOnePayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("bad payload: %w", err)
	}
	h.Log.Info("job started", "kind", "one", "job", p.JobID)
	_ = jobs.MarkRunning(ctx, h.DB, p.JobID)

	res, err := h.Runner.RunWithOpts(ctx, p.OrgID, p.UserID, p.TemplateID, p.Data, &generate.RunOptions{
		OutputName: p.OutputName,
		OutputPath: p.OutputPath,
		Flatten:    p.Flatten,
	})
	if err != nil {
		_ = jobs.MarkFailed(ctx, h.DB, p.JobID, err.Error())
		return err
	}
	if err := jobs.MarkDone(ctx, h.DB, p.JobID, res.OutputFileID, 1); err != nil {
		return err
	}
	h.Log.Info("job done", "kind", "one", "job", p.JobID, "output", res.OutputFileID)
	return nil
}

func (h *Handlers) generateBatch(ctx context.Context, t *asynq.Task) error {
	var p queue.GenerateBatchPayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("bad payload: %w", err)
	}
	h.Log.Info("job started", "kind", "batch", "job", p.JobID)
	_ = jobs.MarkRunning(ctx, h.DB, p.JobID)

	body, err := h.Storage.GetBytes(ctx, p.CSVKey)
	if err != nil {
		_ = jobs.MarkFailed(ctx, h.DB, p.JobID, "read input: "+err.Error())
		return err
	}
	kind := p.Kind
	if kind == "" {
		kind = "csv"
	}
	headers, dataRows, err := batchdata.Parse(kind, body)
	if err != nil {
		_ = jobs.MarkFailed(ctx, h.DB, p.JobID, err.Error())
		return err
	}

	_, _ = h.DB.Exec(ctx, `UPDATE generation_jobs SET total=$1 WHERE id=$2`, len(dataRows), p.JobID)

	// Accumulate generated PDFs in a ZIP.
	var zipBuf bytes.Buffer
	zw := zip.NewWriter(&zipBuf)

	for i, row := range dataRows {
		data := map[string]interface{}{}
		for ci, cell := range row {
			if ci < len(headers) {
				data[headers[ci]] = cell
			}
		}
		res, err := h.Runner.Run(ctx, p.OrgID, p.UserID, p.TemplateID, data, false)
		if err != nil {
			_ = jobs.MarkFailed(ctx, h.DB, p.JobID, fmt.Sprintf("row %d: %v", i+1, err))
			return err
		}
		// Re-read the rendered PDF and add to the ZIP.
		pdfBytes, err := h.Storage.GetBytes(ctx, res.OutputKey)
		if err != nil {
			_ = jobs.MarkFailed(ctx, h.DB, p.JobID, err.Error())
			return err
		}
		entryName := fmt.Sprintf("row-%03d-%s", i+1, res.OutputName)
		f, err := zw.Create(entryName)
		if err != nil {
			_ = jobs.MarkFailed(ctx, h.DB, p.JobID, err.Error())
			return err
		}
		if _, err := f.Write(pdfBytes); err != nil {
			_ = jobs.MarkFailed(ctx, h.DB, p.JobID, err.Error())
			return err
		}
		_ = jobs.UpdateProgress(ctx, h.DB, p.JobID, i+1)
	}
	if err := zw.Close(); err != nil {
		_ = jobs.MarkFailed(ctx, h.DB, p.JobID, err.Error())
		return err
	}

	zipRes, err := h.Runner.PutRaw(ctx, p.OrgID, p.UserID, p.OutputName, "application/zip", zipBuf.Bytes())
	if err != nil {
		_ = jobs.MarkFailed(ctx, h.DB, p.JobID, err.Error())
		return err
	}
	if err := jobs.MarkDone(ctx, h.DB, p.JobID, zipRes.OutputFileID, len(dataRows)); err != nil {
		return err
	}
	h.Log.Info("job done", "kind", "batch", "job", p.JobID, "rows", len(dataRows), "zip", zipRes.OutputFileID)
	return nil
}
