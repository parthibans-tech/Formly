// Package queue wraps Asynq with typed task payloads and shared config.
package queue

import (
	"encoding/json"
	"os"

	"github.com/hibiken/asynq"
)

const (
	TaskGenerateOne    = "generate:one"
	TaskGenerateBatch  = "generate:batch"
	TaskWebhookDeliver = "webhook:deliver"
	// Office-doc → PDF preview pipeline. Runs after Complete() for any
	// Word/RTF/ODT/etc. upload; produces a sibling PDF and links it back
	// via files.preview_pdf_id. See internal/docconvert.
	TaskConvertToPDF = "convert:pdf"
	// PDF merge / stitch pipeline. Triggered by /v1/files/merge when the
	// inputs need LibreOffice conversion or are too large for inline
	// processing. Worker writes a `merge_jobs` row through to `done`
	// (with output file_id) or `failed` (with error message). See
	// internal/pdfmerge.
	TaskMergePDF = "merge:pdf"
	// Saved-recipe merge run. Triggered by POST
	// /v1/merge-recipes/:id/run when the recipe's components include
	// non-trivial sources (templates that need rendering, soffice
	// conversion, large totals). Worker:
	//   1. Loads the recipe + components.
	//   2. Renders each template component via generate.Runner.RenderInline.
	//   3. Fetches each file component's bytes from storage.
	//   4. Stitches via pdfmerge.AssembleInline.
	//   5. Persists the output file and updates merge_recipe_jobs.
	TaskRunMergeRecipe = "merge:recipe:run"
)

// RedisAddr returns the Redis connection string (from env, default to localhost).
func RedisAddr() string {
	if v := os.Getenv("REDIS_ADDR"); v != "" {
		return v
	}
	return "localhost:6379"
}

func ClientOpt() asynq.RedisClientOpt {
	return asynq.RedisClientOpt{Addr: RedisAddr()}
}

// GenerateOnePayload describes a single async generation job.
// The job_id column in generation_jobs is the source of truth for status.
type GenerateOnePayload struct {
	JobID      string                 `json:"jobId"`
	OrgID      string                 `json:"orgId"`
	UserID     string                 `json:"userId"`
	TemplateID string                 `json:"templateId"`
	Data       map[string]interface{} `json:"data"`
	Flatten    bool                   `json:"flatten"`
}

// GenerateBatchPayload references a previously-uploaded tabular input via
// MinIO key. `Kind` describes the format (csv | xlsx | tsv) so the worker
// knows how to parse it.
type GenerateBatchPayload struct {
	JobID      string `json:"jobId"`
	OrgID      string `json:"orgId"`
	UserID     string `json:"userId"`
	TemplateID string `json:"templateId"`
	CSVKey     string `json:"csvKey"`
	Kind       string `json:"kind,omitempty"` // csv (default) | xlsx | tsv
	OutputName string `json:"outputName"`
}

func NewGenerateOne(p GenerateOnePayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	return asynq.NewTask(TaskGenerateOne, b, asynq.MaxRetry(3)), nil
}

func NewGenerateBatch(p GenerateBatchPayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	return asynq.NewTask(TaskGenerateBatch, b, asynq.MaxRetry(1)), nil
}

// WebhookDeliverPayload describes a single outgoing webhook attempt. The task
// handler signs the body, POSTs it, records the result, and asynq's MaxRetry
// mechanism drives exponential backoff on non-2xx responses.
type WebhookDeliverPayload struct {
	WebhookID string          `json:"webhookId"`
	Event     string          `json:"event"`
	Body      json.RawMessage `json:"body"`
}

// ConvertToPDFPayload requests a worker-side LibreOffice conversion of a
// previously-uploaded source file (DOC/DOCX/RTF/ODT/...) into a PDF
// preview. The worker writes the output as a new file row owned by the
// same user/org and links it back via files.preview_pdf_id on the
// source row.
type ConvertToPDFPayload struct {
	OrgID  string `json:"orgId"`
	UserID string `json:"userId"`
	FileID string `json:"fileId"`
}

func NewConvertToPDF(p ConvertToPDFPayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	// 2 retries — first fails are usually transient soffice startup
	// issues; persistent failures are unsupported formats and won't
	// recover with more attempts.
	return asynq.NewTask(TaskConvertToPDF, b, asynq.MaxRetry(2)), nil
}

// MergePDFSource mirrors pdfmerge.MergeSource. We duplicate the type
// here (rather than importing pdfmerge) to keep `internal/queue`
// dependency-free — workers and HTTP handlers both depend on `queue`,
// so importing pdfmerge would create a cycle the moment the worker
// itself is wired up.
type MergePDFSource struct {
	FileID string `json:"fileId"`
	Pages  string `json:"pages,omitempty"`
}

// MergePDFPayload is consumed by the asynq worker registered for
// TaskMergePDF. The worker:
//   1. SELECTs the merge_jobs row (status='queued') by JobID, marks it 'running'.
//   2. For each Source: ACL check, fetch bytes, run docconvert if non-PDF.
//   3. Concatenates with pdfcpu, uploads to MinIO, INSERTs the output
//      file row, links it on merge_jobs.file_id, marks 'done'.
//   4. On error: writes the error message to merge_jobs.error and
//      marks 'failed'. Asynq retries cover transient failures (≤2).
type MergePDFPayload struct {
	JobID    string           `json:"jobId"`
	OrgID    string           `json:"orgId"`
	UserID   string           `json:"userId"`
	Name     string           `json:"name"`
	FolderID string           `json:"folderId,omitempty"`
	Sources  []MergePDFSource `json:"sources"`
}

func NewMergePDF(p MergePDFPayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	// 2 retries — most failures are unsupported source formats which
	// won't recover with retries; transient soffice / S3 hiccups
	// usually clear in one.
	return asynq.NewTask(TaskMergePDF, b, asynq.MaxRetry(2)), nil
}

// RunMergeRecipePayload is the worker-side view of a merge-recipe run.
// The recipe + components are loaded at run-time from the DB (so a
// recipe edit between enqueue and execute is honored — that's what an
// "async run" semantically promises). Data is the full caller payload;
// each template component reads only data[component.DataKey].
type RunMergeRecipePayload struct {
	JobID      string                 `json:"jobId"`
	OrgID      string                 `json:"orgId"`
	UserID     string                 `json:"userId"`
	RecipeID   string                 `json:"recipeId"`
	Data       map[string]interface{} `json:"data"`
	OutputName string                 `json:"outputName,omitempty"`
	FolderID   string                 `json:"folderId,omitempty"`
}

func NewRunMergeRecipe(p RunMergeRecipePayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	return asynq.NewTask(TaskRunMergeRecipe, b, asynq.MaxRetry(2)), nil
}

func NewWebhookDeliver(p WebhookDeliverPayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	// 5 retries with asynq's default exponential backoff (≈ 1m, 5m, 30m, 2h, 12h).
	return asynq.NewTask(TaskWebhookDeliver, b, asynq.MaxRetry(5)), nil
}
