package mockdata

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct{ DB *pgxpool.Pool }

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

type setDTO struct {
	ID        string                 `json:"id"`
	Name      string                 `json:"name"`
	Data      map[string]interface{} `json:"data"`
	UpdatedAt time.Time              `json:"updatedAt"`
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tid := chi.URLParam(r, "id")
	rows, err := h.DB.Query(r.Context(),
		`SELECT id, name, data_json, updated_at FROM mock_data_sets
		 WHERE template_id=$1 AND org_id=$2 ORDER BY updated_at DESC`, tid, c.OrgID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []setDTO{}
	for rows.Next() {
		var s setDTO
		var raw []byte
		if err := rows.Scan(&s.ID, &s.Name, &raw, &s.UpdatedAt); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		_ = json.Unmarshal(raw, &s.Data)
		out = append(out, s)
	}
	writeJSON(w, 200, map[string]any{"sets": out})
}

type saveReq struct {
	Name string                 `json:"name"`
	Data map[string]interface{} `json:"data"`
}

func (h *Handler) Save(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tid := chi.URLParam(r, "id")
	var req saveReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Name == "" {
		writeErr(w, 400, "missing_name", "name required")
		return
	}
	var exists bool
	_ = h.DB.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM templates WHERE id=$1 AND org_id=$2)`, tid, c.OrgID,
	).Scan(&exists)
	if !exists {
		writeErr(w, 404, "not_found", "template not found")
		return
	}

	dataBytes, _ := json.Marshal(req.Data)
	var id string
	err := h.DB.QueryRow(r.Context(),
		`INSERT INTO mock_data_sets (template_id, org_id, name, data_json)
		 VALUES ($1,$2,$3,$4)
		 ON CONFLICT (template_id, name) DO UPDATE
		   SET data_json=EXCLUDED.data_json, updated_at=now()
		 RETURNING id`,
		tid, c.OrgID, req.Name, dataBytes,
	).Scan(&id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"id": id, "name": req.Name})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	sid := chi.URLParam(r, "setId")
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM mock_data_sets WHERE id=$1 AND org_id=$2`, sid, c.OrgID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "set not found")
		return
	}
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
