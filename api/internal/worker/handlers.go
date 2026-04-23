// Package worker contains Asynq task handlers that consume generation jobs.
package worker

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/docforge/api/internal/batchdata"
	"github.com/docforge/api/internal/generate"
	"github.com/docforge/api/internal/jobs"
	"github.com/docforge/api/internal/queue"
	"github.com/docforge/api/internal/storage"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
)


type Handlers struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
	Runner  *generate.Runner
	Log     *slog.Logger
}

func (h *Handlers) Register(mux *asynq.ServeMux) {
	mux.HandleFunc(queue.TaskGenerateOne, h.generateOne)
	mux.HandleFunc(queue.TaskGenerateBatch, h.generateBatch)
}

func (h *Handlers) generateOne(ctx context.Context, t *asynq.Task) error {
	var p queue.GenerateOnePayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("bad payload: %w", err)
	}
	h.Log.Info("job started", "kind", "one", "job", p.JobID)
	_ = jobs.MarkRunning(ctx, h.DB, p.JobID)

	res, err := h.Runner.Run(ctx, p.OrgID, p.UserID, p.TemplateID, p.Data, p.Flatten)
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
