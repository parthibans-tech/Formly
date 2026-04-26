package files

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/billing"
	"github.com/docforge/api/internal/docconvert"
	"github.com/docforge/api/internal/events"
	"github.com/docforge/api/internal/pdfsec"
	"github.com/docforge/api/internal/queue"
	"github.com/docforge/api/internal/scanner"
	"github.com/docforge/api/internal/sharing"
	"github.com/docforge/api/internal/storage"
	"github.com/docforge/api/internal/uploadpolicy"
	"github.com/docforge/api/internal/vault"
	"github.com/go-chi/chi/v5"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
)

// vaultGateFile resolves the file's folder_id and refuses access when
// that folder (or an ancestor) is locked and the caller's vault is
// closed. Used by Get and Download — list views gate via the `?folder=`
// query parameter directly. Returns true when the request should
// continue; false when a 423/error has already been written to w.
func (h *Handler) vaultGateFile(w http.ResponseWriter, r *http.Request, fileID, userID string) bool {
	var folderID *string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT folder_id::text FROM files WHERE id=$1`, fileID,
	).Scan(&folderID); err != nil {
		// File doesn't exist → let the caller's regular 404 path handle it.
		return true
	}
	if folderID == nil || *folderID == "" {
		return true
	}
	if err := vault.RequireUnlocked(r.Context(), h.DB, userID, *folderID); err != nil {
		if errors.Is(err, vault.ErrLocked) {
			vault.WriteLockedError(w)
			return false
		}
		writeErr(w, 500, "db_error", err.Error())
		return false
	}
	return true
}

// Detector runs after a file upload completes. It may return a template ID if one was created.
type Detector func(ctx context.Context, fileID, orgID, name, mime, storageKey string) (string, error)

type Handler struct {
	DB       *pgxpool.Pool
	Storage  *storage.Client
	Detector Detector
	// Queue enqueues async jobs (today: convert-to-PDF for office docs).
	// Optional — when nil, conversion is skipped silently and the source
	// file is left without a preview rather than blocking the upload.
	Queue *asynq.Client
	// Policy resolves the layered upload-security configuration (product
	// defaults → per-org overrides). Required for CreateUploadURL and
	// Complete. main.go wires this in after construction.
	Policy *uploadpolicy.Service
	// AIEmbedEnabled toggles enqueueing TaskEmbedFile from Complete. Set
	// at boot from `ai.Client.Enabled() && Capabilities().Embed` so the
	// HTTP layer doesn't depend on the ai package directly. When false,
	// uploads complete without indexing — exactly the off-by-default
	// behaviour we want for AI features.
	AIEmbedEnabled bool
	// AIAutoTagEnabled toggles enqueueing TaskAutoTagFile from Complete.
	// Boot-set from `ai.Client.Enabled() && Capabilities().Chat` (auto-
	// tag uses chat, not embed, so chat-only providers like Anthropic
	// still get this feature even when Smart Search is dark).
	AIAutoTagEnabled bool
}

func New(db *pgxpool.Pool, s *storage.Client) *Handler {
	return &Handler{DB: db, Storage: s}
}

type fileDTO struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Mime       string    `json:"mime"`
	Size       int64     `json:"size"`
	Status     string    `json:"status"`
	TemplateID *string   `json:"templateId,omitempty"`
	FolderID   *string   `json:"folderId,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	// Starred is per-user: whether the *current caller* has starred
	// this file. Computed via a LEFT JOIN against starred_files so
	// the whole list returns in a single round trip.
	Starred bool `json:"starred"`
	// Office-doc preview pipeline. Populated for sources that go
	// through soffice convert-to-pdf. NULL/empty for files that need
	// no conversion (PDF, image) or where conversion hasn't run yet.
	PreviewPdfID    *string `json:"previewPdfId,omitempty"`
	ConvertStatus   *string `json:"convertStatus,omitempty"`
	ConvertWarning  *string `json:"convertWarning,omitempty"`
	// AI auto-tag pipeline (migration 046). Tags is always present
	// (defaulted to []); the rest are pointers because most rows have
	// NULL for them — either AI was off at upload, or the worker
	// hasn't finished, or the model couldn't make a useful suggestion.
	Tags                 []string `json:"tags"`
	AutoTagStatus        *string  `json:"autoTagStatus,omitempty"`
	AutoRenameSuggestion *string  `json:"autoRenameSuggestion,omitempty"`
	OriginalName         *string  `json:"originalName,omitempty"`
}

type uploadURLReq struct {
	Name string `json:"name"`
	Mime string `json:"mime"`
	// Declared content length. Required when the upload-policy enforces a
	// max size — the server validates this against the resolved policy
	// before issuing the presign and bakes the same ceiling into the
	// presigned POST policy so MinIO refuses oversize uploads at the
	// edge. Pass 0 (or omit) for clients that legitimately don't know
	// the size up front; the Complete handler still re-checks.
	Size int64 `json:"size,omitempty"`
	// Optional destination folder (empty / omitted = root). Passing this
	// up-front lets the collision check run against the correct scope —
	// previously the client uploaded to root and then PATCHed folder_id,
	// which meant "same-name" detection had no folder context.
	FolderID string `json:"folderId,omitempty"`
	// Collision strategy. Empty = "don't know, please tell me if something
	// collides" (returns 409). "replace" = overwrite the existing file,
	// preserving its ID / shares / folder membership. "keep" = auto-rename
	// the new file with " (2)", " (3)" etc. so both files coexist.
	Conflict string `json:"conflict,omitempty"`
}

type uploadURLResp struct {
	FileID string `json:"fileId"`
	// UploadURL is the legacy presigned-PUT URL. Kept for backward compat
	// with clients that haven't migrated to the POST flow yet, but new
	// code should use Upload below — the POST policy carries the storage-
	// layer content-length-range enforcement.
	UploadURL string `json:"uploadUrl,omitempty"`
	// Upload is the presigned POST descriptor (URL + form fields). This
	// is the canonical upload path: the bucket policy hard-caps the
	// content length, locks the object key, and pins the content type
	// so a malicious client can't stream gigabytes or overwrite a
	// neighbour's key.
	Upload *storage.PostUpload `json:"upload,omitempty"`
	// MaxBytes echoes the resolved policy ceiling so the web client can
	// reject the file in the picker before even POSTing back to us.
	MaxBytes int64  `json:"maxBytes,omitempty"`
	Key      string `json:"key"`
	// True when the server auto-renamed the file (conflict=keep path).
	// The client reads this so it can show the actual saved name in the
	// success toast instead of the one the user dropped in.
	ResolvedName string `json:"resolvedName,omitempty"`
	// True when the server is returning an existing file ID for overwrite
	// (conflict=replace path). Useful for the client to skip the post-
	// complete folder-move PATCH — the existing file already has its
	// folder set.
	Replaced bool `json:"replaced,omitempty"`
}

// Shape returned on 409 so the client can show a meaningful prompt.
// Nested under `error` to match the rest of the API's error convention
// (see writeErr). The extra fields (existingFileId, existingName,
// isTemplate) live alongside code + message so clients can extract them
// via ApiError.raw.error.
type conflictErr struct {
	Code           string `json:"code"`
	Message        string `json:"message"`
	ExistingFileID string `json:"existingFileId"`
	ExistingName   string `json:"existingName"`
	IsTemplate     bool   `json:"isTemplate"`
}

func writeConflict(w http.ResponseWriter, c conflictErr) {
	writeJSON(w, 409, map[string]any{"error": c})
}

func (h *Handler) CreateUploadURL(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req uploadURLReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Name == "" {
		writeErr(w, 400, "missing_name", "name required")
		return
	}
	// Browsers populate File.type from the OS MIME registry, which on
	// Windows + some Linux desktops is incomplete for raster images
	// (HEIC, WebP, sometimes even PNG come up empty). When the client
	// gives us nothing — or the catch-all octet-stream — fall back to
	// guessing from the filename extension so downstream features that
	// branch on mime ("image/*" → preview & OCR, "application/pdf" →
	// docchat) light up immediately on first upload instead of waiting
	// for the image-editor save path to rewrite the column.
	if req.Mime == "" || strings.EqualFold(req.Mime, "application/octet-stream") {
		if guess := guessMimeFromName(req.Name); guess != "" {
			req.Mime = guess
		} else if req.Mime == "" {
			req.Mime = "application/octet-stream"
		}
	}

	// Sanitise the display name UNCONDITIONALLY — the storage-key
	// construction below depends on a clean name even when no per-org
	// policy is wired. SanitizeFilename strips path separators, control
	// chars, and caps at AbsMaxFilenameLen (255 bytes) so we never let
	// a 4 KB filename through the door regardless of policy state.
	req.Name = uploadpolicy.SanitizeFilename(req.Name)

	// Resolve the layered upload policy (product → org overrides), then
	// run every pre-presign check: extension blocklist, MIME allowlist,
	// size cap, policy-specific filename length. Doing this before we
	// touch the DB keeps obviously-bad uploads from creating a ghost
	// row.
	var policy uploadpolicy.Policy
	if h.Policy != nil {
		p, err := h.Policy.Effective(r.Context(), c.OrgID)
		if err != nil {
			writeErr(w, 500, "policy_error", err.Error())
			return
		}
		policy = p
		if err := uploadpolicy.CheckPresign(policy, req.Name, req.Mime, req.Size); err != nil {
			if pe, ok := uploadpolicy.IsError(err); ok {
				audit.LogHTTP(r, h.DB, "file.upload.rejected", "file", "", map[string]any{
					"reason":      "policy_block",
					"policyCode":  pe.Code,
					"name":        req.Name,
					"claimedMime": req.Mime,
					"claimedSize": req.Size,
					"folderId":    req.FolderID,
				})
				writeErr(w, pe.Status, pe.Code, pe.Message)
				return
			}
			audit.LogHTTP(r, h.DB, "file.upload.rejected", "file", "", map[string]any{
				"reason":      "policy_error",
				"name":        req.Name,
				"claimedMime": req.Mime,
				"claimedSize": req.Size,
				"folderId":    req.FolderID,
				"detail":      err.Error(),
			})
			writeErr(w, 400, "policy_error", err.Error())
			return
		}
	}
	// Normalise empty folderId to a typed nil so the SQL below can use a
	// single "folder_id IS NOT DISTINCT FROM $N" predicate without
	// branching for NULL vs text casts.
	var folderArg any
	if req.FolderID != "" {
		folderArg = req.FolderID
	} else {
		folderArg = nil
	}

	// --- collision detection -----------------------------------------------
	// Scope: same org + same folder (NULL = root) + same name + same MIME
	// + not trashed. Trashed files don't block uploads because the user
	// already threw the old one away; making them resolve a "conflict"
	// with something sitting in the bin would be annoying.
	var (
		existingID         string
		existingName       string
		existingOwner      string
		existingTemplateID *string
		existingStorageKey string
	)
	err := h.DB.QueryRow(r.Context(),
		`SELECT id, name, owner_id, template_id, storage_key
		 FROM files
		 WHERE org_id=$1
		   AND name=$2
		   AND mime=$3
		   AND folder_id IS NOT DISTINCT FROM $4
		   AND trashed_at IS NULL
		 LIMIT 1`,
		c.OrgID, req.Name, req.Mime, folderArg,
	).Scan(&existingID, &existingName, &existingOwner, &existingTemplateID, &existingStorageKey)
	hasCollision := err == nil

	switch {
	case hasCollision && req.Conflict == "":
		// No strategy chosen — hand the client the data it needs to ask
		// the user. 409 is the canonical "you asked me to create
		// something but state already exists" code.
		writeConflict(w, conflictErr{
			Code:           "name_conflict",
			Message:        "a file with this name already exists in this folder",
			ExistingFileID: existingID,
			ExistingName:   existingName,
			IsTemplate:     existingTemplateID != nil && *existingTemplateID != "",
		})
		return

	case hasCollision && req.Conflict == "replace":
		// Overwrite flow: reuse the existing file row. This preserves the
		// file ID, so shares, comments, template mappings, folder
		// membership, and links in external systems all keep working.
		// Only the blob changes.
		//
		// Safety rails:
		//   1. Only the owner (or an admin) may replace — otherwise any
		//      teammate with viewer access could swap out the content
		//      under the owner's feet.
		//   2. Refuse to replace a template. The template's field
		//      geometry (Rect coords, widget names) is tightly coupled
		//      to the PDF bytes; a new PDF would silently break every
		//      saved mapping. User must delete + re-create the template
		//      on purpose.
		if existingTemplateID != nil && *existingTemplateID != "" {
			audit.LogHTTP(r, h.DB, "file.upload.rejected", "file", existingID, map[string]any{
				"reason":      "replace_template",
				"name":        req.Name,
				"claimedMime": req.Mime,
				"claimedSize": req.Size,
				"folderId":    req.FolderID,
			})
			writeConflict(w, conflictErr{
				Code:           "template_replace_not_supported",
				Message:        "can't replace a template's source file — delete the template first, or upload with a different name",
				ExistingFileID: existingID,
				ExistingName:   existingName,
				IsTemplate:     true,
			})
			return
		}
		if existingOwner != c.UserID && !c.IsAdmin() {
			audit.LogHTTP(r, h.DB, "file.upload.rejected", "file", existingID, map[string]any{
				"reason":      "replace_forbidden",
				"name":        req.Name,
				"claimedMime": req.Mime,
				"claimedSize": req.Size,
				"folderId":    req.FolderID,
				"existingOwnerId": existingOwner,
			})
			writeErr(w, 403, "forbidden", "only the file's owner or an admin can replace it")
			return
		}
		// Reset status back to "pending" until Complete re-runs. If the
		// existing storage_key is empty (edge case: original upload
		// never finished) we regenerate it; otherwise we overwrite in
		// place at the same key.
		key := existingStorageKey
		if key == "" {
			// Storage key takes a slugified form of the name — the
			// human-readable `req.Name` only lives in files.name.
			// Keeps S3 paths ASCII-only and bounded so presigned URLs
			// stay well-behaved through CDNs and replay attempts.
			key = fmt.Sprintf("orgs/%s/files/%s/%s",
				c.OrgID, existingID, uploadpolicy.SafeStorageSlug(req.Name))
			if _, err := h.DB.Exec(r.Context(),
				`UPDATE files SET storage_key=$1, status='pending', updated_at=now() WHERE id=$2`,
				key, existingID,
			); err != nil {
				writeErr(w, 500, "db_error", err.Error())
				return
			}
		} else {
			if _, err := h.DB.Exec(r.Context(),
				`UPDATE files SET status='pending', updated_at=now() WHERE id=$1`,
				existingID,
			); err != nil {
				writeErr(w, 500, "db_error", err.Error())
				return
			}
		}
		resp, err := h.buildUploadResponse(r.Context(), key, req.Mime, policy)
		if err != nil {
			writeErr(w, 500, "presign", err.Error())
			return
		}
		resp.FileID = existingID
		resp.Replaced = true
		audit.LogHTTP(r, h.DB, "file.upload.intent", "file", existingID, map[string]any{
			"name":        req.Name,
			"claimedMime": req.Mime,
			"claimedSize": req.Size,
			"folderId":    req.FolderID,
			"conflict":    "replace",
			"replaced":    true,
		})
		writeJSON(w, 200, resp)
		return

	case hasCollision && req.Conflict == "keep":
		// "Keep both" — pick the next " (N)" suffix that isn't taken in
		// this folder and fall through to the normal insert path below.
		req.Name = nextAvailableName(r.Context(), h.DB, c.OrgID, folderArg, req.Name)
		// fallthrough intentional — we want the default insert branch
	}

	// --- default path: create a fresh row ----------------------------------
	resolvedName := ""
	if hasCollision && req.Conflict == "keep" {
		// Only set on the resolved-name response path so the client
		// doesn't think a rename happened when none did.
		resolvedName = req.Name
	}

	var id string
	if err := h.DB.QueryRow(r.Context(),
		`INSERT INTO files (org_id, owner_id, name, mime, storage_key, folder_id)
		 VALUES ($1,$2,$3,$4,'',$5) RETURNING id`,
		c.OrgID, c.UserID, req.Name, req.Mime, folderArg,
	).Scan(&id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	// Slugified key path — see the replace branch above for rationale.
	key := fmt.Sprintf("orgs/%s/files/%s/%s",
		c.OrgID, id, uploadpolicy.SafeStorageSlug(req.Name))
	if _, err := h.DB.Exec(r.Context(), `UPDATE files SET storage_key=$1 WHERE id=$2`, key, id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	resp, err := h.buildUploadResponse(r.Context(), key, req.Mime, policy)
	if err != nil {
		writeErr(w, 500, "presign", err.Error())
		return
	}
	resp.FileID = id
	resp.ResolvedName = resolvedName
	intentMeta := map[string]any{
		"name":        req.Name,
		"claimedMime": req.Mime,
		"claimedSize": req.Size,
		"folderId":    req.FolderID,
	}
	if req.Conflict != "" {
		intentMeta["conflict"] = req.Conflict
	}
	if resolvedName != "" {
		intentMeta["resolvedName"] = resolvedName
	}
	audit.LogHTTP(r, h.DB, "file.upload.intent", "file", id, intentMeta)
	writeJSON(w, 200, resp)
}

// buildUploadResponse generates BOTH the new presigned-POST descriptor and
// the legacy presigned-PUT URL for the same object key. The web client
// prefers the POST shape (storage-layer content-length-range enforcement);
// older API integrators that already wired PUT keep working until they
// migrate. The size cap is enforced server-side at Complete time
// regardless, so the legacy path stays safe.
func (h *Handler) buildUploadResponse(
	ctx context.Context, key, mime string, policy uploadpolicy.Policy,
) (uploadURLResp, error) {
	maxBytes := policy.MaxUploadBytes
	if maxBytes <= 0 {
		maxBytes = 100 * 1024 * 1024 // safe default if policy not wired
	}
	post, err := h.Storage.PresignPost(ctx, key, mime, maxBytes, 15*time.Minute)
	if err != nil {
		return uploadURLResp{}, err
	}
	putURL, err := h.Storage.PresignPut(ctx, key, 15*time.Minute)
	if err != nil {
		return uploadURLResp{}, err
	}
	return uploadURLResp{
		Key:       key,
		Upload:    post,
		UploadURL: putURL,
		MaxBytes:  maxBytes,
	}, nil
}

// nextAvailableName finds the first " (N)" suffix (starting at 2) that
// isn't already taken by a non-trashed file in the same folder. Mirrors
// the Google Drive / Finder convention so users aren't surprised.
//
// We probe up to 100 candidates; beyond that (realistically never hit) we
// fall back to a timestamp suffix so the insert still goes through.
func nextAvailableName(ctx context.Context, db *pgxpool.Pool, orgID string, folderArg any, name string) string {
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	// If the name already ends with "(N)" from a previous rename, we
	// still start fresh from (2) rather than trying to parse + increment
	// — simpler and the result is indistinguishable to users.
	for i := 2; i < 100; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", base, i, ext)
		var exists bool
		if err := db.QueryRow(ctx,
			`SELECT EXISTS(
			   SELECT 1 FROM files
			   WHERE org_id=$1
			     AND name=$2
			     AND folder_id IS NOT DISTINCT FROM $3
			     AND trashed_at IS NULL
			 )`,
			orgID, candidate, folderArg,
		).Scan(&exists); err != nil {
			// On DB error, fall through to timestamp path below — better
			// to save the file with a weird-but-unique name than fail
			// the whole upload.
			break
		}
		if !exists {
			return candidate
		}
	}
	return fmt.Sprintf("%s-%d%s", base, time.Now().Unix(), ext)
}

// EnsureTemplate is a backfill endpoint: if `files.template_id` is NULL
// for the given file, run the detector and return the (possibly newly
// created) template ID. Existing templateId wins — we never stomp a
// real template. Used by the Drive click handler so images / HTML /
// markdown that were uploaded before their detector shipped can still
// open in the designer without the user having to re-upload.
func (h *Handler) EnsureTemplate(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	var existing *string
	var name, mime, key string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT template_id, name, mime, storage_key FROM files WHERE id=$1 AND org_id=$2`,
		id, c.OrgID,
	).Scan(&existing, &name, &mime, &key); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	if existing != nil && *existing != "" {
		writeJSON(w, 200, map[string]any{"templateId": *existing, "created": false})
		return
	}
	if h.Detector == nil {
		writeErr(w, 500, "no_detector", "detector not configured")
		return
	}
	tplID, err := h.Detector(r.Context(), id, c.OrgID, name, mime, key)
	if err != nil {
		writeErr(w, 500, "detect_failed", err.Error())
		return
	}
	if tplID == "" {
		// Not a file type the detector handles (e.g. plain binary / zip).
		// Return 200 with empty templateId so the client can fall back to
		// its existing "download" branch without treating it as an error.
		writeJSON(w, 200, map[string]any{"templateId": "", "created": false})
		return
	}
	writeJSON(w, 200, map[string]any{"templateId": tplID, "created": true})
}

// ExportPDF enqueues a worker-side LibreOffice conversion of a DOCX/RTF/ODT
// /etc. source file to PDF. The PDF lands as a sibling files row linked
// via files.preview_pdf_id; the source row's convert_status flips
// pending → ready. Idempotent: re-running on a file with an existing
// ready preview just re-runs the conversion (asynq handler overwrites
// the link). This is the *user-triggered* counterpart to what used to
// happen automatically on upload — drive semantics demand the source
// stays in its original format unless the user opts in.
func (h *Handler) ExportPDF(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	var name, mime string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT name, mime FROM files WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`,
		id, c.OrgID,
	).Scan(&name, &mime); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	if docconvert.IsExplicitlyUnsupported(mime, name) {
		writeErr(w, 400, "unsupported_format", "PDF export not supported for this file type")
		return
	}
	if !docconvert.IsConvertible(mime, name) {
		writeErr(w, 400, "not_convertible", "PDF export only available for office documents")
		return
	}
	if h.Queue == nil {
		writeErr(w, 503, "queue_unavailable", "conversion worker not configured")
		return
	}
	if _, err := h.DB.Exec(r.Context(),
		`UPDATE files SET convert_status='pending', convert_warning=NULL, updated_at=now() WHERE id=$1`, id,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	task, err := queue.NewConvertToPDF(queue.ConvertToPDFPayload{
		OrgID: c.OrgID, UserID: c.UserID, FileID: id,
	})
	if err != nil {
		writeErr(w, 500, "queue_error", err.Error())
		return
	}
	if _, err := h.Queue.EnqueueContext(r.Context(), task); err != nil {
		writeErr(w, 500, "queue_error", err.Error())
		return
	}
	writeJSON(w, 202, map[string]any{"ok": true, "convertStatus": "pending"})
}

func (h *Handler) Complete(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	var key, name, mime string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT storage_key, name, mime FROM files WHERE id=$1 AND org_id=$2`, id, c.OrgID,
	).Scan(&key, &name, &mime); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}

	info, err := h.Storage.StatObject(r.Context(), key)
	if err != nil {
		writeErr(w, 400, "not_uploaded", "object missing from storage")
		return
	}

	// Layered upload-policy enforcement, post-upload edition. The
	// presigned-POST policy already capped size at the storage edge,
	// but legacy PUT presigns and direct API integrators don't get that
	// guarantee — re-check here and delete the offending blob so we
	// don't pay for it.
	//
	// We ALSO always read the first 512 bytes and run
	// http.DetectContentType, even when the org admin has the strict
	// mismatch-rejects toggle off: the detected MIME replaces the
	// client-declared one in files.mime when they disagree, so
	// downstream consumers (Detector, download disposition,
	// IsRiskyMime) operate on bytes-truth instead of a client claim.
	// See uploadpolicy.CanonicalMime for the merge logic.
	var effPolicy uploadpolicy.Policy
	var havePolicy bool
	if h.Policy != nil {
		policy, perr := h.Policy.Effective(r.Context(), c.OrgID)
		if perr == nil {
			effPolicy, havePolicy = policy, true
			if err := uploadpolicy.CheckCompletedSize(policy, info.Size); err != nil {
				if pe, ok := uploadpolicy.IsError(err); ok {
					_ = h.Storage.Remove(r.Context(), key)
					_, _ = h.DB.Exec(r.Context(),
						`UPDATE files SET status='rejected', updated_at=now() WHERE id=$1`, id)
					audit.LogHTTP(r, h.DB, "file.upload.rejected", "file", id, map[string]any{
						"reason":      "size_cap",
						"policyCode":  pe.Code,
						"name":        name,
						"claimedMime": mime,
						"actualSize":  info.Size,
					})
					writeErr(w, pe.Status, pe.Code, pe.Message)
					return
				}
			}
			// Single Range read covers both the strict mismatch check
			// AND the canonical-mime computation. Range failures aren't
			// fatal — some pathological backends 416 on tiny ranges; we
			// just skip sniffing in that case (matches the prior
			// "best-effort" behavior).
			if head, herr := h.Storage.HeadBytes(r.Context(), key, 512); herr == nil && len(head) > 0 {
				detected, mismatch := uploadpolicy.SniffMime(head, mime)
				if mismatch && policy.MimeSniffEnabled {
					_ = h.Storage.Remove(r.Context(), key)
					_, _ = h.DB.Exec(r.Context(),
						`UPDATE files SET status='rejected', updated_at=now() WHERE id=$1`, id)
					audit.LogHTTP(r, h.DB, "file.upload.rejected", "file", id, map[string]any{
						"reason":      "mime_mismatch",
						"name":        name,
						"claimedMime": mime,
						"actualMime":  detected,
						"actualSize":  info.Size,
					})
					writeErr(w, 415, "mime_mismatch",
						"the file's actual content does not match its declared type")
					return
				}
				// Replace `mime` with the canonical value. When sniff is
				// strict this either keeps `mime` (matched) or we've
				// already returned (rejected) above. When sniff is
				// permissive, this is what closes the trust gap: the
				// detected bytes win over the client's claim.
				mime = uploadpolicy.CanonicalMime(mime, detected)
			}
		}
	}

	// PDF structural hardening. When the org's policy enables
	// PdfHardenEnabled and the canonical MIME (post-sniff) is
	// application/pdf, we run internal/pdfsec.Inspect over the bytes
	// before letting the upload settle. Catches the structural threats
	// the AV engine doesn't reason about: /JavaScript actions, /Launch
	// targets, /EmbeddedFile attachments, external /Filespec refs.
	//
	// Runs synchronously (independent of ScanEnabled) so:
	//   - deployments without ClamAV still get the protection,
	//   - the user gets immediate feedback when their PDF is refused,
	//   - quarantined bytes are deleted before any download path can
	//     leak them (the AV worker's async path leaves the bytes in
	//     storage with status='scanning' until the scan completes;
	//     for structural threats we'd rather refuse on the spot).
	if havePolicy && effPolicy.PdfHardenEnabled && isPDFMime(mime) {
		blocked, sig, perr := h.runPDFInspection(r.Context(), key, effPolicy)
		if perr != nil {
			// Inspector itself failed — fail closed: refuse the upload
			// and clean up the blob. A read failure here means we
			// couldn't prove the PDF is safe; releasing it would defeat
			// the purpose of having the gate.
			_ = h.Storage.Remove(r.Context(), key)
			_, _ = h.DB.Exec(r.Context(),
				`UPDATE files SET status='rejected', updated_at=now() WHERE id=$1`, id)
			audit.LogHTTP(r, h.DB, "file.upload.rejected", "file", id, map[string]any{
				"reason":      "pdf_inspect_error",
				"name":        name,
				"claimedMime": mime,
				"actualSize":  info.Size,
				"detail":      perr.Error(),
			})
			writeErr(w, 500, "pdf_inspect_error", perr.Error())
			return
		}
		if blocked {
			_ = h.Storage.Remove(r.Context(), key)
			_, _ = h.DB.Exec(r.Context(),
				`UPDATE files
				    SET status='rejected',
				        scan_status='infected',
				        scan_signature=$1,
				        scan_engine='pdfsec',
				        scanned_at=now(),
				        updated_at=now()
				  WHERE id=$2`,
				"pdf:"+sig, id)
			audit.LogHTTP(r, h.DB, "file.upload.rejected", "file", id, map[string]any{
				"reason":      "pdf_blocked",
				"signature":   "pdf:" + sig,
				"name":        name,
				"claimedMime": mime,
				"actualSize":  info.Size,
			})
			writeErr(w, 415, "pdf_blocked",
				"this PDF contains active content that is not permitted: "+sig)
			return
		}
	}

	// Storage quota enforcement. The blob is already uploaded, but we
	// refuse to mark it active when accepting it would push the org
	// over its plan ceiling. The dangling object is cleaned up by the
	// orphan-blob janitor; the user gets a clear 402 with an upgrade
	// hint instead of a silent fail.
	if err := billing.EnsureStorageAvailable(r.Context(), h.DB, c.OrgID, info.Size); err != nil {
		if le, ok := billing.IsLimitError(err); ok {
			_, _ = h.DB.Exec(r.Context(),
				`UPDATE files SET status='quota_blocked', size=$1, updated_at=now()
				   WHERE id=$2`, info.Size, id)
			audit.LogHTTP(r, h.DB, "file.upload.rejected", "file", id, map[string]any{
				"reason":      "quota",
				"policyCode":  le.Code,
				"name":        name,
				"claimedMime": mime,
				"actualSize":  info.Size,
			})
			writeErr(w, le.Status, le.Code, le.Message)
			return
		}
	}

	// AV-scan gate. When the org policy enables scanning, the file is
	// NOT immediately released — we mark it status='scanning' (the
	// download gate already refuses any non-active status) and
	// scan_status='pending', then enqueue a TaskScanFile asynq job.
	// The worker stamps the verdict back and flips status='active'
	// only on a clean/skipped outcome. See internal/scanner +
	// internal/worker.scanFile.
	//
	// When scanning is disabled (default in CI / dev), the file goes
	// straight to active with scan_status='skipped' so the audit trail
	// records "engine declined to run", not "engine ran and was happy."
	scanEnabled := havePolicy && effPolicy.ScanEnabled
	// Without a queue client, even a scan-enabled org can't get
	// asynchronous scanning. Fall back to skipped + active so the
	// upload doesn't get stuck in 'scanning' forever — the audit
	// log + scan_engine='unconfigured' tells operators the gap.
	if scanEnabled && h.Queue == nil {
		scanEnabled = false
	}

	// `mime` here is the canonical post-sniff value (see the policy
	// block above) — persist it so every later read uses bytes-truth
	// instead of whatever the client originally claimed at presign time.
	if scanEnabled {
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files
			    SET status='scanning',
			        scan_status='pending',
			        size=$1, mime=$2, updated_at=now()
			  WHERE id=$3`,
			info.Size, mime, id,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		// Insert the audit row first so the worker has a stable JobID
		// to mutate. RETURNING id keeps this single-roundtrip. If the
		// enqueue below fails we leave the row in 'queued' — a
		// reconciler can re-enqueue without producing a duplicate row.
		var scanJobID string
		if err := h.DB.QueryRow(r.Context(), `
			INSERT INTO scan_jobs (file_id, org_id, storage_key, status)
			VALUES ($1, $2, $3, 'queued')
			RETURNING id`,
			id, c.OrgID, key,
		).Scan(&scanJobID); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		task, terr := queue.NewScanFile(queue.ScanFilePayload{
			JobID:      scanJobID,
			OrgID:      c.OrgID,
			FileID:     id,
			StorageKey: key,
		})
		if terr == nil {
			_, _ = h.Queue.Enqueue(task)
		}
	} else {
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files
			    SET status='active',
			        scan_status='skipped',
			        scan_engine=COALESCE(scan_engine, 'unconfigured'),
			        size=$1, mime=$2, updated_at=now()
			  WHERE id=$3`,
			info.Size, mime, id,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}

	// AI smart-search index build. Only runs when:
	//   - the operator turned AI on at boot (AI_ENABLED + Embed-capable
	//     provider; main.go sets h.AIEmbedEnabled accordingly), AND
	//   - we have a queue client to enqueue against.
	// We mark embed_status='pending' first so the operator query
	// "which files are still waiting?" works the moment the row exists.
	// A NULL value (the migration default) means "AI was off when this
	// file was uploaded"; pending means "AI is on, worker hasn't
	// finished yet". The distinction matters for backfills.
	if h.AIEmbedEnabled && h.Queue != nil {
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files SET embed_status='pending', embed_error=NULL, updated_at=now() WHERE id=$1`,
			id,
		); err == nil {
			task, terr := queue.NewEmbedFile(queue.EmbedFilePayload{
				JobID:      id, // reuse file id as the job key — embedding is idempotent
				OrgID:      c.OrgID,
				FileID:     id,
				StorageKey: key,
				MIME:       mime,
			})
			if terr == nil {
				_, _ = h.Queue.Enqueue(task)
			}
		}
	}

	// AI auto-tag + auto-rename. Independent of the embed pipeline:
	// chat-only providers light up auto-tag without smart search, and
	// vice-versa for embed-only providers. We mark auto_tag_status
	// 'pending' first so the UI can render a "tagging…" pill the moment
	// the file appears in the listing.
	if h.AIAutoTagEnabled && h.Queue != nil {
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files SET auto_tag_status='pending', auto_tag_error=NULL, updated_at=now() WHERE id=$1`,
			id,
		); err == nil {
			task, terr := queue.NewAutoTagFile(queue.AutoTagFilePayload{
				JobID:      id, // reuse file id; tagging is idempotent
				OrgID:      c.OrgID,
				FileID:     id,
				StorageKey: key,
				MIME:       mime,
				Name:       name,
			})
			if terr == nil {
				_, _ = h.Queue.Enqueue(task)
			}
		}
	}

	resp := map[string]any{"ok": true, "size": info.Size}
	if h.Detector != nil {
		tplID, err := h.Detector(r.Context(), id, c.OrgID, name, mime, key)
		if err == nil && tplID != "" {
			resp["templateId"] = tplID
		}
	}

	// PDF conversion is opt-in (POST /v1/files/{id}/export-pdf), not a
	// silent on-ingest pipeline. A drive's job is to preserve the source
	// bytes — DOCX should round-trip as DOCX, not be flattened to PDF
	// behind the user's back. The conversion machinery is still here
	// for the explicit Export action; we just don't trigger it here.
	events.Publish(r.Context(), events.FileUploaded, c.OrgID, map[string]interface{}{
		"fileId":     id,
		"name":       name,
		"mime":       mime,
		"size":       info.Size,
		"templateId": resp["templateId"],
	})

	// Forensic-grade upload audit row. The events.Publish above is for
	// downstream subsystems (websocket fan-out, search indexer, etc.); it
	// doesn't ship to the audit_log table and isn't filterable by the
	// admin UI. This row is the canonical "user X uploaded file Y from IP
	// Z at time T" record — it carries the actor's IP + UA via
	// audit.LogHTTP so a forensic reviewer can reconstruct the event
	// without joining against session tables. `actualSize` and
	// `actualMime` are post-canonicalisation truth (the value we stored),
	// not the client's original claim — the claim is what
	// `file.upload.intent` already captured at presign time.
	tpl, _ := resp["templateId"].(string)
	audit.LogHTTP(r, h.DB, "file.upload.completed", "file", id,
		buildUploadCompletedMeta(id, name, mime, info.Size, scanEnabled, tpl))

	writeJSON(w, 200, resp)
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	q := r.URL.Query()
	view := q.Get("view")

	// Admins can opt into the old org-wide view with `?scope=org`;
	// otherwise every list is filtered to files the caller owns or
	// has been shared on (directly or via a folder share).
	orgWide := c.IsAdmin() && q.Get("scope") == "org"

	// Build the visibility AND-clause once. Non-admins always get it;
	// admins get it unless they passed `?scope=org`. Placeholder
	// numbering starts after the query's static args so each branch
	// can compute its own base offset.
	visClause := func(startIdx int) (string, []any) {
		if orgWide {
			return "", nil
		}
		clause, vargs := sharing.FileVisibilityClause("files", c.UserID, startIdx)
		return " AND " + clause, vargs
	}

	// Every branch needs to know whether the current user has starred
	// each file so the UI can render the filled vs outlined star in one
	// paint. A LEFT JOIN on starred_files (keyed on user_id + file_id)
	// returns NULL for unstarred rows; we coerce that to a boolean via
	// `sf.user_id IS NOT NULL AS starred`. The user_id comes in as $1
	// so every branch can reuse that placeholder.
	//
	// `?view=starred` is served by the same List handler — easier than a
	// separate endpoint and keeps the visibility/scope logic in one place.
	baseSelect := `SELECT files.id, files.name, files.mime, files.size, files.status,
	                       files.template_id, files.folder_id, files.created_at,
	                       (sf.user_id IS NOT NULL) AS starred,
	                       files.preview_pdf_id::text, files.convert_status, files.convert_warning,
	                       COALESCE(files.tags, '{}'::text[]),
	                       files.auto_tag_status, files.auto_rename_suggestion, files.original_name
	               FROM files
	               LEFT JOIN starred_files sf
	                 ON sf.file_id = files.id AND sf.user_id = $1::uuid`

	// Hide preview-PDF children produced by the office-doc convert
	// pipeline. Those rows exist so we can store and serve a sibling
	// PDF, but they should never appear in listings — the user already
	// sees the source DOC/RTF/etc. and would otherwise see two rows
	// for the same logical document.
	hidePreviews := ` AND NOT EXISTS (SELECT 1 FROM files src WHERE src.preview_pdf_id = files.id)`

	var sql string
	var args []any
	switch view {
	case "trashed":
		vis, vargs := visClause(3)
		sql = baseSelect + `
		       WHERE files.org_id=$2 AND files.trashed_at IS NOT NULL` + vis + hidePreviews + `
		       ORDER BY files.created_at DESC
		       LIMIT 200`
		args = append([]any{c.UserID, c.OrgID}, vargs...)
	case "templates":
		vis, vargs := visClause(3)
		sql = baseSelect + `
		       WHERE files.org_id=$2 AND files.trashed_at IS NULL AND files.template_id IS NOT NULL` + vis + hidePreviews + `
		       ORDER BY files.created_at DESC
		       LIMIT 200`
		args = append([]any{c.UserID, c.OrgID}, vargs...)
	case "recent":
		vis, vargs := visClause(3)
		sql = baseSelect + `
		       WHERE files.org_id=$2 AND files.trashed_at IS NULL` + vis + hidePreviews + `
		       ORDER BY files.created_at DESC
		       LIMIT 50`
		args = append([]any{c.UserID, c.OrgID}, vargs...)
	case "starred":
		// Starred view: INNER-join semantics (only rows the user starred).
		// We use the LEFT JOIN from baseSelect + `sf.user_id IS NOT NULL`
		// filter rather than switching to an INNER join so the SELECT list
		// stays identical and every row returns starred=true. Order by
		// when it was starred, not when the file was created — the user's
		// mental model is "newest stars on top".
		vis, vargs := visClause(3)
		sql = baseSelect + `
		       WHERE files.org_id=$2 AND files.trashed_at IS NULL
		         AND sf.user_id IS NOT NULL` + vis + hidePreviews + `
		       ORDER BY sf.created_at DESC
		       LIMIT 200`
		args = append([]any{c.UserID, c.OrgID}, vargs...)
	default:
		folder := q.Get("folder") // "" = root
		// Listing a locked folder requires an unlocked vault. We only
		// gate the named-folder path; root and view-based listings
		// (recent/starred/templates) span every folder and would be
		// unusable if any one locked folder turned them off.
		if folder != "" {
			if err := vault.RequireUnlocked(r.Context(), h.DB, c.UserID, folder); err != nil {
				if errors.Is(err, vault.ErrLocked) {
					vault.WriteLockedError(w)
					return
				}
				writeErr(w, 500, "db_error", err.Error())
				return
			}
		}
		vis, vargs := visClause(4)
		sql = baseSelect + `
		       WHERE files.org_id=$2 AND files.trashed_at IS NULL
		         AND (($3='' AND files.folder_id IS NULL) OR files.folder_id::text=$3)` + vis + hidePreviews + `
		       ORDER BY files.created_at DESC`
		args = append([]any{c.UserID, c.OrgID, folder}, vargs...)
	}

	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []fileDTO{}
	for rows.Next() {
		var f fileDTO
		if err := rows.Scan(
			&f.ID, &f.Name, &f.Mime, &f.Size, &f.Status,
			&f.TemplateID, &f.FolderID, &f.CreatedAt, &f.Starred,
			&f.PreviewPdfID, &f.ConvertStatus, &f.ConvertWarning,
			&f.Tags, &f.AutoTagStatus, &f.AutoRenameSuggestion, &f.OriginalName,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if f.Tags == nil {
			f.Tags = []string{}
		}
		out = append(out, f)
	}
	writeJSON(w, 200, map[string]any{"files": out})
}

// Restore un-trashes a file that was soft-deleted via the Delete endpoint.
func (h *Handler) Restore(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(),
		`UPDATE files SET trashed_at=NULL, updated_at=now()
		 WHERE id=$1 AND org_id=$2 AND trashed_at IS NOT NULL`,
		id, c.OrgID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "file not found or not trashed")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	// Access gate before reading the row so we don't leak metadata via
	// a 200 vs 404 split — CanAccessFile already returns a consistent
	// "is in org AND visible to me" signal.
	ok, err := sharing.CanAccessFile(r.Context(), h.DB, c, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !ok {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	if !h.vaultGateFile(w, r, id, c.UserID) {
		return
	}
	var f fileDTO
	if err := h.DB.QueryRow(r.Context(),
		`SELECT files.id, files.name, files.mime, files.size, files.status,
		        files.template_id, files.folder_id, files.created_at,
		        (sf.user_id IS NOT NULL) AS starred,
		        files.preview_pdf_id::text, files.convert_status, files.convert_warning
		 FROM files
		 LEFT JOIN starred_files sf
		   ON sf.file_id = files.id AND sf.user_id = $3::uuid
		 WHERE files.id=$1 AND files.org_id=$2 AND files.trashed_at IS NULL`,
		id, c.OrgID, c.UserID,
	).Scan(&f.ID, &f.Name, &f.Mime, &f.Size, &f.Status, &f.TemplateID, &f.FolderID, &f.CreatedAt, &f.Starred, &f.PreviewPdfID, &f.ConvertStatus, &f.ConvertWarning); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	writeJSON(w, 200, f)
}

// Star adds the file to the caller's starred list. Idempotent — a second
// star on the same file is a no-op (ON CONFLICT DO NOTHING). The access
// gate is the same one Download / Get use: if you can see the file, you
// can star it. That matches Drive / Dropbox behaviour.
//
// Returns {ok:true, starred:true} so the client can optimistically
// flip the icon without a refetch.
func (h *Handler) Star(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	ok, err := sharing.CanAccessFile(r.Context(), h.DB, c, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !ok {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	// org_id comes from the claims (not a second lookup) because
	// CanAccessFile already proved the file belongs to c.OrgID.
	if _, err := h.DB.Exec(r.Context(),
		`INSERT INTO starred_files (user_id, file_id, org_id)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, file_id) DO NOTHING`,
		c.UserID, id, c.OrgID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "starred": true})
}

// Unstar removes the star. Idempotent — unstarring a file that wasn't
// starred still returns 200 {ok:true,starred:false}, so the client can
// call this without needing to know the current state.
func (h *Handler) Unstar(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	// No access-gate check here: if the user isn't allowed to see the
	// file, the DELETE just matches zero rows. That avoids a second
	// round-trip to CanAccessFile on the common case.
	if _, err := h.DB.Exec(r.Context(),
		`DELETE FROM starred_files WHERE user_id=$1 AND file_id=$2`,
		c.UserID, id,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "starred": false})
}

func (h *Handler) Download(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	ok, err := sharing.CanAccessFile(r.Context(), h.DB, c, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !ok {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	if !h.vaultGateFile(w, r, id, c.UserID) {
		return
	}
	var key, name, mime, scanStatus, scanSig string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT storage_key, name, COALESCE(mime, ''),
		        COALESCE(scan_status, 'skipped'), COALESCE(scan_signature, '')
		   FROM files WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`,
		id, c.OrgID,
	).Scan(&key, &name, &mime, &scanStatus, &scanSig); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	// AV gate. Fail-closed: only 'clean' and 'skipped' are released.
	// 'pending'/'scanning' → 423 (locked, scan in progress).
	// 'infected'           → 451 (unavailable for legal reasons; the
	//                              closest standard code for "we refuse
	//                              to serve a known-bad payload").
	// 'error'              → 503 (engine couldn't decide; treat as
	//                              transient, surface the audit row).
	if msg, status, code, blocked := scanner.GateBlock(scanStatus, scanSig); blocked {
		writeErr(w, status, code, msg)
		return
	}
	// Pass the stored MIME so PresignGet can force `attachment` for
	// risky renderable types even if some future caller forgets the
	// filename — defense in depth against stored-XSS.
	url, err := h.Storage.PresignGet(r.Context(), key, mime, name, 5*time.Minute)
	if err != nil {
		writeErr(w, 500, "presign", err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"downloadUrl": url})
}

// maxZipFiles caps the number of files the bulk-zip endpoint will accept
// in a single request. Pre-flight cost is O(N) DB calls (auth + metadata
// + scan-status) before the first byte streams, so an unbounded N would
// let a malicious caller hold a request open for minutes. 500 covers
// every realistic "select all + download" workflow we've seen.
//
// The cap also applies AFTER folder expansion — i.e. you can ask for
// 1 folder and have it explode into 600 files, and the request will
// be rejected. This protects against accidentally zipping a giant
// shared folder when the user just wanted "this one folder I see."
const maxZipFiles = 500

// Zip streams a multi-file ZIP archive of every requested file the
// caller is allowed to read. Used by the Drive page's bulk-download
// action — replaces the previous client-side N-tabs loop, which got
// silently neutered by every browser's popup blocker after the first
// 1–2 files.
//
// All authorization, vault-unlock, and antivirus checks happen UP
// FRONT, before any byte hits the wire. Once we send
// `200 + Content-Type: application/zip`, there's no way to surface a
// JSON error — the browser is already saving. So we either reject the
// whole request with a clean error, or we commit to producing a zip.
//
// The one place we can't be transactional is per-file storage reader
// failures mid-stream (e.g. a transient S3 GET error after we've
// already written 2 MB into the zip entry). We log it, abandon the
// partial entry, and continue — the user gets a zip with N-1 files,
// which is better than a corrupt archive or a mid-save HTTP error
// that leaves a half-written .crdownload behind.
//
// Filenames inside the archive are de-duped with a Drive-style
// " (2)", " (3)" suffix before the extension so two files named
// `Report.pdf` don't collapse onto each other on extraction.
func (h *Handler) Zip(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	// Body shape: { "ids": ["<file-id>", ...], "folderIds": ["<folder-id>", ...] }.
	// Either may be empty, but the union — after expanding folders into
	// their descendant files — must be ≥1. POST (not GET) so the IDs
	// travel in the body; a GET with 200+ UUIDs in the query string
	// flirts with the 8 KB header limit some reverse proxies enforce.
	var body struct {
		Ids       []string `json:"ids"`
		FolderIds []string `json:"folderIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "bad_request", "invalid JSON body")
		return
	}
	if len(body.Ids) == 0 && len(body.FolderIds) == 0 {
		writeErr(w, 400, "bad_request", "ids or folderIds must not be empty")
		return
	}

	// De-dupe both ID lists before any work — a doubly-selected file
	// would occupy two slots against the cap and produce two
	// `Foo (2).pdf` entries; the same for folders.
	ids := dedupeStrings(body.Ids)
	folderIds := dedupeStrings(body.FolderIds)

	// PRE-FLIGHT: walk every requested ID through the same auth /
	// vault / scan gates the single-file Download handler enforces.
	// Folders expand into their descendant files (recursive CTE),
	// each of which goes through per-file authz and vault checks —
	// a folder share that grants access at the root might still be
	// gated by a locked sub-vault deeper in the tree.
	//
	// Any failure here aborts the whole request with a JSON error —
	// the response body has not been touched yet.
	entries := make([]zipEntry, 0, len(ids))

	// (1) Standalone file IDs — same flow as the file-only original.
	for _, id := range ids {
		e, status, code, msg, wroteResp, ok := h.zipPreflightFile(w, r, c, id, "")
		if !ok {
			if wroteResp {
				// vaultGateFile already wrote a 423 — just bail.
				return
			}
			writeErr(w, status, code, msg)
			return
		}
		entries = append(entries, e)
	}

	// (2) Folder IDs — expand each to its descendants and feed every
	// file through the same per-file pre-flight as above.
	//
	// Folder root authz is enforced once via CanAccessFolder; per
	// descendant, CanAccessFile catches any sub-tree where access
	// was revoked (revokes propagate down lazily, so this matters).
	folderArchiveName := "" // set when exactly one folder + no files; used as zip filename below
	for _, fid := range folderIds {
		ok, err := sharing.CanAccessFolder(r.Context(), h.DB, c, fid)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if !ok {
			writeErr(w, 404, "not_found",
				fmt.Sprintf("folder %s not found", fid))
			return
		}
		// Walk the folder + every descendant. Each row gives us
		// (file_id, dir_path) — dir_path is the slash-joined chain
		// of folder names from the requested root down to (but not
		// including) the file itself, so the zip preserves layout.
		descendants, rootName, err := h.zipExpandFolder(r.Context(), c.OrgID, fid)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if len(folderIds) == 1 && len(ids) == 0 {
			folderArchiveName = rootName
		}
		for _, d := range descendants {
			if len(entries) >= maxZipFiles {
				writeErr(w, 400, "too_many",
					fmt.Sprintf("zip is limited to %d files per request", maxZipFiles))
				return
			}
			e, status, code, msg, wroteResp, ok := h.zipPreflightFile(
				w, r, c, d.id, d.dirPath,
			)
			if !ok {
				if wroteResp {
					return
				}
				writeErr(w, status, code, msg)
				return
			}
			entries = append(entries, e)
		}
	}

	if len(entries) == 0 {
		writeErr(w, 400, "empty",
			"no files to download (folders may be empty)")
		return
	}
	if len(entries) > maxZipFiles {
		writeErr(w, 400, "too_many",
			fmt.Sprintf("zip is limited to %d files per request", maxZipFiles))
		return
	}

	// Commit to streaming. After this point the body is locked in:
	// any error becomes a connection close, never a JSON envelope.
	//
	// Filename heuristic: a single-folder request gets `<FolderName>.zip`
	// because that matches the user's mental model ("download this
	// folder"). Mixed selections fall back to the timestamped default.
	var archiveName string
	if folderArchiveName != "" {
		archiveName = sanitizeForFilename(folderArchiveName) + ".zip"
	} else {
		archiveName = fmt.Sprintf("docforge-%s.zip",
			time.Now().UTC().Format("20060102-150405"))
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename=%q`, archiveName))
	// nosniff on a zip mostly placates the linters — browsers don't
	// MIME-sniff application/zip into anything dangerous — but the
	// header is free and keeps the response shape consistent with
	// the rest of the file-serving endpoints.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Deliberately no Content-Length — we're streaming, the
	// compressed total isn't known ahead of time, and chunked
	// transfer-encoding is what lets the browser start saving while
	// the later entries are still being read from storage.
	w.WriteHeader(http.StatusOK)

	zw := zip.NewWriter(w)
	used := make(map[string]int, len(entries))
	for _, e := range entries {
		name := dedupeArchiveName(e.name, used)
		rc, _, err := h.Storage.GetReader(r.Context(), e.key)
		if err != nil {
			// Per-file failure mid-stream. We can't write a JSON
			// error any more, so the only reasonable action is to
			// log + skip. The zip's central directory still ends up
			// well-formed because we don't call Create() for this
			// entry at all.
			log.Printf("zip: GetReader %s (%s): %v", e.key, name, err)
			continue
		}
		zfw, err := zw.Create(name)
		if err != nil {
			rc.Close()
			log.Printf("zip: Create %s: %v", name, err)
			continue
		}
		if _, err := io.Copy(zfw, rc); err != nil {
			// Mid-entry copy error — the zip entry header is already
			// written, so the central directory will reference a
			// truncated file. Most extractors will surface this as
			// a CRC mismatch on that one entry; the rest of the
			// archive remains usable.
			log.Printf("zip: Copy %s: %v", name, err)
		}
		rc.Close()
	}
	if err := zw.Close(); err != nil {
		log.Printf("zip: Close: %v", err)
	}
}

// zipEntry is one file's slot in the archive after pre-flight passes.
// `name` is the path inside the zip (may contain "/" when the file
// came from a folder expansion); `key` is the storage object key the
// streaming step will read from.
type zipEntry struct {
	key  string
	name string
	mime string
}

// dedupeStrings returns a copy of `in` with duplicates removed, in
// first-seen order. Used to clean caller-supplied ID lists before
// any DB work.
func dedupeStrings(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

// zipPreflightFile runs the full per-file gate (sharing access,
// vault, AV scan, metadata fetch) for a single file ID and returns
// either the resolved zipEntry, or a structured error to surface.
//
// The dirPath argument prefixes the archive name (used during folder
// expansion). For standalone file IDs pass "".
//
// vaultGateFile writes its own 423 response; we forward the same
// ResponseWriter so the modal-friendly error envelope reaches the
// client. When that happens we signal "caller must just return" with
// `wroteResp == true` — the body is committed and the caller can't
// add another writeErr on top.
//
//   - ok == true                       → use `e`, no error.
//   - ok == false && wroteResp == true → response already written, just return.
//   - ok == false && wroteResp == false → caller writes via writeErr(status, code, msg).
func (h *Handler) zipPreflightFile(
	w http.ResponseWriter, r *http.Request, c *auth.Claims,
	fileID, dirPath string,
) (e zipEntry, status int, code, msg string, wroteResp, ok bool) {
	allowed, err := sharing.CanAccessFile(r.Context(), h.DB, c, fileID)
	if err != nil {
		return zipEntry{}, 500, "db_error", err.Error(), false, false
	}
	if !allowed {
		return zipEntry{}, 404, "not_found",
			fmt.Sprintf("file %s not found", fileID), false, false
	}
	if !h.vaultGateFile(w, r, fileID, c.UserID) {
		return zipEntry{}, 0, "", "", true, false
	}
	var key, name, mime, scanStatus, scanSig string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT storage_key, name, COALESCE(mime, ''),
		        COALESCE(scan_status, 'skipped'), COALESCE(scan_signature, '')
		   FROM files WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`,
		fileID, c.OrgID,
	).Scan(&key, &name, &mime, &scanStatus, &scanSig); err != nil {
		return zipEntry{}, 404, "not_found",
			fmt.Sprintf("file %s not found", fileID), false, false
	}
	if m, st, cd, blocked := scanner.GateBlock(scanStatus, scanSig); blocked {
		return zipEntry{}, st, cd,
			fmt.Sprintf("file %s: %s", fileID, m), false, false
	}
	archiveName := name
	if dirPath != "" {
		archiveName = dirPath + "/" + name
	}
	return zipEntry{key: key, name: archiveName, mime: mime},
		0, "", "", false, true
}

// zipFolderDescendant — one row of a folder's expanded descendant list.
type zipFolderDescendant struct {
	id      string
	dirPath string // slash-joined chain from the requested root
}

// zipExpandFolder walks a folder and every descendant, returning one
// entry per file found. `dirPath` on each row is the requested root's
// name plus the chain of subfolders, slash-joined (e.g.
// "Reports/Q4/audits") — empty when the file lives directly in the
// requested root and the root has no name (which shouldn't happen).
//
// The recursive CTE is bounded by the org_id filter, so a malicious
// caller can't pivot into another org by passing a known ID; the
// outer CanAccessFolder check is the gate that lets them in at all.
//
// Returns the list of descendant files plus the requested root's
// display name (used to title the resulting archive when only one
// folder was requested).
func (h *Handler) zipExpandFolder(
	ctx context.Context, orgID, folderID string,
) ([]zipFolderDescendant, string, error) {
	// One round trip: anchor at the requested root, recurse via
	// parent_id, then JOIN the files table to enumerate files at
	// every node. Path is built as a text array so we can format
	// any way we want server-side without re-walking.
	rows, err := h.DB.Query(ctx, `
		WITH RECURSIVE tree AS (
		  SELECT id, parent_id, name, ARRAY[name]::text[] AS path
		    FROM folders WHERE id=$1 AND org_id=$2
		  UNION ALL
		  SELECT f.id, f.parent_id, f.name, t.path || f.name
		    FROM folders f
		    JOIN tree t ON f.parent_id = t.id
		    WHERE f.org_id=$2
		)
		SELECT f.id::text,
		       array_to_string(t.path, '/') AS dir_path
		  FROM files f
		  JOIN tree t ON f.folder_id = t.id
		  WHERE f.org_id=$2 AND f.trashed_at IS NULL
		  ORDER BY t.path, f.name`,
		folderID, orgID,
	)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []zipFolderDescendant{}
	for rows.Next() {
		var id, dirPath string
		if err := rows.Scan(&id, &dirPath); err != nil {
			return nil, "", err
		}
		out = append(out, zipFolderDescendant{id: id, dirPath: dirPath})
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	// Look up the root folder's name separately. We could derive
	// it from the first row of the CTE, but folders can be empty —
	// a "name your folder, leave it empty, click Download" flow
	// would otherwise return ("", nil) and we'd lose the title.
	var rootName string
	if err := h.DB.QueryRow(ctx,
		`SELECT name FROM folders WHERE id=$1 AND org_id=$2`,
		folderID, orgID,
	).Scan(&rootName); err != nil {
		return nil, "", err
	}
	return out, rootName, nil
}

// sanitizeForFilename removes characters that would break a HTTP
// Content-Disposition header or a filesystem path: control chars,
// path separators, and the few ASCII glyphs Windows still chokes on.
// Trailing dots are also stripped because Windows silently drops
// them on rename.
func sanitizeForFilename(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "folder"
	}
	repl := func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return '_'
		}
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return '_'
		}
		return r
	}
	s = strings.Map(repl, s)
	s = strings.TrimRight(s, ". ")
	if s == "" {
		return "folder"
	}
	return s
}

// dedupeArchiveName returns a unique-within-the-archive filename
// derived from `name`, in the same style as Drive's "make a copy"
// rename: `Report.pdf` → `Report (2).pdf` → `Report (3).pdf`.
//
// The `used` map is mutated in place — callers pass a fresh map per
// archive so de-dup state doesn't leak across requests. We also bump
// the count for the synthesized name itself, which protects against
// the (rare) case where the user has both `Report.pdf` and a literal
// `Report (2).pdf` in the same selection.
func dedupeArchiveName(name string, used map[string]int) string {
	// Strip any leading separators a caller might smuggle in (an
	// archive name like "/etc/passwd" is treated as a relative path
	// by some extractors but we want flat siblings inside the zip).
	name = strings.TrimLeft(filepath.ToSlash(name), "/")
	if name == "" {
		name = "file"
	}
	n := used[name]
	used[name] = n + 1
	if n == 0 {
		return name
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	candidate := fmt.Sprintf("%s (%d)%s", base, n+1, ext)
	used[candidate]++
	return candidate
}

// inlinePreviewMaxBytes caps the total bytes the InlinePreview proxy will
// stream in a single response. Inline previews are meant for "small enough
// to render in an iframe" content — anyone trying to push gigabytes through
// the proxy is either a bug or an abuser. The cap is well above any
// reasonable HTML/SVG/image preview but low enough that we don't become
// a free CDN for arbitrary stored blobs.
const inlinePreviewMaxBytes = 25 * 1024 * 1024

// inlinePreviewAllowedMime returns true for MIMEs we're willing to render
// inline through the proxy. The CSP header in the response is the primary
// XSS defence, but layering an allowlist keeps random / malformed content
// (e.g. an .exe someone forced through) from being served at all.
//
// Notable inclusions and exclusions:
//
//   - text/html       — allowed, but the strict default CSP keeps it inert
//                        (no JS, sandboxed). Orgs that want a permissive
//                        preview must opt into a relaxed CSP.
//   - image/svg(+xml) — allowed: SVG can host JS, but the CSP's
//                        default-src 'none' + sandbox blocks execution.
//   - application/pdf — allowed: pdf.js / browser PDF viewer renders it.
//   - image/*         — allowed: rasters can't execute.
//   - text/plain, text/csv, application/json — allowed: shown as text.
//
// Everything else (JS, executables, opaque office docs, archives) is 415.
// If the storage MIME is empty we treat it as plain text — the safest
// default for "we don't know what this is."
func inlinePreviewAllowedMime(m string) bool {
	m = strings.ToLower(strings.TrimSpace(m))
	if i := strings.Index(m, ";"); i >= 0 {
		m = strings.TrimSpace(m[:i])
	}
	if m == "" {
		return false // never serve unknown bytes inline; caller must fix the row
	}
	if strings.HasPrefix(m, "image/") {
		return true
	}
	switch m {
	case "text/html", "application/xhtml+xml",
		"text/plain", "text/csv", "text/markdown",
		"application/json",
		"application/pdf":
		return true
	}
	return false
}

// inlinePreviewResp accompanies the streaming bytes only when the caller
// asks for `?meta=1`. The web app calls the JSON variant first to learn
// the iframe sandbox token, then renders `<iframe src="...?stream=1"
// sandbox={iframeSandbox}>` to fetch the bytes. Splitting metadata from
// bytes keeps the streaming path free of JSON-decode overhead.
type inlinePreviewMeta struct {
	URL            string `json:"url"`            // self-link with ?stream=1
	Mime           string `json:"mime"`
	IframeSandbox  string `json:"iframeSandbox"`  // literal value for <iframe sandbox="...">
	CSP            string `json:"csp"`            // mirror of the header for visibility
	BytesAvailable int64  `json:"bytesAvailable"` // 0 = unknown
}

// InlinePreview is the same-origin streaming proxy that hosts content
// destined for a sandboxed <iframe>. Unlike a presigned URL (which can't
// carry arbitrary headers), this proxy:
//
//   - Attaches Content-Security-Policy from the org's resolved policy.
//     Defense-in-depth: even if the bytes turn out to be a forged
//     text/html that slipped past the sniffer, the CSP keeps it inert.
//   - Sends Content-Disposition: inline so the browser renders rather
//     than downloads.
//   - Adds X-Content-Type-Options: nosniff so the browser doesn't
//     re-interpret the response as a different (possibly more dangerous)
//     MIME.
//   - Honours the same scan gate as Download — fail-closed on
//     pending/infected/error.
//
// `?meta=1` returns JSON metadata (url + iframe sandbox + CSP) instead
// of the bytes; the frontend uses this to set the iframe's `sandbox`
// attribute before kicking off the stream.
func (h *Handler) InlinePreview(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	ok, err := sharing.CanAccessFile(r.Context(), h.DB, c, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !ok {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	if !h.vaultGateFile(w, r, id, c.UserID) {
		return
	}
	var key, name, mime, scanStatus, scanSig string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT storage_key, name, COALESCE(mime, ''),
		        COALESCE(scan_status, 'skipped'), COALESCE(scan_signature, '')
		   FROM files WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`,
		id, c.OrgID,
	).Scan(&key, &name, &mime, &scanStatus, &scanSig); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	if msg, status, code, blocked := scanner.GateBlock(scanStatus, scanSig); blocked {
		writeErr(w, status, code, msg)
		return
	}
	if !inlinePreviewAllowedMime(mime) {
		writeErr(w, 415, "preview_not_supported",
			"this file type cannot be previewed inline")
		return
	}

	// Resolve the org's effective preview policy. If Policy isn't wired
	// (tests, certain code paths) fall back to package defaults so we
	// still emit a meaningful CSP rather than an open one.
	csp := uploadpolicy.DefaultPreviewCSP
	sandbox := uploadpolicy.DefaultPreviewIframeSandbox
	var embedOrigins []string
	if h.Policy != nil {
		if p, perr := h.Policy.Effective(r.Context(), c.OrgID); perr == nil {
			if p.PreviewCSP != "" {
				csp = p.PreviewCSP
			}
			sandbox = p.PreviewIframeSandbox
			embedOrigins = p.EmbedAllowedOrigins
		}
	}
	// Merge frame-ancestors from the org's embed allowlist into the
	// preview CSP so customer sites can iframe the preview when the
	// admin has opted in. Empty allowlist → "frame-ancestors 'self'",
	// matching the X-Frame-Options: SAMEORIGIN posture we strip below.
	csp = csp + "; " + uploadpolicy.BuildFrameAncestors(embedOrigins)

	// Metadata branch — the frontend uses this to learn the sandbox
	// attribute it must set on the <iframe> before it loads the stream.
	if r.URL.Query().Get("meta") == "1" {
		writeJSON(w, 200, inlinePreviewMeta{
			URL:           fmt.Sprintf("/v1/files/%s/inline-preview?stream=1", id),
			Mime:          mime,
			IframeSandbox: sandbox,
			CSP:           csp,
		})
		return
	}

	rd, size, err := h.Storage.GetReader(r.Context(), key)
	if err != nil {
		writeErr(w, 500, "storage_error", err.Error())
		return
	}
	defer rd.Close()
	if size > 0 && size > inlinePreviewMaxBytes {
		writeErr(w, 413, "preview_too_large",
			fmt.Sprintf("inline preview supports up to %d bytes", inlinePreviewMaxBytes))
		return
	}

	// Headers — order matters only for clarity. Set them all before the
	// first Write() to avoid the http package locking in a default 200
	// without our security headers.
	hdr := w.Header()
	hdr.Set("Content-Type", mime)
	hdr.Set("Content-Security-Policy", csp)
	hdr.Set("X-Content-Type-Options", "nosniff")
	// The global middleware sets X-Frame-Options: SAMEORIGIN, which some
	// browsers honour in preference to the CSP frame-ancestors when both
	// are present. Strip it on the embed surface so the wider allowlist
	// actually takes effect.
	hdr.Del("X-Frame-Options")
	// inline + a sanitised filename. We reuse the storage layer's
	// sanitiser-by-presign indirectly by emitting a safe filename here.
	dispName := name
	if dispName == "" {
		dispName = "preview"
	}
	hdr.Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, sanitizeHeaderFilename(dispName)))
	// Cache: short, private. Inline previews are scan-gated, so a stale
	// CDN copy could keep serving an infected file after we quarantine it.
	hdr.Set("Cache-Control", "private, max-age=30")
	if size > 0 {
		hdr.Set("Content-Length", fmt.Sprintf("%d", size))
	}
	w.WriteHeader(200)

	// Hard ceiling on bytes streamed even if Stat lied about size — the
	// io.LimitReader collapses cleanly if the object grew between the
	// Stat call and the Read.
	_, _ = io.Copy(w, io.LimitReader(rd, inlinePreviewMaxBytes+1))
}

// isPDFMime reports whether the canonical MIME we resolved at upload
// time is application/pdf. Used to gate the structural inspection so
// non-PDFs don't pay the cost of a 50 MiB read + token scan.
func isPDFMime(mime string) bool {
	m := strings.ToLower(strings.TrimSpace(mime))
	if i := strings.Index(m, ";"); i >= 0 {
		m = strings.TrimSpace(m[:i])
	}
	return m == "application/pdf"
}

// buildUploadCompletedMeta is the single source of truth for the JSON
// payload attached to a successful "file.upload.completed" audit row.
// Extracted so the wire shape can be regression-locked in tests — every
// key here is a contract the audit UI / forensic tooling depends on, so
// silently dropping or renaming one would break log replay without a
// loud test failure.
//
// `actualMime` and `actualSize` are the post-canonicalisation values
// (what we actually stored), not the client's original claim — the
// claim is recorded separately by the matching "file.upload.intent"
// row at presign time.
func buildUploadCompletedMeta(fileID, name, actualMime string, actualSize int64, scanEnabled bool, templateID string) map[string]any {
	scanStatus := "skipped"
	if scanEnabled {
		scanStatus = "pending"
	}
	m := map[string]any{
		"fileId":      fileID,
		"name":        name,
		"actualMime":  actualMime,
		"actualSize":  actualSize,
		"scanEnabled": scanEnabled,
		"scanStatus":  scanStatus,
	}
	if templateID != "" {
		m["templateId"] = templateID
	}
	return m
}

// runPDFInspection streams the just-uploaded PDF from storage through
// pdfsec.Inspect and reports whether any of policy.PdfBlockedFeatures
// fired. Returns (blocked, signature, error) — signature is the
// canonical pdfsec.Threat constant of the first blocked feature so
// the caller can persist it as `pdf:<threat>` and the audit log /
// scan_signature stays machine-readable.
//
// When PdfBlockedFeatures is empty AND the policy turned hardening on,
// we substitute pdfsec.DefaultBlockedFeatures so the toggle behaves
// "secure by default" rather than silently report-only. An org that
// truly wants report-only mode passes an explicit empty list — we
// detect that with a nil/empty distinction at the policy layer.
func (h *Handler) runPDFInspection(ctx context.Context, key string, p uploadpolicy.Policy) (bool, string, error) {
	rd, _, err := h.Storage.GetReader(ctx, key)
	if err != nil {
		return false, "", err
	}
	defer rd.Close()
	rep, err := pdfsec.Inspect(rd)
	if err != nil {
		// Magic-bytes mismatch — caller shouldn't have invoked us, but
		// be defensive: return "not blocked" rather than failing the
		// whole upload over a wrong-MIME header.
		if errors.Is(err, pdfsec.ErrNotPDF) {
			return false, "", nil
		}
		return false, "", err
	}
	blocked := p.PdfBlockedFeatures
	if blocked == nil {
		blocked = pdfsec.DefaultBlockedFeatures
	}
	sig := pdfsec.FirstBlocked(rep, blocked)
	if sig == "" {
		return false, "", nil
	}
	return true, sig, nil
}

// sanitizeHeaderFilename strips the four header-injection vectors
// (CR, LF, ", \) before we reflect a name into Content-Disposition.
// Mirrors storage.sanitizeDispFilename — duplicated to avoid pulling
// the storage package's internals through an exported surface.
func sanitizeHeaderFilename(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '"' || c == '\\' || c == '\r' || c == '\n' {
			out = append(out, '_')
			continue
		}
		out = append(out, c)
	}
	return string(out)
}

type patchReq struct {
	Name     *string `json:"name"`
	FolderID *string `json:"folderId"` // "" = root
	// Tags: nil = leave alone, []string{} = clear, [...]= replace.
	// We replace rather than merge because the client always has the
	// authoritative list (it just edited the chip row); a merge here
	// would let stale chips re-appear on a slow second client.
	Tags *[]string `json:"tags,omitempty"`
	// AcceptRenameSuggestion: when true, copy auto_rename_suggestion
	// onto name (preserving the prior name in original_name if not
	// already set) and clear the suggestion. Mutually exclusive with
	// DismissRenameSuggestion; both true = ambiguous, treated as
	// AcceptRenameSuggestion.
	AcceptRenameSuggestion bool `json:"acceptRenameSuggestion,omitempty"`
	// DismissRenameSuggestion: when true, just clear the suggestion
	// without changing name. The "no, the original is fine" path.
	DismissRenameSuggestion bool `json:"dismissRenameSuggestion,omitempty"`
	// RevertRename: when true, copy original_name back onto name and
	// clear original_name. The undo path for an auto-applied rename.
	RevertRename bool `json:"revertRename,omitempty"`
}

func (h *Handler) Patch(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	// Only the owner (or an admin) can rename / move.
	if !c.IsAdmin() {
		var owns bool
		if err := h.DB.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM files WHERE id=$1 AND org_id=$2 AND owner_id=$3 AND trashed_at IS NULL)`,
			id, c.OrgID, c.UserID).Scan(&owns); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if !owns {
			writeErr(w, 403, "forbidden", "only the owner can modify this file")
			return
		}
	}
	var req patchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Name != nil && *req.Name != "" {
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files SET name=$1, updated_at=now() WHERE id=$2 AND org_id=$3`,
			*req.Name, id, c.OrgID,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}
	if req.FolderID != nil {
		var arg interface{}
		if *req.FolderID == "" {
			arg = nil
		} else {
			var ok bool
			_ = h.DB.QueryRow(r.Context(),
				`SELECT EXISTS(SELECT 1 FROM folders WHERE id=$1 AND org_id=$2)`,
				*req.FolderID, c.OrgID,
			).Scan(&ok)
			if !ok {
				writeErr(w, 400, "bad_folder", "folder not found")
				return
			}
			arg = *req.FolderID
		}
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files SET folder_id=$1, updated_at=now() WHERE id=$2 AND org_id=$3`,
			arg, id, c.OrgID,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}
	// Tag replacement. We normalise lightly here (trim, dedupe, drop
	// empties) because the chip-input UI is forgiving but we don't want
	// the DB to hold whitespace-only entries that overlap-queries can't
	// match. Heavy normalisation (lowercase, stop-word drop) lives in
	// the autotag package; user-typed tags stay close to what they
	// typed beyond the basics.
	if req.Tags != nil {
		clean := make([]string, 0, len(*req.Tags))
		seen := make(map[string]struct{}, len(*req.Tags))
		for _, t := range *req.Tags {
			t = strings.TrimSpace(t)
			if t == "" {
				continue
			}
			key := strings.ToLower(t)
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			clean = append(clean, t)
		}
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files SET tags=$1, updated_at=now() WHERE id=$2 AND org_id=$3`,
			clean, id, c.OrgID,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}
	// Rename-suggestion lifecycle. Accept wins if both flags are set
	// (Dismiss is the safer no-op so an accidental double-flag still
	// applies the user's apparent positive intent). Revert is
	// independent — a user who reverts an auto-applied rename isn't
	// interacting with the suggestion column at all.
	switch {
	case req.AcceptRenameSuggestion:
		// COALESCE on original_name preserves the upload-time name on
		// the *first* accept; subsequent edits don't clobber it. The
		// suggestion column is cleared so the banner disappears.
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files
			    SET name = COALESCE(auto_rename_suggestion, name),
			        original_name = COALESCE(original_name, name),
			        auto_rename_suggestion = NULL,
			        updated_at = now()
			  WHERE id=$1 AND org_id=$2 AND auto_rename_suggestion IS NOT NULL`,
			id, c.OrgID,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	case req.DismissRenameSuggestion:
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files SET auto_rename_suggestion = NULL, updated_at = now()
			  WHERE id=$1 AND org_id=$2`,
			id, c.OrgID,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}
	if req.RevertRename {
		// Only acts when original_name is populated — i.e. an
		// auto-rename was actually applied. The WHERE guard means a
		// stray RevertRename:true on a never-renamed file is a no-op
		// instead of nuking the user's chosen name.
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files
			    SET name = original_name,
			        original_name = NULL,
			        updated_at = now()
			  WHERE id=$1 AND org_id=$2 AND original_name IS NOT NULL`,
			id, c.OrgID,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	// Only the owner (or an admin) can trash. Shared-with viewers/editors
	// can't delete resources they don't own.
	ownerFilter := "AND owner_id=$3"
	args := []any{id, c.OrgID, c.UserID}
	if c.IsAdmin() {
		ownerFilter = ""
		args = args[:2]
	}
	tag, err := h.DB.Exec(r.Context(),
		`UPDATE files SET trashed_at=now() WHERE id=$1 AND org_id=$2 `+ownerFilter+` AND trashed_at IS NULL`,
		args...,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	// Cascade the trash flag to any office-doc preview PDF child so the
	// converted sibling doesn't linger as a hidden orphan after the source
	// is gone. Best-effort — the user-visible source is already in trash.
	_, _ = h.DB.Exec(r.Context(),
		`UPDATE files SET trashed_at=now()
		   WHERE id = (SELECT preview_pdf_id FROM files WHERE id=$1)
		     AND org_id=$2 AND trashed_at IS NULL`,
		id, c.OrgID,
	)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// Purge hard-deletes a file that's already in the trash. Unlike Delete
// (which only flips trashed_at), this removes the database row AND the
// blob in storage — recovery is impossible after this point.
//
// Scope: same as Delete. Only the owner (or an admin) may purge. Files
// not currently in trash return 409 so the UI can't accidentally skip
// the two-step trash → purge flow.
func (h *Handler) Purge(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	ownerFilter := "AND owner_id=$3"
	args := []any{id, c.OrgID, c.UserID}
	if c.IsAdmin() {
		ownerFilter = ""
		args = args[:2]
	}

	// Fetch the storage_key first so we can clean up the blob after the
	// DB row is gone. Doing the DELETE first and then reading storage_key
	// would be impossible — and doing storage-delete first would risk
	// orphaning the DB row if storage fails.
	var storageKey string
	err := h.DB.QueryRow(r.Context(),
		`SELECT storage_key FROM files
		 WHERE id=$1 AND org_id=$2 AND trashed_at IS NOT NULL `+ownerFilter,
		args...,
	).Scan(&storageKey)
	if err != nil {
		// pgx returns ErrNoRows for "not found" — we collapse that into a
		// 404 so the client can't distinguish "doesn't exist" from "not
		// yours" (no information leak across org / owner boundaries).
		writeErr(w, 404, "not_found", "file not in trash")
		return
	}

	// Capture the office-doc preview child (if any) before we DELETE the
	// source row. The FK is ON DELETE SET NULL on the source side, so
	// deleting the source doesn't touch the preview row — we'd leak an
	// orphan PDF (and its blob) if we didn't grab it now.
	var previewID, previewKey string
	_ = h.DB.QueryRow(r.Context(),
		`SELECT p.id::text, p.storage_key
		   FROM files src
		   JOIN files p ON p.id = src.preview_pdf_id
		  WHERE src.id=$1 AND src.org_id=$2`,
		id, c.OrgID,
	).Scan(&previewID, &previewKey)

	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM files WHERE id=$1 AND org_id=$2 AND trashed_at IS NOT NULL `+ownerFilter,
		args...,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		// Race — someone else purged it between the SELECT and DELETE.
		writeErr(w, 404, "not_found", "file not in trash")
		return
	}

	// Blob removal is best-effort. If it fails we still report success —
	// the DB row (and therefore the user-visible file) is gone; a retry
	// wouldn't help anyway because the row is no longer here to look it
	// up. The storage layer is expected to have its own orphan sweeper.
	if storageKey != "" {
		_ = h.Storage.Remove(r.Context(), storageKey)
	}
	if previewID != "" {
		_, _ = h.DB.Exec(r.Context(), `DELETE FROM files WHERE id=$1`, previewID)
		if previewKey != "" {
			_ = h.Storage.Remove(r.Context(), previewKey)
		}
	}

	writeJSON(w, 200, map[string]any{"ok": true})
}

// EmptyTrash hard-deletes every trashed file the caller can purge. For a
// normal user that's "everything I trashed"; for an admin it's "every
// trashed file in the org". Returns the count of files removed so the
// UI can show "Deleted N files" without a refetch-and-diff.
func (h *Handler) EmptyTrash(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	ownerFilter := "AND owner_id=$2"
	args := []any{c.OrgID, c.UserID}
	if c.IsAdmin() {
		ownerFilter = ""
		args = args[:1]
	}

	// Collect storage keys first so we can clean blobs after the
	// transaction commits. We batch in one query rather than one-per-row
	// to keep this O(1) round trips to the DB.
	rows, err := h.DB.Query(r.Context(),
		`SELECT storage_key FROM files
		 WHERE org_id=$1 AND trashed_at IS NOT NULL `+ownerFilter,
		args...,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	var keys []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			rows.Close()
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if k != "" {
			keys = append(keys, k)
		}
	}
	rows.Close()

	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM files
		 WHERE org_id=$1 AND trashed_at IS NOT NULL `+ownerFilter,
		args...,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	// Same best-effort pattern as Purge. We don't fail the whole request
	// if a handful of blobs fail to delete — the authoritative source of
	// truth (the DB) is already updated.
	for _, k := range keys {
		_ = h.Storage.Remove(r.Context(), k)
	}

	writeJSON(w, 200, map[string]any{
		"ok":      true,
		"deleted": tag.RowsAffected(),
	})
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}

// extensionMime is a hardcoded fallback table for the file types we
// care about routing on (preview, OCR, docchat). The Go stdlib's
// mime.TypeByExtension consults the host OS's MIME registry, which on
// minimal Linux containers and some Windows installs returns empty
// for image/* and even some Office formats — so we override with
// canonical IANA strings here. Keep in sync with the MIME allowlist
// in uploadpolicy and with the frontend's `file.mime.startsWith(...)`
// branches in web/app/drive/*.
var extensionMime = map[string]string{
	// images — primary use case (OCR pipeline routes on image/*)
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".tif":  "image/tiff",
	".tiff": "image/tiff",
	".heic": "image/heic",
	".heif": "image/heif",
	".svg":  "image/svg+xml",
	// documents
	".pdf":  "application/pdf",
	".txt":  "text/plain",
	".csv":  "text/csv",
	".md":   "text/markdown",
	".json": "application/json",
	".xml":  "application/xml",
	".html": "text/html",
	".htm":  "text/html",
	// office (kept for completeness — convert pipeline already keys on these)
	".doc":  "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls":  "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt":  "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".odt":  "application/vnd.oasis.opendocument.text",
	".ods":  "application/vnd.oasis.opendocument.spreadsheet",
	".odp":  "application/vnd.oasis.opendocument.presentation",
	".rtf":  "application/rtf",
	// archives
	".zip": "application/zip",
}

// guessMimeFromName derives a content-type from the filename extension.
// Returns "" when no good guess is available so the caller can decide
// whether to fall back to application/octet-stream or reject the upload.
// Tries the curated table first (deterministic across hosts), then the
// stdlib lookup, then empty.
func guessMimeFromName(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		return ""
	}
	if m, ok := extensionMime[ext]; ok {
		return m
	}
	if m := mime.TypeByExtension(ext); m != "" {
		// stdlib often returns "text/plain; charset=utf-8" — strip the
		// parameter so DB rows stay short and downstream prefix matches
		// (image/, application/pdf) keep working.
		if i := strings.IndexByte(m, ';'); i > 0 {
			m = strings.TrimSpace(m[:i])
		}
		return m
	}
	return ""
}
