// Package platformstorage powers the super-admin Storage Management
// console: a cross-tenant operator surface for the object-storage
// subsystem (MinIO / S3 / GCS).
//
// Why this exists
// ---------------
// The /admin/* console already has dashboards and per-org analytics, but
// storage was a blind spot: an operator couldn't answer "what's
// consuming the bucket", "is anything stuck pending forever", "is the
// trash growing", or "is the backend even reachable" without dropping
// into psql + the MinIO console. This package collapses those workflows
// into a single API surface behind requireSuperAdmin.
//
// Surface
// -------
//
//	GET  /v1/admin/storage/overview        — global health snapshot
//	                                         (totals, status / classification
//	                                         / scan distributions, top
//	                                         MIMEs, top extensions, trash
//	                                         age histogram, top orgs, top
//	                                         files, backend ping).
//	GET  /v1/admin/storage/inventory       — paginated file browser with
//	                                         filters (orgId, ownerEmail,
//	                                         status, scanStatus,
//	                                         classification, mime,
//	                                         minSize, includeTrashed,
//	                                         q for name/key search).
//	GET  /v1/admin/storage/files/{id}      — single file detail (joins
//	                                         org name, owner email, recent
//	                                         scan_jobs).
//	POST /v1/admin/storage/files/{id}/purge
//	                                       — hard-delete: drops the row +
//	                                         object. Refuses legal_hold.
//	POST /v1/admin/storage/files/bulk-purge
//	                                       — hard-delete by id list, cap
//	                                         1000. Skips legal_hold rows.
//	GET  /v1/admin/storage/trash/stats     — trash size by age bucket and
//	                                         by org.
//	POST /v1/admin/storage/trash/purge     — hard-delete trashed files
//	                                         matching filters
//	                                         (orgId / olderThanDays /
//	                                         dryRun).
//	GET  /v1/admin/storage/orphans         — files in 'pending' for >N
//	                                         hours (default 24): never
//	                                         completed an upload, eat
//	                                         no real bytes but the rows
//	                                         pile up.
//	POST /v1/admin/storage/orphans/purge   — drop the matched orphans.
//	GET  /v1/admin/storage/backend         — bucket name + StatObject
//	                                         ping latency.
//
// Safety constraints (every state-changing handler)
// ------------------
//
//   - legal_hold = TRUE rows are NEVER purged. If the caller targets one
//     by id we return 409; for bulk operations we silently skip and
//     report the count back so the operator sees the discrepancy.
//   - Bulk endpoints cap at 1000 ids per request — keeps a hot loop on
//     a misconfigured client from holding a connection forever.
//   - Storage-object Remove() failures are logged into the response but
//     don't abort the DB delete. The next reconcile pass will surface
//     leftover keys; the priority is making the row disappear from the
//     admin's view.
//   - Every action writes a `super_admin.storage.*` audit row with the
//     ids it touched. The audit table is the unfalsifiable trail.
//   - Purge endpoints accept ?dryRun=true (or {dryRun:true} in the body)
//     and return the would-be impact without touching anything.
package platformstorage

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// bulkCap is the per-request limit on file-id arrays we accept. 1000
// matches the chunk size operators tend to paste from spreadsheet
// extracts and stays well under any pgx parameter limit.
const bulkCap = 1000

type Handler struct {
	DB    *pgxpool.Pool
	Store *storage.Client
}

func New(db *pgxpool.Pool, store *storage.Client) *Handler {
	return &Handler{DB: db, Store: store}
}

// -----------------------------------------------------------------------
// Overview
// -----------------------------------------------------------------------

type kv struct {
	Label string `json:"label"`
	Value int64  `json:"value"`
	// Bytes is set on size-flavored breakdowns so the UI can format
	// either count or bytes from the same shape. -1 means "not a byte
	// metric" so the renderer falls back to Value.
	Bytes int64 `json:"bytes,omitempty"`
}

type topFile struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Mime          string  `json:"mime"`
	Size          int64   `json:"size"`
	OrgID         string  `json:"orgId"`
	OrgName       string  `json:"orgName"`
	OwnerEmail    string  `json:"ownerEmail,omitempty"`
	Status        string  `json:"status"`
	ScanStatus    string  `json:"scanStatus"`
	LegalHold     bool    `json:"legalHold"`
	Trashed       bool    `json:"trashed"`
	Classification string `json:"classification"`
	CreatedAt     string  `json:"createdAt"`
}

type orgUsage struct {
	OrgID         string `json:"orgId"`
	OrgName       string `json:"orgName"`
	ActiveFiles   int64  `json:"activeFiles"`
	ActiveBytes   int64  `json:"activeBytes"`
	TrashedFiles  int64  `json:"trashedFiles"`
	TrashedBytes  int64  `json:"trashedBytes"`
	LegalHoldRows int64  `json:"legalHoldRows"`
}

// Overview returns a single-shot global snapshot. Designed for the
// /admin/storage landing page — every panel reads from this payload so
// the page renders in one round-trip.
//
// GET /v1/admin/storage/overview
func (h *Handler) Overview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := map[string]any{
		"generated": time.Now().UTC().Format(time.RFC3339),
		"bucket":    h.bucket(),
	}

	// Aggregate totals. COUNT(*) FILTER lets us compute every flavor in
	// one table scan instead of N queries.
	var (
		totalFiles, activeFiles, trashedFiles, pendingFiles int64
		infectedFiles, scanErrFiles, legalHold              int64
		activeBytes, trashedBytes                           int64
		distinctOrgs                                        int64
	)
	err := h.DB.QueryRow(ctx, `
		SELECT
		  COUNT(*)::bigint                                                       AS total,
		  COUNT(*) FILTER (WHERE trashed_at IS NULL AND status='active')::bigint AS active,
		  COUNT(*) FILTER (WHERE trashed_at IS NOT NULL)::bigint                 AS trashed,
		  COUNT(*) FILTER (WHERE status='pending')::bigint                       AS pending,
		  COUNT(*) FILTER (WHERE scan_status='infected')::bigint                 AS infected,
		  COUNT(*) FILTER (WHERE scan_status='error')::bigint                    AS scan_err,
		  COUNT(*) FILTER (WHERE legal_hold=TRUE)::bigint                        AS legal_hold,
		  COALESCE(SUM(size) FILTER (WHERE trashed_at IS NULL), 0)::bigint       AS active_bytes,
		  COALESCE(SUM(size) FILTER (WHERE trashed_at IS NOT NULL), 0)::bigint   AS trashed_bytes,
		  COUNT(DISTINCT org_id)::bigint                                         AS orgs
		  FROM files`).
		Scan(&totalFiles, &activeFiles, &trashedFiles, &pendingFiles,
			&infectedFiles, &scanErrFiles, &legalHold,
			&activeBytes, &trashedBytes, &distinctOrgs)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	out["totals"] = map[string]any{
		"files":         totalFiles,
		"activeFiles":   activeFiles,
		"trashedFiles":  trashedFiles,
		"pendingFiles":  pendingFiles,
		"infectedFiles": infectedFiles,
		"scanErrFiles":  scanErrFiles,
		"legalHold":     legalHold,
		"activeBytes":   activeBytes,
		"trashedBytes":  trashedBytes,
		"orgs":          distinctOrgs,
	}

	out["statusBreakdown"] = simpleKV(ctx, h.DB, `
		SELECT status, COUNT(*)::bigint
		  FROM files GROUP BY status ORDER BY 2 DESC`)
	out["scanBreakdown"] = simpleKV(ctx, h.DB, `
		SELECT scan_status, COUNT(*)::bigint
		  FROM files GROUP BY scan_status ORDER BY 2 DESC`)
	out["classificationBreakdown"] = simpleKV(ctx, h.DB, `
		SELECT COALESCE(classification,'internal'), COUNT(*)::bigint
		  FROM files
		 WHERE trashed_at IS NULL
		 GROUP BY 1 ORDER BY 2 DESC`)

	// Top MIMEs (active rows only) — by both file count AND total bytes,
	// because a workspace dominated by 50 huge MP4s looks very different
	// from one with 50,000 tiny PDFs.
	out["topMimes"] = sizedKV(ctx, h.DB, `
		SELECT mime, COUNT(*)::bigint, COALESCE(SUM(size),0)::bigint
		  FROM files
		 WHERE trashed_at IS NULL
		 GROUP BY mime
		 ORDER BY 3 DESC
		 LIMIT 15`)

	// Top extensions: derived from the lower-cased suffix of name.
	// Useful when the MIME is a generic application/octet-stream but the
	// extension still tells the truth (.bak, .log, .iso, etc).
	out["topExtensions"] = sizedKV(ctx, h.DB, `
		SELECT COALESCE(NULLIF(LOWER(SUBSTRING(name FROM '\.([^./\\]+)$')), ''), '(none)') AS ext,
		       COUNT(*)::bigint,
		       COALESCE(SUM(size),0)::bigint
		  FROM files
		 WHERE trashed_at IS NULL
		 GROUP BY ext
		 ORDER BY 3 DESC
		 LIMIT 15`)

	// Trash age histogram — how stale is the soft-deleted backlog.
	// Operators use this to decide whether to run a purge sweep.
	out["trashAge"] = trashAgeBuckets(ctx, h.DB)

	// Top orgs by active bytes. Joined to organizations so the UI can
	// render the workspace name and link straight to /admin/orgs/{id}.
	out["topOrgs"] = topOrgsByUsage(ctx, h.DB, 10)

	// Top files by size, capped to 25. We DON'T filter trashed: an
	// operator hunting cost wants to see the heaviest objects period,
	// and trashed-but-not-purged is the common smoking gun.
	out["topFiles"] = listTopFiles(ctx, h.DB, 25)

	// Backend ping. Best-effort; if the bucket is briefly unreachable we
	// return ok=false but still ship the rest of the snapshot.
	out["backend"] = h.backendStatus(ctx)

	writeJSON(w, 200, out)
}

// bucket returns the configured bucket name, or "" if no Store was
// attached (tests pass a nil Store).
func (h *Handler) bucket() string {
	if h.Store == nil {
		return ""
	}
	return h.Store.Bucket()
}

// backendStatus pings storage and returns shape:
//
//	{ ok: bool, bucket: string, latencyMs: int, error?: string }
//
// Used by both Overview and the dedicated /backend handler.
func (h *Handler) backendStatus(ctx context.Context) map[string]any {
	bucket := h.bucket()
	res := map[string]any{"bucket": bucket}
	if h.Store == nil {
		res["ok"] = false
		res["error"] = "storage client not configured"
		return res
	}
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	start := time.Now()
	err := h.Store.Ping(pingCtx)
	res["latencyMs"] = time.Since(start).Milliseconds()
	if err != nil {
		res["ok"] = false
		res["error"] = err.Error()
		return res
	}
	res["ok"] = true
	return res
}

// BackendHealth surfaces just the backend ping. Lighter weight than
// Overview for poll-style health monitors.
//
// GET /v1/admin/storage/backend
func (h *Handler) BackendHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, h.backendStatus(r.Context()))
}

// -----------------------------------------------------------------------
// Inventory (file browser)
// -----------------------------------------------------------------------

type inventoryRow struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Mime           string `json:"mime"`
	Size           int64  `json:"size"`
	Status         string `json:"status"`
	ScanStatus     string `json:"scanStatus"`
	Classification string `json:"classification"`
	LegalHold      bool   `json:"legalHold"`
	Trashed        bool   `json:"trashed"`
	StorageKey     string `json:"storageKey"`
	OrgID          string `json:"orgId"`
	OrgName        string `json:"orgName"`
	OwnerID        string `json:"ownerId"`
	OwnerEmail     string `json:"ownerEmail,omitempty"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
	TrashedAt      string `json:"trashedAt,omitempty"`
}

// Inventory is the paginated file browser. Uses keyset pagination on
// (created_at, id) — stable under inserts and avoids the OFFSET cliff
// at deep pages.
//
// GET /v1/admin/storage/inventory
//
// Query parameters:
//
//	q              - substring of name OR storage_key (ILIKE)
//	orgId          - exact uuid filter
//	ownerEmail     - exact email match (joined to users)
//	status         - exact files.status filter
//	scanStatus     - exact files.scan_status filter
//	classification - exact files.classification filter
//	mime           - exact files.mime filter
//	minSize        - bytes >= n
//	maxSize        - bytes <= n
//	includeTrashed - "true" to include soft-deleted rows
//	onlyTrashed    - "true" to ONLY show soft-deleted rows
//	legalHold      - "true" / "false" to filter on legal_hold
//	limit          - default 50, cap 200
//	cursor         - opaque "<rfc3339>|<uuid>" from the previous page
func (h *Handler) Inventory(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()

	limit := 50
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n > 200 {
				n = 200
			}
			limit = n
		}
	}

	var (
		conds []string
		args  []any
	)
	add := func(cond string, val any) {
		args = append(args, val)
		conds = append(conds, strings.ReplaceAll(cond, "$?", "$"+strconv.Itoa(len(args))))
	}

	if v := strings.TrimSpace(q.Get("q")); v != "" {
		// Single positional, two substitutions — bypass the `add`
		// helper which only handles one $? expansion per call.
		args = append(args, "%"+v+"%")
		ph := "$" + strconv.Itoa(len(args))
		conds = append(conds,
			"(f.name ILIKE "+ph+" OR f.storage_key ILIKE "+ph+")")
	}
	if v := strings.TrimSpace(q.Get("orgId")); v != "" {
		add("f.org_id = $?::uuid", v)
	}
	if v := strings.TrimSpace(q.Get("ownerEmail")); v != "" {
		add("EXISTS (SELECT 1 FROM users u WHERE u.id=f.owner_id AND u.email=$?)", v)
	}
	if v := strings.TrimSpace(q.Get("status")); v != "" {
		add("f.status = $?", v)
	}
	if v := strings.TrimSpace(q.Get("scanStatus")); v != "" {
		add("f.scan_status = $?", v)
	}
	if v := strings.TrimSpace(q.Get("classification")); v != "" {
		add("COALESCE(f.classification,'internal') = $?", v)
	}
	if v := strings.TrimSpace(q.Get("mime")); v != "" {
		add("f.mime = $?", v)
	}
	if v := q.Get("minSize"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			add("f.size >= $?", n)
		}
	}
	if v := q.Get("maxSize"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			add("f.size <= $?", n)
		}
	}
	switch {
	case strings.EqualFold(q.Get("onlyTrashed"), "true"):
		conds = append(conds, "f.trashed_at IS NOT NULL")
	case strings.EqualFold(q.Get("includeTrashed"), "true"):
		// no-op (allow both)
	default:
		conds = append(conds, "f.trashed_at IS NULL")
	}
	if v := q.Get("legalHold"); v != "" {
		switch strings.ToLower(v) {
		case "true":
			conds = append(conds, "f.legal_hold = TRUE")
		case "false":
			conds = append(conds, "f.legal_hold = FALSE")
		}
	}

	// Cursor: "<created_at_rfc3339>|<file_id>". Returns rows strictly
	// older than (created_at, id) — sort is created_at DESC, id DESC.
	if cur := q.Get("cursor"); cur != "" {
		if at, id, ok := splitCursor(cur); ok {
			args = append(args, at)
			ph1 := "$" + strconv.Itoa(len(args))
			args = append(args, id)
			ph2 := "$" + strconv.Itoa(len(args))
			conds = append(conds, "(f.created_at, f.id) < ("+ph1+", "+ph2+"::uuid)")
		}
	}

	if len(conds) == 0 {
		conds = []string{"true"}
	}
	args = append(args, limit+1) // +1 so we can compute hasMore
	limitPH := "$" + strconv.Itoa(len(args))

	sql := `
		SELECT f.id, f.name, f.mime, f.size,
		       f.status, f.scan_status,
		       COALESCE(f.classification,'internal'),
		       f.legal_hold,
		       f.trashed_at IS NOT NULL,
		       f.storage_key,
		       f.org_id, COALESCE(o.name,''),
		       f.owner_id, COALESCE(u.email,''),
		       f.created_at, f.updated_at, f.trashed_at
		  FROM files f
		  LEFT JOIN organizations o ON o.id = f.org_id
		  LEFT JOIN users u ON u.id = f.owner_id
		 WHERE ` + strings.Join(conds, " AND ") + `
		 ORDER BY f.created_at DESC, f.id DESC
		 LIMIT ` + limitPH

	rows, err := h.DB.Query(ctx, sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	out := []inventoryRow{}
	for rows.Next() {
		var (
			row                 inventoryRow
			created, updated    time.Time
			trashedAt           *time.Time
		)
		if err := rows.Scan(&row.ID, &row.Name, &row.Mime, &row.Size,
			&row.Status, &row.ScanStatus, &row.Classification,
			&row.LegalHold, &row.Trashed, &row.StorageKey,
			&row.OrgID, &row.OrgName, &row.OwnerID, &row.OwnerEmail,
			&created, &updated, &trashedAt); err != nil {
			continue
		}
		row.CreatedAt = created.UTC().Format(time.RFC3339)
		row.UpdatedAt = updated.UTC().Format(time.RFC3339)
		if trashedAt != nil {
			row.TrashedAt = trashedAt.UTC().Format(time.RFC3339)
		}
		out = append(out, row)
	}

	resp := map[string]any{"files": out}
	if len(out) > limit {
		// Trim the lookahead row and emit a cursor.
		last := out[limit-1]
		out = out[:limit]
		resp["files"] = out
		resp["nextCursor"] = last.CreatedAt + "|" + last.ID
	}
	writeJSON(w, 200, resp)
}

// FileDetail returns a single file with org + owner + scan history.
//
// GET /v1/admin/storage/files/{id}
func (h *Handler) FileDetail(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	row, err := h.fetchOne(r.Context(), id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "not_found", "file not found")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	// Recent scan attempts for diagnosis. Cap at 20 — older history is
	// noise.
	type scanAttempt struct {
		ID         string  `json:"id"`
		Status     string  `json:"status"`
		Verdict    *string `json:"verdict,omitempty"`
		Engine     *string `json:"engine,omitempty"`
		Signature  *string `json:"signature,omitempty"`
		LastError  *string `json:"lastError,omitempty"`
		Attempts   int     `json:"attempts"`
		CreatedAt  string  `json:"createdAt"`
		StartedAt  *string `json:"startedAt,omitempty"`
		FinishedAt *string `json:"finishedAt,omitempty"`
	}
	scans := []scanAttempt{}
	srows, err := h.DB.Query(r.Context(), `
		SELECT id, status, verdict, engine, signature, last_error,
		       attempts, created_at, started_at, finished_at
		  FROM scan_jobs
		 WHERE file_id=$1
		 ORDER BY created_at DESC
		 LIMIT 20`, id)
	if err == nil {
		defer srows.Close()
		for srows.Next() {
			var s scanAttempt
			var created time.Time
			var started, finished *time.Time
			if err := srows.Scan(&s.ID, &s.Status, &s.Verdict, &s.Engine,
				&s.Signature, &s.LastError, &s.Attempts,
				&created, &started, &finished); err == nil {
				s.CreatedAt = created.UTC().Format(time.RFC3339)
				if started != nil {
					t := started.UTC().Format(time.RFC3339)
					s.StartedAt = &t
				}
				if finished != nil {
					t := finished.UTC().Format(time.RFC3339)
					s.FinishedAt = &t
				}
				scans = append(scans, s)
			}
		}
	}

	// Bucket-side reality check: stat the object so the operator can
	// confirm the row's size matches what's actually in storage. Best
	// effort — a missing object isn't an error here, it IS the signal
	// (orphaned DB row, useful to know).
	objInfo := map[string]any{}
	if h.Store != nil {
		statCtx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if info, err := h.Store.StatObject(statCtx, row.StorageKey); err == nil {
			objInfo["exists"] = true
			objInfo["size"] = info.Size
			objInfo["etag"] = info.ETag
			objInfo["lastModified"] = info.LastModified.UTC().Format(time.RFC3339)
		} else {
			objInfo["exists"] = false
			objInfo["error"] = err.Error()
		}
	}

	writeJSON(w, 200, map[string]any{
		"file":   row,
		"scans":  scans,
		"object": objInfo,
	})
}

// fetchOne resolves a single file row, including org/owner names. Used
// by FileDetail and validated by PurgeFile before deletion.
func (h *Handler) fetchOne(ctx context.Context, id string) (*inventoryRow, error) {
	var (
		row              inventoryRow
		created, updated time.Time
		trashedAt        *time.Time
	)
	err := h.DB.QueryRow(ctx, `
		SELECT f.id, f.name, f.mime, f.size,
		       f.status, f.scan_status,
		       COALESCE(f.classification,'internal'),
		       f.legal_hold,
		       f.trashed_at IS NOT NULL,
		       f.storage_key,
		       f.org_id, COALESCE(o.name,''),
		       f.owner_id, COALESCE(u.email,''),
		       f.created_at, f.updated_at, f.trashed_at
		  FROM files f
		  LEFT JOIN organizations o ON o.id = f.org_id
		  LEFT JOIN users u ON u.id = f.owner_id
		 WHERE f.id = $1::uuid`, id).
		Scan(&row.ID, &row.Name, &row.Mime, &row.Size,
			&row.Status, &row.ScanStatus, &row.Classification,
			&row.LegalHold, &row.Trashed, &row.StorageKey,
			&row.OrgID, &row.OrgName, &row.OwnerID, &row.OwnerEmail,
			&created, &updated, &trashedAt)
	if err != nil {
		return nil, err
	}
	row.CreatedAt = created.UTC().Format(time.RFC3339)
	row.UpdatedAt = updated.UTC().Format(time.RFC3339)
	if trashedAt != nil {
		row.TrashedAt = trashedAt.UTC().Format(time.RFC3339)
	}
	return &row, nil
}

// -----------------------------------------------------------------------
// Hard delete (single)
// -----------------------------------------------------------------------

// PurgeFile hard-deletes a single file. Refuses legal_hold rows (409).
// Removes the storage object best-effort (failures are logged in the
// response but the DB row still goes).
//
// POST /v1/admin/storage/files/{id}/purge?dryRun=true
func (h *Handler) PurgeFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	dryRun := strings.EqualFold(r.URL.Query().Get("dryRun"), "true")

	row, err := h.fetchOne(r.Context(), id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "not_found", "file not found")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if row.LegalHold {
		writeErr(w, 409, "legal_hold",
			"file is on legal hold and cannot be purged")
		return
	}

	if dryRun {
		writeJSON(w, 200, map[string]any{
			"dryRun":      true,
			"wouldPurge":  1,
			"wouldFreeBytes": row.Size,
			"file":        row,
		})
		return
	}

	// DB row first. If we delete the object successfully but then the
	// DB delete fails (rare, but possible on connection blips) we end
	// up with an inconsistent state where the row references a missing
	// blob. Doing the DB first means a storage-side failure leaves the
	// row gone (clean) and the blob orphaned (recoverable by a janitor).
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM files WHERE id=$1::uuid AND legal_hold = FALSE`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "file vanished before purge")
		return
	}

	storageErr := ""
	if h.Store != nil {
		rmCtx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		if err := h.Store.Remove(rmCtx, row.StorageKey); err != nil {
			storageErr = err.Error()
		}
		cancel()
	}

	audit.LogHTTP(r, h.DB, "super_admin.storage.file.purge", "file", id,
		map[string]any{
			"orgId":      row.OrgID,
			"size":       row.Size,
			"mime":       row.Mime,
			"storageKey": row.StorageKey,
			"storageErr": storageErr,
		})
	writeJSON(w, 200, map[string]any{
		"ok":         true,
		"freedBytes": row.Size,
		"storageErr": storageErr,
	})
}

// -----------------------------------------------------------------------
// Hard delete (bulk by id list)
// -----------------------------------------------------------------------

type bulkPurgeReq struct {
	IDs    []string `json:"ids"`
	DryRun bool     `json:"dryRun"`
}

type bulkPurgeResp struct {
	DryRun       bool     `json:"dryRun"`
	Requested    int      `json:"requested"`
	Purged       int      `json:"purged"`
	SkippedHold  int      `json:"skippedLegalHold"`
	NotFound     int      `json:"notFound"`
	FreedBytes   int64    `json:"freedBytes"`
	StorageErrs  int      `json:"storageErrs"`
	ProtectedIDs []string `json:"protectedIds,omitempty"`
}

// BulkPurge hard-deletes by file id list.
//
//   - Refuses to act on legal_hold rows (counted under skippedLegalHold,
//     ids returned in protectedIds).
//   - Caps the request at bulkCap (1000).
//   - Storage failures are counted but don't abort the loop.
//
// POST /v1/admin/storage/files/bulk-purge
func (h *Handler) BulkPurge(w http.ResponseWriter, r *http.Request) {
	var req bulkPurgeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if len(req.IDs) == 0 {
		writeErr(w, 400, "missing_ids", "ids is required")
		return
	}
	if len(req.IDs) > bulkCap {
		writeErr(w, 400, "too_many_ids",
			"cap is "+strconv.Itoa(bulkCap)+" ids per request")
		return
	}

	// Fetch the candidates in one query so the legal-hold split + size
	// roll-up don't fan out to N round-trips.
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, storage_key, size, legal_hold, org_id
		  FROM files
		 WHERE id = ANY($1::uuid[])`, req.IDs)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	type candidate struct {
		ID, Key, OrgID string
		Size           int64
		Hold           bool
	}
	cands := []candidate{}
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.ID, &c.Key, &c.Size, &c.Hold, &c.OrgID); err == nil {
			cands = append(cands, c)
		}
	}
	rows.Close()

	resp := bulkPurgeResp{
		DryRun:    req.DryRun,
		Requested: len(req.IDs),
	}
	deletable := []candidate{}
	for _, c := range cands {
		if c.Hold {
			resp.SkippedHold++
			resp.ProtectedIDs = append(resp.ProtectedIDs, c.ID)
			continue
		}
		deletable = append(deletable, c)
	}
	resp.NotFound = resp.Requested - len(cands)

	if req.DryRun {
		for _, c := range deletable {
			resp.FreedBytes += c.Size
		}
		resp.Purged = len(deletable)
		writeJSON(w, 200, resp)
		return
	}

	if len(deletable) > 0 {
		ids := make([]string, 0, len(deletable))
		for _, c := range deletable {
			ids = append(ids, c.ID)
		}
		// Single DELETE for the row drops; storage objects loop after.
		// AND legal_hold = FALSE is belt-and-braces — we already split
		// above, but a concurrent legal_hold flip during the call must
		// still protect.
		_, err := h.DB.Exec(r.Context(),
			`DELETE FROM files WHERE id = ANY($1::uuid[]) AND legal_hold = FALSE`, ids)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		for _, c := range deletable {
			resp.Purged++
			resp.FreedBytes += c.Size
			if h.Store != nil {
				rmCtx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
				if err := h.Store.Remove(rmCtx, c.Key); err != nil {
					resp.StorageErrs++
				}
				cancel()
			}
		}
	}

	audit.LogHTTP(r, h.DB, "super_admin.storage.bulk_purge", "files", "",
		map[string]any{
			"requested":   resp.Requested,
			"purged":      resp.Purged,
			"skippedHold": resp.SkippedHold,
			"notFound":    resp.NotFound,
			"freedBytes":  resp.FreedBytes,
			"storageErrs": resp.StorageErrs,
		})
	writeJSON(w, 200, resp)
}

// -----------------------------------------------------------------------
// Trash
// -----------------------------------------------------------------------

type trashAgeBucket struct {
	Bucket string `json:"bucket"` // "<7d", "7-30d", "30-90d", "90-365d", "365d+"
	Files  int64  `json:"files"`
	Bytes  int64  `json:"bytes"`
}

func trashAgeBuckets(ctx context.Context, db *pgxpool.Pool) []trashAgeBucket {
	rows, err := db.Query(ctx, `
		WITH agg AS (
		  SELECT
		    CASE
		      WHEN trashed_at > now() - interval '7 days'   THEN '<7d'
		      WHEN trashed_at > now() - interval '30 days'  THEN '7-30d'
		      WHEN trashed_at > now() - interval '90 days'  THEN '30-90d'
		      WHEN trashed_at > now() - interval '365 days' THEN '90-365d'
		      ELSE '365d+'
		    END AS bucket,
		    COUNT(*)::bigint  AS files,
		    COALESCE(SUM(size),0)::bigint AS bytes
		  FROM files
		  WHERE trashed_at IS NOT NULL
		  GROUP BY 1
		)
		SELECT bucket, files, bytes FROM agg
		 ORDER BY array_position(ARRAY['<7d','7-30d','30-90d','90-365d','365d+'], bucket)`)
	if err != nil {
		return []trashAgeBucket{}
	}
	defer rows.Close()
	out := []trashAgeBucket{}
	for rows.Next() {
		var b trashAgeBucket
		if err := rows.Scan(&b.Bucket, &b.Files, &b.Bytes); err == nil {
			out = append(out, b)
		}
	}
	return out
}

// TrashStats summarises the soft-deleted backlog.
//
// GET /v1/admin/storage/trash/stats
func (h *Handler) TrashStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := map[string]any{}

	var totalFiles, totalBytes, holdRows int64
	err := h.DB.QueryRow(ctx, `
		SELECT COUNT(*)::bigint,
		       COALESCE(SUM(size),0)::bigint,
		       COUNT(*) FILTER (WHERE legal_hold=TRUE)::bigint
		  FROM files WHERE trashed_at IS NOT NULL`).
		Scan(&totalFiles, &totalBytes, &holdRows)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	out["totals"] = map[string]any{
		"files":           totalFiles,
		"bytes":           totalBytes,
		"legalHoldFiles":  holdRows,
		"purgeableFiles":  totalFiles - holdRows,
	}
	out["ageBuckets"] = trashAgeBuckets(ctx, h.DB)

	// Per-org trash leaderboard — who has the biggest cleanup
	// opportunity.
	type orgTrash struct {
		OrgID   string `json:"orgId"`
		OrgName string `json:"orgName"`
		Files   int64  `json:"files"`
		Bytes   int64  `json:"bytes"`
	}
	per := []orgTrash{}
	if rows, err := h.DB.Query(ctx, `
		SELECT f.org_id, COALESCE(o.name,''),
		       COUNT(*)::bigint,
		       COALESCE(SUM(f.size),0)::bigint
		  FROM files f
		  LEFT JOIN organizations o ON o.id = f.org_id
		 WHERE f.trashed_at IS NOT NULL
		 GROUP BY f.org_id, o.name
		 ORDER BY 4 DESC
		 LIMIT 25`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var t orgTrash
			if err := rows.Scan(&t.OrgID, &t.OrgName, &t.Files, &t.Bytes); err == nil {
				per = append(per, t)
			}
		}
	}
	out["topOrgs"] = per
	writeJSON(w, 200, out)
}

type trashPurgeReq struct {
	OrgID          string `json:"orgId,omitempty"`
	OlderThanDays  int    `json:"olderThanDays,omitempty"`
	DryRun         bool   `json:"dryRun"`
}

// PurgeTrash hard-deletes trashed rows matching the filter.
//
//   - At least one of orgId / olderThanDays must be supplied — we refuse
//     to nuke EVERY trashed file in one call. The operator who actually
//     wants that runs it twice with explicit filters.
//   - legal_hold rows are silently skipped (counted under skippedHold).
//   - Cap the deletion to bulkCap rows per request, ordered oldest-first;
//     the caller can re-invoke until the count is zero.
//
// POST /v1/admin/storage/trash/purge
func (h *Handler) PurgeTrash(w http.ResponseWriter, r *http.Request) {
	var req trashPurgeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if strings.TrimSpace(req.OrgID) == "" && req.OlderThanDays <= 0 {
		writeErr(w, 400, "filter_required",
			"supply orgId and/or olderThanDays — refusing to purge all trash in one call")
		return
	}

	conds := []string{"trashed_at IS NOT NULL", "legal_hold = FALSE"}
	args := []any{}
	if req.OrgID != "" {
		args = append(args, req.OrgID)
		conds = append(conds, "org_id = $"+strconv.Itoa(len(args))+"::uuid")
	}
	if req.OlderThanDays > 0 {
		args = append(args, req.OlderThanDays)
		conds = append(conds, "trashed_at < now() - ($"+strconv.Itoa(len(args))+" || ' days')::interval")
	}
	args = append(args, bulkCap)
	limitPH := "$" + strconv.Itoa(len(args))

	// Fetch the batch we're about to act on so we know storage_keys for
	// the object-delete pass and can return a precise count.
	sql := `
		SELECT id, storage_key, size
		  FROM files
		 WHERE ` + strings.Join(conds, " AND ") + `
		 ORDER BY trashed_at ASC
		 LIMIT ` + limitPH
	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	type t struct {
		ID, Key string
		Size    int64
	}
	batch := []t{}
	for rows.Next() {
		var v t
		if err := rows.Scan(&v.ID, &v.Key, &v.Size); err == nil {
			batch = append(batch, v)
		}
	}
	rows.Close()

	resp := map[string]any{
		"dryRun":      req.DryRun,
		"matched":     len(batch),
		"capped":      len(batch) == bulkCap,
		"freedBytes":  int64(0),
		"purged":      0,
		"storageErrs": 0,
	}
	var freed int64
	for _, b := range batch {
		freed += b.Size
	}
	resp["freedBytes"] = freed

	if req.DryRun || len(batch) == 0 {
		writeJSON(w, 200, resp)
		return
	}

	ids := make([]string, 0, len(batch))
	for _, b := range batch {
		ids = append(ids, b.ID)
	}
	// Re-check legal_hold defensively (concurrent flip could land
	// between our SELECT and DELETE).
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM files
		   WHERE id = ANY($1::uuid[])
		     AND trashed_at IS NOT NULL
		     AND legal_hold = FALSE`, ids)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	resp["purged"] = int(tag.RowsAffected())

	storageErrs := 0
	if h.Store != nil {
		for _, b := range batch {
			rmCtx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			if err := h.Store.Remove(rmCtx, b.Key); err != nil {
				storageErrs++
			}
			cancel()
		}
	}
	resp["storageErrs"] = storageErrs

	audit.LogHTTP(r, h.DB, "super_admin.storage.trash.purge", "files", "",
		map[string]any{
			"orgId":         req.OrgID,
			"olderThanDays": req.OlderThanDays,
			"matched":       len(batch),
			"purged":        tag.RowsAffected(),
			"freedBytes":    freed,
			"storageErrs":   storageErrs,
		})
	writeJSON(w, 200, resp)
}

// -----------------------------------------------------------------------
// Orphans
// -----------------------------------------------------------------------

// Orphans surfaces files that have been status='pending' for too long.
// Pending = the row was created at presign time but the upload-complete
// callback never fired. They consume a row but no actual storage bytes
// (the object never uploaded), yet they pile up and confuse usage
// counts.
//
// GET /v1/admin/storage/orphans?olderThanHours=24
func (h *Handler) Orphans(w http.ResponseWriter, r *http.Request) {
	hours := 24
	if v := r.URL.Query().Get("olderThanHours"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			hours = n
		}
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT f.id, f.name, f.mime, f.size,
		       f.status, f.scan_status,
		       COALESCE(f.classification,'internal'),
		       f.legal_hold,
		       f.trashed_at IS NOT NULL,
		       f.storage_key,
		       f.org_id, COALESCE(o.name,''),
		       f.owner_id, COALESCE(u.email,''),
		       f.created_at, f.updated_at, f.trashed_at
		  FROM files f
		  LEFT JOIN organizations o ON o.id = f.org_id
		  LEFT JOIN users u ON u.id = f.owner_id
		 WHERE f.status='pending'
		   AND f.created_at < now() - ($1 || ' hours')::interval
		 ORDER BY f.created_at ASC
		 LIMIT 500`, hours)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []inventoryRow{}
	for rows.Next() {
		var (
			row              inventoryRow
			created, updated time.Time
			trashedAt        *time.Time
		)
		if err := rows.Scan(&row.ID, &row.Name, &row.Mime, &row.Size,
			&row.Status, &row.ScanStatus, &row.Classification,
			&row.LegalHold, &row.Trashed, &row.StorageKey,
			&row.OrgID, &row.OrgName, &row.OwnerID, &row.OwnerEmail,
			&created, &updated, &trashedAt); err != nil {
			continue
		}
		row.CreatedAt = created.UTC().Format(time.RFC3339)
		row.UpdatedAt = updated.UTC().Format(time.RFC3339)
		if trashedAt != nil {
			row.TrashedAt = trashedAt.UTC().Format(time.RFC3339)
		}
		out = append(out, row)
	}
	writeJSON(w, 200, map[string]any{
		"olderThanHours": hours,
		"orphans":        out,
	})
}

type orphanPurgeReq struct {
	OlderThanHours int  `json:"olderThanHours"`
	DryRun         bool `json:"dryRun"`
}

// PurgeOrphans drops pending-too-long rows. Capped at bulkCap; legal_hold
// is honoured (these almost never collide in practice but the safety
// guarantee is universal across this package).
//
// POST /v1/admin/storage/orphans/purge
func (h *Handler) PurgeOrphans(w http.ResponseWriter, r *http.Request) {
	var req orphanPurgeReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.OlderThanHours <= 0 {
		req.OlderThanHours = 24
	}

	rows, err := h.DB.Query(r.Context(), `
		SELECT id, storage_key
		  FROM files
		 WHERE status='pending'
		   AND legal_hold=FALSE
		   AND created_at < now() - ($1 || ' hours')::interval
		 ORDER BY created_at ASC
		 LIMIT $2`, req.OlderThanHours, bulkCap)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	type t struct{ ID, Key string }
	batch := []t{}
	for rows.Next() {
		var v t
		if err := rows.Scan(&v.ID, &v.Key); err == nil {
			batch = append(batch, v)
		}
	}
	rows.Close()

	resp := map[string]any{
		"dryRun":      req.DryRun,
		"matched":     len(batch),
		"capped":      len(batch) == bulkCap,
		"purged":      0,
		"storageErrs": 0,
	}
	if req.DryRun || len(batch) == 0 {
		writeJSON(w, 200, resp)
		return
	}

	ids := make([]string, 0, len(batch))
	for _, b := range batch {
		ids = append(ids, b.ID)
	}
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM files
		   WHERE id = ANY($1::uuid[])
		     AND status='pending'
		     AND legal_hold = FALSE`, ids)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	resp["purged"] = int(tag.RowsAffected())

	storageErrs := 0
	if h.Store != nil {
		// Pending objects often DON'T exist (presign issued, upload
		// never happened). Remove() is best-effort and a 404-style
		// error is the expected case here, but we still surface the
		// count for diagnostics.
		for _, b := range batch {
			rmCtx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			if err := h.Store.Remove(rmCtx, b.Key); err != nil {
				storageErrs++
			}
			cancel()
		}
	}
	resp["storageErrs"] = storageErrs

	audit.LogHTTP(r, h.DB, "super_admin.storage.orphans.purge", "files", "",
		map[string]any{
			"olderThanHours": req.OlderThanHours,
			"matched":        len(batch),
			"purged":         tag.RowsAffected(),
			"storageErrs":    storageErrs,
		})
	writeJSON(w, 200, resp)
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

// simpleKV runs a (label, count) two-column query and returns []kv.
func simpleKV(ctx context.Context, db *pgxpool.Pool, sql string, args ...any) []kv {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return []kv{}
	}
	defer rows.Close()
	out := []kv{}
	for rows.Next() {
		var k kv
		if err := rows.Scan(&k.Label, &k.Value); err == nil {
			out = append(out, k)
		}
	}
	return out
}

// sizedKV runs a (label, count, bytes) three-column query.
func sizedKV(ctx context.Context, db *pgxpool.Pool, sql string, args ...any) []kv {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return []kv{}
	}
	defer rows.Close()
	out := []kv{}
	for rows.Next() {
		var k kv
		if err := rows.Scan(&k.Label, &k.Value, &k.Bytes); err == nil {
			out = append(out, k)
		}
	}
	return out
}

// topOrgsByUsage ranks orgs by active storage. Joined to organizations
// for the display name.
func topOrgsByUsage(ctx context.Context, db *pgxpool.Pool, limit int) []orgUsage {
	rows, err := db.Query(ctx, `
		SELECT f.org_id,
		       COALESCE(o.name,''),
		       COUNT(*) FILTER (WHERE f.trashed_at IS NULL)::bigint,
		       COALESCE(SUM(f.size) FILTER (WHERE f.trashed_at IS NULL), 0)::bigint,
		       COUNT(*) FILTER (WHERE f.trashed_at IS NOT NULL)::bigint,
		       COALESCE(SUM(f.size) FILTER (WHERE f.trashed_at IS NOT NULL), 0)::bigint,
		       COUNT(*) FILTER (WHERE f.legal_hold=TRUE)::bigint
		  FROM files f
		  LEFT JOIN organizations o ON o.id = f.org_id
		 GROUP BY f.org_id, o.name
		 ORDER BY 4 DESC
		 LIMIT $1`, limit)
	if err != nil {
		return []orgUsage{}
	}
	defer rows.Close()
	out := []orgUsage{}
	for rows.Next() {
		var u orgUsage
		if err := rows.Scan(&u.OrgID, &u.OrgName,
			&u.ActiveFiles, &u.ActiveBytes,
			&u.TrashedFiles, &u.TrashedBytes,
			&u.LegalHoldRows); err == nil {
			out = append(out, u)
		}
	}
	return out
}

func listTopFiles(ctx context.Context, db *pgxpool.Pool, limit int) []topFile {
	rows, err := db.Query(ctx, `
		SELECT f.id, f.name, f.mime, f.size,
		       f.org_id, COALESCE(o.name,''),
		       COALESCE(u.email,''),
		       f.status, f.scan_status, f.legal_hold,
		       f.trashed_at IS NOT NULL,
		       COALESCE(f.classification,'internal'),
		       f.created_at
		  FROM files f
		  LEFT JOIN organizations o ON o.id = f.org_id
		  LEFT JOIN users u ON u.id = f.owner_id
		 ORDER BY f.size DESC
		 LIMIT $1`, limit)
	if err != nil {
		return []topFile{}
	}
	defer rows.Close()
	out := []topFile{}
	for rows.Next() {
		var t topFile
		var created time.Time
		if err := rows.Scan(&t.ID, &t.Name, &t.Mime, &t.Size,
			&t.OrgID, &t.OrgName, &t.OwnerEmail,
			&t.Status, &t.ScanStatus, &t.LegalHold,
			&t.Trashed, &t.Classification, &created); err == nil {
			t.CreatedAt = created.UTC().Format(time.RFC3339)
			out = append(out, t)
		}
	}
	return out
}

// splitCursor parses an "<rfc3339>|<uuid>" cursor. Returns (at, id, ok).
func splitCursor(cur string) (time.Time, string, bool) {
	i := strings.IndexByte(cur, '|')
	if i <= 0 || i == len(cur)-1 {
		return time.Time{}, "", false
	}
	t, err := time.Parse(time.RFC3339, cur[:i])
	if err != nil {
		return time.Time{}, "", false
	}
	return t, cur[i+1:], true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]string{"code": slug, "message": msg},
	})
}
