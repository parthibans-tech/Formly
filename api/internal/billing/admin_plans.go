package billing

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/docforge/api/internal/audit"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

// adminPlanRow extends planRow with the `active` flag and `description`
// that the public catalog hides. Super-admins see and edit the full row.
type adminPlanRow struct {
	planRow
	Active      bool   `json:"active"`
	Description string `json:"description"`
}

// AdminListPlans returns every plan (active or not, every currency) for
// the platform-side catalog editor. Super-admin only — wired via
// requireSuperAdmin in main.go.
func (h *Handler) AdminListPlans(w http.ResponseWriter, r *http.Request) {
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, name, COALESCE(description, ''), tier, currency, interval,
		       amount_cents, max_users, max_storage_bytes, features,
		       sort_order, active
		  FROM plans
		 ORDER BY sort_order, currency, id`)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	out := []adminPlanRow{}
	for rows.Next() {
		var (
			p           adminPlanRow
			featuresRaw []byte
		)
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.Tier, &p.Currency,
			&p.Interval, &p.AmountCents, &p.MaxUsers, &p.MaxStorageBytes,
			&featuresRaw, &p.SortOrder, &p.Active); err != nil {
			continue
		}
		_ = json.Unmarshal(featuresRaw, &p.Features)
		if p.Features == nil {
			p.Features = map[string]any{}
		}
		out = append(out, p)
	}
	writeJSON(w, 200, map[string]any{"plans": out})
}

type planUpsertReq struct {
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	Description     string         `json:"description"`
	Tier            string         `json:"tier"`
	Currency        string         `json:"currency"`
	Interval        string         `json:"interval"`
	AmountCents     *int64         `json:"amountCents"`
	MaxUsers        *int           `json:"maxUsers"`
	MaxStorageBytes *int64         `json:"maxStorageBytes"`
	Features        map[string]any `json:"features"`
	SortOrder       *int           `json:"sortOrder"`
	Active          *bool          `json:"active"`
}

func (r *planUpsertReq) normalize() {
	r.ID = strings.TrimSpace(r.ID)
	r.Name = strings.TrimSpace(r.Name)
	r.Description = strings.TrimSpace(r.Description)
	r.Tier = strings.ToLower(strings.TrimSpace(r.Tier))
	r.Currency = strings.ToUpper(strings.TrimSpace(r.Currency))
	r.Interval = strings.ToLower(strings.TrimSpace(r.Interval))
	if r.Features == nil {
		r.Features = map[string]any{}
	}
}

// validate returns "" when the upsert is acceptable; tier/interval/currency
// are checked against the same constants the rest of the billing package
// uses so a mistype here can't poison the catalog.
func (r *planUpsertReq) validate() string {
	if r.ID == "" {
		return "id is required"
	}
	if len(r.ID) > 60 {
		return "id must be 60 characters or fewer"
	}
	if r.Name == "" {
		return "name is required"
	}
	switch r.Tier {
	case "free", "pro", "enterprise":
	default:
		return "tier must be free, pro, or enterprise"
	}
	switch r.Currency {
	case "INR", "USD":
	default:
		return "currency must be INR or USD"
	}
	switch r.Interval {
	case "month", "year", "none":
	default:
		return "interval must be month, year, or none"
	}
	return ""
}

// AdminUpsertPlan handles both POST (insert) and PUT (update by URL id).
// We use ON CONFLICT so the same handler covers both cases — simplifies
// the client which doesn't need to know whether a plan id already exists.
func (h *Handler) AdminUpsertPlan(w http.ResponseWriter, r *http.Request) {
	var in planUpsertReq
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	// PUT /v1/admin/plans/{id} — the URL id wins so admins can't rename
	// a plan by editing the body field.
	if urlID := chi.URLParam(r, "id"); urlID != "" {
		in.ID = urlID
	}
	in.normalize()
	if msg := in.validate(); msg != "" {
		writeErr(w, 400, "invalid_field", msg)
		return
	}
	featuresJSON, err := json.Marshal(in.Features)
	if err != nil {
		writeErr(w, 400, "invalid_features", err.Error())
		return
	}
	sortOrder := 100
	if in.SortOrder != nil {
		sortOrder = *in.SortOrder
	}
	active := true
	if in.Active != nil {
		active = *in.Active
	}

	if _, err := h.DB.Exec(r.Context(), `
		INSERT INTO plans (
			id, name, description, tier, currency, interval, amount_cents,
			max_users, max_storage_bytes, features, sort_order, active
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		ON CONFLICT (id) DO UPDATE SET
			name              = EXCLUDED.name,
			description       = EXCLUDED.description,
			tier              = EXCLUDED.tier,
			currency          = EXCLUDED.currency,
			interval          = EXCLUDED.interval,
			amount_cents      = EXCLUDED.amount_cents,
			max_users         = EXCLUDED.max_users,
			max_storage_bytes = EXCLUDED.max_storage_bytes,
			features          = EXCLUDED.features,
			sort_order        = EXCLUDED.sort_order,
			active            = EXCLUDED.active`,
		in.ID, in.Name, in.Description, in.Tier, in.Currency, in.Interval,
		in.AmountCents, in.MaxUsers, in.MaxStorageBytes, featuresJSON,
		sortOrder, active,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	audit.LogHTTP(r, h.DB, "super_admin.plan_upserted", "plan", in.ID,
		map[string]any{
			"tier":     in.Tier,
			"currency": in.Currency,
			"active":   active,
		})

	writeJSON(w, 200, map[string]any{"ok": true, "id": in.ID})
}

// AdminDeletePlan flips active=false rather than dropping the row — there
// may be subscriptions / invoices referencing it. The storefront filters
// inactive plans out via `WHERE active = true` in ListPlans.
func (h *Handler) AdminDeletePlan(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeErr(w, 400, "missing_id", "plan id is required")
		return
	}
	tag, err := h.DB.Exec(r.Context(),
		`UPDATE plans SET active = false WHERE id = $1`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "plan not found")
		return
	}
	audit.LogHTTP(r, h.DB, "super_admin.plan_archived", "plan", id, nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// AdminGetPlan is handy for the editor's "load form" path — saves the
// client a filter pass over the full list when it's editing one row.
func (h *Handler) AdminGetPlan(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeErr(w, 400, "missing_id", "plan id is required")
		return
	}
	var (
		p           adminPlanRow
		featuresRaw []byte
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT id, name, COALESCE(description, ''), tier, currency, interval,
		       amount_cents, max_users, max_storage_bytes, features,
		       sort_order, active
		  FROM plans WHERE id = $1`, id,
	).Scan(&p.ID, &p.Name, &p.Description, &p.Tier, &p.Currency, &p.Interval,
		&p.AmountCents, &p.MaxUsers, &p.MaxStorageBytes, &featuresRaw,
		&p.SortOrder, &p.Active)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, 404, "not_found", "plan not found")
		return
	}
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	_ = json.Unmarshal(featuresRaw, &p.Features)
	if p.Features == nil {
		p.Features = map[string]any{}
	}
	writeJSON(w, 200, p)
}
