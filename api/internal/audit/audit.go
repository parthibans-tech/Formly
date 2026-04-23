// Package audit is the immutable activity log used by every sensitive
// action in the API (auth, files, shares, generation, team changes, etc.).
//
// All other packages call audit.Log() to record events; the /v1/audit
// endpoint streams them back to the settings/audit UI.
package audit

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/docforge/api/internal/auth"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

// Event is the domain record. `Meta` is any JSON-serialisable structure
// (usually a map of extra context like filename, share role, IP, etc.).
type Event struct {
	OrgID        string
	ActorID      string
	ActorEmail   string
	Action       string
	ResourceType string
	ResourceID   string
	IP           string
	UserAgent    string
	Meta         map[string]any
}

// Log inserts a single audit row. Never blocks the caller on errors — audit
// failures log to stderr but never bubble up to the user (recording failures
// shouldn't break the business action).
func Log(ctx context.Context, db *pgxpool.Pool, e Event) {
	if e.Action == "" {
		return
	}
	if e.Meta == nil {
		e.Meta = map[string]any{}
	}
	metaJSON, _ := json.Marshal(e.Meta)

	// Normalise IP (strip port if present).
	ip := e.IP
	if i := strings.LastIndex(ip, ":"); i > 0 && !strings.Contains(ip, "]") {
		ip = ip[:i]
	}
	if ip == "" {
		ip = "0.0.0.0"
	}

	// Use a short-lived background-parent context so we can record late events
	// even when the caller's context is cancelled (e.g. after the response
	// flush on a terminal action).
	_, _ = db.Exec(ctx, `
		INSERT INTO audit_log
		  (org_id, actor_id, actor_email, action, resource_type, resource_id,
		   ip_addr, user_agent, meta)
		VALUES
		  (NULLIF($1,'')::uuid, NULLIF($2,'')::uuid, NULLIF($3,''), $4,
		   NULLIF($5,''), NULLIF($6,''), $7::inet, NULLIF($8,''), $9::jsonb)
	`, e.OrgID, e.ActorID, e.ActorEmail, e.Action, e.ResourceType,
		e.ResourceID, ip, e.UserAgent, string(metaJSON))
}

// FromRequest pulls the authenticated user and request metadata and returns a
// pre-filled Event. Callers then only set Action / ResourceType / ResourceID
// / Meta.
func FromRequest(r *http.Request) Event {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var (
		uid, oid, email string
	)
	if c != nil {
		uid, oid, email = c.UserID, c.OrgID, c.Email
	}
	return Event{
		OrgID:      oid,
		ActorID:    uid,
		ActorEmail: email,
		IP:         clientIP(r),
		UserAgent:  r.UserAgent(),
	}
}

// LogHTTP is a shortcut for the common case of logging from inside an HTTP
// handler.
func LogHTTP(r *http.Request, db *pgxpool.Pool, action, resType, resID string, meta map[string]any) {
	e := FromRequest(r)
	e.Action = action
	e.ResourceType = resType
	e.ResourceID = resID
	e.Meta = meta
	Log(r.Context(), db, e)
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	return r.RemoteAddr
}

/* ------------------------- HTTP: list ------------------------- */

type listItem struct {
	ID           string         `json:"id"`
	ActorID      string         `json:"actorId,omitempty"`
	ActorEmail   string         `json:"actorEmail,omitempty"`
	Action       string         `json:"action"`
	ResourceType string         `json:"resourceType,omitempty"`
	ResourceID   string         `json:"resourceId,omitempty"`
	IP           string         `json:"ip,omitempty"`
	UserAgent    string         `json:"userAgent,omitempty"`
	Meta         map[string]any `json:"meta,omitempty"`
	CreatedAt    string         `json:"createdAt"`
}

// List admin-only: returns recent audit events for the caller's org,
// optionally filtered by action, actor, or resource.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	if !c.IsAdmin() {
		writeErr(w, 403, "admin_only", "audit log is admin-only")
		return
	}

	q := r.URL.Query()
	action := q.Get("action")
	actor := q.Get("actor")
	resource := q.Get("resource")
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	sql := `
		SELECT id, COALESCE(actor_id::text,''), COALESCE(actor_email,''),
		       action, COALESCE(resource_type,''), COALESCE(resource_id,''),
		       COALESCE(host(ip_addr),''), COALESCE(user_agent,''),
		       meta, created_at
		  FROM audit_log
		 WHERE org_id=$1`
	args := []any{c.OrgID}
	i := 2
	if action != "" {
		sql += " AND action=$" + strconv.Itoa(i)
		args = append(args, action)
		i++
	}
	if actor != "" {
		sql += " AND (actor_id::text=$" + strconv.Itoa(i) + " OR actor_email=$" + strconv.Itoa(i) + ")"
		args = append(args, actor)
		i++
	}
	if resource != "" {
		sql += " AND resource_id=$" + strconv.Itoa(i)
		args = append(args, resource)
		i++
	}
	sql += " ORDER BY created_at DESC LIMIT $" + strconv.Itoa(i)
	args = append(args, limit)

	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	out := []listItem{}
	for rows.Next() {
		var it listItem
		var metaRaw []byte
		var created time.Time
		if err := rows.Scan(
			&it.ID, &it.ActorID, &it.ActorEmail, &it.Action,
			&it.ResourceType, &it.ResourceID, &it.IP, &it.UserAgent,
			&metaRaw, &created,
		); err != nil {
			writeErr(w, 500, "scan", err.Error())
			return
		}
		if len(metaRaw) > 0 {
			_ = json.Unmarshal(metaRaw, &it.Meta)
		}
		it.CreatedAt = created.Format(time.RFC3339)
		out = append(out, it)
	}
	writeJSON(w, 200, map[string]any{"events": out})
}

/* ------------------------- Router wiring ------------------------- */

// Mount attaches the admin-only audit list endpoint.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/v1/audit", h.List)
}

/* ------------------------- tiny helpers ------------------------- */

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
