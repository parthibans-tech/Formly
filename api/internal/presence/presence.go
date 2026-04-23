// Package presence implements a lightweight "who's here" heartbeat plus
// optimistic-locking support for template saves.
//
// Clients call GET /v1/templates/{id}/presence every 15 seconds. Each call
// bumps the caller's last_seen_at and returns everyone whose last_seen_at
// is within 60 seconds. No WebSockets required; polling is fine for the
// scale we care about and survives reconnects for free.
package presence

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

const staleAfter = 60 * time.Second

type peerDTO struct {
	UserID     string `json:"userId"`
	Email      string `json:"email"`
	Name       string `json:"name"`
	LastSeenAt string `json:"lastSeenAt"`
	IsSelf     bool   `json:"isSelf"`
}

// Heartbeat upserts the caller's presence row and returns the list of active
// peers on the same template. Version is also returned so clients can detect
// remote saves while they were away.
func (h *Handler) Heartbeat(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tplID := chi.URLParam(r, "id")

	// Ownership check.
	var orgOwner string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT org_id FROM templates WHERE id=$1`, tplID).Scan(&orgOwner); err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	if orgOwner != c.OrgID {
		writeErr(w, 404, "not_found", "template not found")
		return
	}

	// Upsert heartbeat.
	_, _ = h.DB.Exec(r.Context(), `
		INSERT INTO template_presence (template_id, user_id, last_seen_at)
		VALUES ($1,$2, now())
		ON CONFLICT (template_id, user_id)
		  DO UPDATE SET last_seen_at = now()`, tplID, c.UserID)

	// Fetch current version.
	var version int
	_ = h.DB.QueryRow(r.Context(),
		`SELECT version FROM templates WHERE id=$1`, tplID).Scan(&version)

	// Fetch peers seen within the last `staleAfter`. Exclude nothing; caller
	// is returned too so the UI can show "you + N others".
	rows, err := h.DB.Query(r.Context(), `
		SELECT u.id, COALESCE(u.email,''), COALESCE(u.name,''), p.last_seen_at
		  FROM template_presence p
		  JOIN users u ON u.id = p.user_id
		 WHERE p.template_id = $1
		   AND p.last_seen_at > now() - ($2::int || ' seconds')::interval
		 ORDER BY p.last_seen_at DESC`, tplID, int(staleAfter.Seconds()))
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	peers := []peerDTO{}
	for rows.Next() {
		var uid, email, name string
		var seen time.Time
		if err := rows.Scan(&uid, &email, &name, &seen); err != nil {
			continue
		}
		peers = append(peers, peerDTO{
			UserID:     uid,
			Email:      email,
			Name:       name,
			LastSeenAt: seen.Format(time.RFC3339),
			IsSelf:     uid == c.UserID,
		})
	}
	writeJSON(w, 200, map[string]any{
		"peers":   peers,
		"version": version,
	})
}

// Leave removes the caller's presence row. Called on page unload / designer
// close so "Alice is editing" clears promptly instead of waiting for TTL.
func (h *Handler) Leave(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tplID := chi.URLParam(r, "id")
	_, _ = h.DB.Exec(r.Context(),
		`DELETE FROM template_presence WHERE template_id=$1 AND user_id=$2`,
		tplID, c.UserID)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
