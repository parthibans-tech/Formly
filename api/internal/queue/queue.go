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
	// Antivirus / malware scan. Enqueued from files.Complete when the
	// org's upload policy has scanning enabled. Worker streams the blob
	// to the configured Scanner (ClamAV in prod, Noop in dev/CI),
	// stamps the verdict back on the files row, and updates the
	// scan_jobs audit row. See internal/scanner + cmd/worker.
	TaskScanFile = "scan:file"
	// AI smart-search embedding. Enqueued from files.Complete after a
	// successful upload when AI is enabled and the active provider
	// reports Embed capability. Worker:
	//   1. Marks files.embed_status='running'.
	//   2. Fetches blob bytes (text-extracted if necessary).
	//   3. Splits content into ~512-token chunks and asks the AI client
	//      to embed each one.
	//   4. INSERTs file_chunks rows (one per chunk).
	//   5. Marks files.embed_status='ready' (or 'failed' / 'skipped').
	// See internal/embeddings + migration 045.
	TaskEmbedFile = "embed:file"
	// AI auto-tag + auto-rename. Enqueued from files.Complete after a
	// successful upload when AI is enabled and the active provider
	// reports Chat capability. Worker asks the chat model for a small
	// JSON payload describing the file (3-5 tags + a suggested
	// filename), writes the tags to files.tags, stores the rename
	// suggestion in files.auto_rename_suggestion, and only overrides
	// files.name when the original looks generic (IMG_*, scan.pdf,
	// untitled.txt, etc.). See internal/autotag + migration 046.
	TaskAutoTagFile = "autotag:file"
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
//
// OutputName / OutputPath mirror the request body's per-call overrides
// so async jobs honour the same naming/folder hints sync calls do.
// Both are optional ({{key}} substitution still happens against Data).
type GenerateOnePayload struct {
	JobID      string                 `json:"jobId"`
	OrgID      string                 `json:"orgId"`
	UserID     string                 `json:"userId"`
	TemplateID string                 `json:"templateId"`
	Data       map[string]interface{} `json:"data"`
	// Flatten is a pointer so we can distinguish "request body omitted
	// flatten — fall back to template's output.flattenDefault" (nil)
	// from "explicitly false, do not flatten regardless of the template
	// default" (&false). Existing payloads that serialised `false`
	// continue to deserialise into a non-nil pointer.
	Flatten    *bool  `json:"flatten,omitempty"`
	OutputName string `json:"outputName,omitempty"`
	OutputPath string `json:"outputPath,omitempty"`
	// SaveToDrive mirrors the sync handler's req.SaveToDrive — pointer
	// so nil = "use legacy default of true", &false = "render to an
	// ephemeral presigned URL only, don't persist". Without this field
	// every async render unconditionally saved to Drive even when the
	// caller asked for an ephemeral one. The worker hands it through
	// to RunOptions.Persist verbatim.
	SaveToDrive *bool `json:"saveToDrive,omitempty"`
	// Security mirrors the sync handler's per-call security override
	// (passwords, encryption, permissions). Stored as raw JSON so this
	// package doesn't need a build-time dep on the generate package
	// (which itself imports queue indirectly via the worker). The
	// worker re-decodes into generate.SecurityOverride at consume time.
	Security json.RawMessage `json:"security,omitempty"`
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

// ScanFilePayload is consumed by the worker registered for TaskScanFile.
// The worker:
//
//  1. SELECTs scan_jobs by JobID, marks status='running' + attempts++.
//  2. Fetches the blob bytes from object storage by StorageKey.
//  3. Calls Scanner.Scan with the body reader.
//  4. UPDATEs files.scan_status / scan_signature / scan_engine /
//     scanned_at, and on Clean/Skipped flips files.status to 'active'
//     so the gate releases the file for download.
//  5. UPDATEs scan_jobs.status='done' (or 'error') with the verdict
//     payload and finished_at.
//
// Why we duplicate StorageKey + OrgID into the payload (when the worker
// could SELECT them from scan_jobs): keeps the worker's hot path one
// query lighter, and lets us re-issue scans against an arbitrary key
// (e.g. re-scan after engine update) without inserting a new row.
type ScanFilePayload struct {
	JobID      string `json:"jobId"`
	OrgID      string `json:"orgId"`
	FileID     string `json:"fileId"`
	StorageKey string `json:"storageKey"`
}

func NewScanFile(p ScanFilePayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	// 3 retries — clamd restarts and TCP blips are the dominant failure
	// mode and recover within seconds. Genuine engine errors (corrupt
	// archive, unsupported container) do not recover with retries; the
	// scan_jobs.last_error captures the reason and the gate stays
	// fail-closed so a retry-storm doesn't matter for safety.
	return asynq.NewTask(TaskScanFile, b, asynq.MaxRetry(3)), nil
}

// EmbedFilePayload is consumed by the worker registered for
// TaskEmbedFile. Mirrors ScanFilePayload's shape for the same reason —
// duplicating StorageKey + OrgID into the payload keeps the worker's
// hot path one query lighter and lets us re-issue an embedding job
// against an arbitrary file (e.g. after a model upgrade or OCR
// backfill) without coordinating with a side table.
//
// MIME is included so the worker can short-circuit non-textual files
// (mark embed_status='skipped') without fetching the blob first; for
// formats that need OCR or office-conversion the worker delegates to
// the same docconvert pipeline already used for PDF previews.
type EmbedFilePayload struct {
	JobID      string `json:"jobId"`
	OrgID      string `json:"orgId"`
	FileID     string `json:"fileId"`
	StorageKey string `json:"storageKey"`
	MIME       string `json:"mime,omitempty"`
}

func NewEmbedFile(p EmbedFilePayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	// 2 retries — most failures are either Ollama being down (recovers
	// fast) or the file being non-textual (won't recover at all, but
	// the worker marks 'skipped' rather than erroring so retry doesn't
	// matter). Genuine model-side errors are surfaced via embed_error
	// and an operator can re-enqueue manually.
	return asynq.NewTask(TaskEmbedFile, b, asynq.MaxRetry(2)), nil
}

// AutoTagFilePayload mirrors EmbedFilePayload — same shape, same
// rationale (denormalising key + mime saves the worker a round trip).
// Name is the user's uploaded filename; the worker reads it to decide
// whether the auto-rename suggestion should be applied silently
// (generic name) or only stored for the UI to surface (intentional
// name). Without it, every rename would either always-overwrite or
// never-overwrite and we'd lose the "smart enough to know not to
// touch a deliberate filename" property.
type AutoTagFilePayload struct {
	JobID      string `json:"jobId"`
	OrgID      string `json:"orgId"`
	FileID     string `json:"fileId"`
	StorageKey string `json:"storageKey"`
	MIME       string `json:"mime,omitempty"`
	Name       string `json:"name,omitempty"`
}

func NewAutoTagFile(p AutoTagFilePayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	// 2 retries — same reasoning as TaskEmbedFile. Chat completions are
	// the dominant cost so we don't want a model that returned bad JSON
	// to retry forever; the orchestrator marks 'failed' on parse errors
	// instead of bubbling, so retries only fire on transport hiccups.
	return asynq.NewTask(TaskAutoTagFile, b, asynq.MaxRetry(2)), nil
}

func NewWebhookDeliver(p WebhookDeliverPayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	// 5 retries with asynq's default exponential backoff (≈ 1m, 5m, 30m, 2h, 12h).
	return asynq.NewTask(TaskWebhookDeliver, b, asynq.MaxRetry(5)), nil
}
