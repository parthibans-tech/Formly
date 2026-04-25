package files

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/billing"
	"github.com/docforge/api/internal/events"
	"github.com/docforge/api/internal/sharing"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Detector runs after a file upload completes. It may return a template ID if one was created.
type Detector func(ctx context.Context, fileID, orgID, name, mime, storageKey string) (string, error)

type Handler struct {
	DB       *pgxpool.Pool
	Storage  *storage.Client
	Detector Detector
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
}

type uploadURLReq struct {
	Name string `json:"name"`
	Mime string `json:"mime"`
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
	FileID    string `json:"fileId"`
	UploadURL string `json:"uploadUrl"`
	Key       string `json:"key"`
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
	if req.Mime == "" {
		req.Mime = "application/octet-stream"
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
			writeErr(w, 403, "forbidden", "only the file's owner or an admin can replace it")
			return
		}
		// Reset status back to "pending" until Complete re-runs. If the
		// existing storage_key is empty (edge case: original upload
		// never finished) we regenerate it; otherwise we overwrite in
		// place at the same key.
		key := existingStorageKey
		if key == "" {
			key = fmt.Sprintf("orgs/%s/files/%s/%s", c.OrgID, existingID, req.Name)
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
		url, err := h.Storage.PresignPut(r.Context(), key, 15*time.Minute)
		if err != nil {
			writeErr(w, 500, "presign", err.Error())
			return
		}
		writeJSON(w, 200, uploadURLResp{
			FileID:    existingID,
			UploadURL: url,
			Key:       key,
			Replaced:  true,
		})
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
	key := fmt.Sprintf("orgs/%s/files/%s/%s", c.OrgID, id, req.Name)
	if _, err := h.DB.Exec(r.Context(), `UPDATE files SET storage_key=$1 WHERE id=$2`, key, id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	url, err := h.Storage.PresignPut(r.Context(), key, 15*time.Minute)
	if err != nil {
		writeErr(w, 500, "presign", err.Error())
		return
	}
	writeJSON(w, 200, uploadURLResp{
		FileID:       id,
		UploadURL:    url,
		Key:          key,
		ResolvedName: resolvedName,
	})
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
			writeErr(w, le.Status, le.Code, le.Message)
			return
		}
	}

	if _, err := h.DB.Exec(r.Context(),
		`UPDATE files SET status='active', size=$1, updated_at=now() WHERE id=$2`,
		info.Size, id,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	resp := map[string]any{"ok": true, "size": info.Size}
	if h.Detector != nil {
		tplID, err := h.Detector(r.Context(), id, c.OrgID, name, mime, key)
		if err == nil && tplID != "" {
			resp["templateId"] = tplID
		}
	}
	events.Publish(r.Context(), events.FileUploaded, c.OrgID, map[string]interface{}{
		"fileId":     id,
		"name":       name,
		"mime":       mime,
		"size":       info.Size,
		"templateId": resp["templateId"],
	})
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
	                       (sf.user_id IS NOT NULL) AS starred
	               FROM files
	               LEFT JOIN starred_files sf
	                 ON sf.file_id = files.id AND sf.user_id = $1::uuid`

	var sql string
	var args []any
	switch view {
	case "trashed":
		vis, vargs := visClause(3)
		sql = baseSelect + `
		       WHERE files.org_id=$2 AND files.trashed_at IS NOT NULL` + vis + `
		       ORDER BY files.created_at DESC
		       LIMIT 200`
		args = append([]any{c.UserID, c.OrgID}, vargs...)
	case "templates":
		vis, vargs := visClause(3)
		sql = baseSelect + `
		       WHERE files.org_id=$2 AND files.trashed_at IS NULL AND files.template_id IS NOT NULL` + vis + `
		       ORDER BY files.created_at DESC
		       LIMIT 200`
		args = append([]any{c.UserID, c.OrgID}, vargs...)
	case "recent":
		vis, vargs := visClause(3)
		sql = baseSelect + `
		       WHERE files.org_id=$2 AND files.trashed_at IS NULL` + vis + `
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
		         AND sf.user_id IS NOT NULL` + vis + `
		       ORDER BY sf.created_at DESC
		       LIMIT 200`
		args = append([]any{c.UserID, c.OrgID}, vargs...)
	default:
		folder := q.Get("folder") // "" = root
		vis, vargs := visClause(4)
		sql = baseSelect + `
		       WHERE files.org_id=$2 AND files.trashed_at IS NULL
		         AND (($3='' AND files.folder_id IS NULL) OR files.folder_id::text=$3)` + vis + `
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
		if err := rows.Scan(&f.ID, &f.Name, &f.Mime, &f.Size, &f.Status, &f.TemplateID, &f.FolderID, &f.CreatedAt, &f.Starred); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
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
	var f fileDTO
	if err := h.DB.QueryRow(r.Context(),
		`SELECT files.id, files.name, files.mime, files.size, files.status,
		        files.template_id, files.folder_id, files.created_at,
		        (sf.user_id IS NOT NULL) AS starred
		 FROM files
		 LEFT JOIN starred_files sf
		   ON sf.file_id = files.id AND sf.user_id = $3::uuid
		 WHERE files.id=$1 AND files.org_id=$2 AND files.trashed_at IS NULL`,
		id, c.OrgID, c.UserID,
	).Scan(&f.ID, &f.Name, &f.Mime, &f.Size, &f.Status, &f.TemplateID, &f.FolderID, &f.CreatedAt, &f.Starred); err != nil {
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
	var key, name string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT storage_key, name FROM files WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`, id, c.OrgID,
	).Scan(&key, &name); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	url, err := h.Storage.PresignGet(r.Context(), key, name, 5*time.Minute)
	if err != nil {
		writeErr(w, 500, "presign", err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"downloadUrl": url})
}

type patchReq struct {
	Name     *string `json:"name"`
	FolderID *string `json:"folderId"` // "" = root
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
