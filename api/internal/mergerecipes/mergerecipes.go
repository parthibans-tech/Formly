// Package mergerecipes implements saved, callable PDF stitching
// configurations — the merge analog of templates.
//
// The product story
//
// A recipe is defined once in the workspace (drag-and-drop builder:
// pick files / templates, set per-component pages and data namespaces)
// and then invoked from any external app via API key (or internally
// via JWT) by POSTing one big payload to /v1/merge-recipes/{id}/run.
// The recipe handler renders each template component with its own
// slice of `data`, reads each static file's bytes, and stitches the
// stack with internal/pdfmerge. The output lands as a new file in the
// caller's drive (or a presigned-download response when the integrator
// flips `download:true`).
//
// "Different data per file" — the data_key namespacing rule
//
// External callers send one envelope, e.g.
//
//	{
//	  "data": {
//	    "candidate": { "name": "Alice", "email": "..." },
//	    "company":   { "name": "Acme",  "address": "..." }
//	  }
//	}
//
// Each template component declares a `data_key`; the runner passes
// `data[component.DataKey]` to that component's render. So the
// candidate-NDA template reads Alice's name from `candidate.name`,
// the company-cover template reads Acme's name from `company.name`,
// and the field-name collision (`name`) doesn't matter — they never
// see the same map.
//
// An empty data_key means "the whole `data` object", which is the
// natural shape for one-template recipes that don't need namespacing.
//
// Why share /v1/merge-jobs status polling
//
// Async runs use the same merge_jobs table the ad-hoc merge endpoint
// already populates (with a nullable recipe_id added in migration
// 039). The browser's existing job-poll component therefore works
// unchanged — call POST → take the {jobId} → GET /v1/merge-jobs/{id}
// until status="done", then navigate to file_id.

package mergerecipes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/generate"
	"github.com/docforge/api/internal/pdfmerge"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Handler binds the recipe endpoints to their dependencies. Queue may
// be nil — in that case async runs are refused with 503 (matching the
// pdfmerge handler's policy).
type Handler struct {
	DB       *pgxpool.Pool
	Storage  *storage.Client
	Runner   *generate.Runner
	PDFMerge *pdfmerge.Handler
	Queue    *asynq.Client
}

func New(db *pgxpool.Pool, st *storage.Client, runner *generate.Runner, pm *pdfmerge.Handler, q *asynq.Client) *Handler {
	return &Handler{DB: db, Storage: st, Runner: runner, PDFMerge: pm, Queue: q}
}

// =====================================================================
//   DTOs (request / response)
// =====================================================================

// componentDTO is the wire shape for a recipe component. The same shape
// is used in list/get responses and in create/update requests — so the
// frontend builder can round-trip a component without translating.
type componentDTO struct {
	ID         string `json:"id,omitempty"`
	Position   int    `json:"position"`
	Kind       string `json:"kind"` // "file" | "template"
	FileID     string `json:"fileId,omitempty"`
	TemplateID string `json:"templateId,omitempty"`
	Pages      string `json:"pages,omitempty"`
	DataKey    string `json:"dataKey"`
	Required   bool   `json:"required"`
	Flatten    bool   `json:"flatten"`
	Label      string `json:"label,omitempty"`
	// Read-side enrichment so the builder can render names without an
	// extra round-trip per row. Never read from on writes.
	SourceName string `json:"sourceName,omitempty"`
}

type recipeDTO struct {
	ID                 string         `json:"id"`
	Name               string         `json:"name"`
	Description        string         `json:"description"`
	OutputNameTemplate string         `json:"outputNameTemplate"`
	Config             map[string]any `json:"config"`
	LastRunAt          *string        `json:"lastRunAt,omitempty"`
	CreatedAt          string         `json:"createdAt"`
	UpdatedAt          string         `json:"updatedAt"`
	Components         []componentDTO `json:"components"`
}

type createRecipeReq struct {
	Name               string         `json:"name"`
	Description        string         `json:"description,omitempty"`
	OutputNameTemplate string         `json:"outputNameTemplate,omitempty"`
	Config             map[string]any `json:"config,omitempty"`
	Components         []componentDTO `json:"components,omitempty"`
}

type updateRecipeReq struct {
	Name               *string        `json:"name,omitempty"`
	Description        *string        `json:"description,omitempty"`
	OutputNameTemplate *string        `json:"outputNameTemplate,omitempty"`
	Config             map[string]any `json:"config,omitempty"`
	Components         *[]componentDTO `json:"components,omitempty"`
}

// =====================================================================
//   List / Get
// =====================================================================

// List is GET /v1/merge-recipes — newest-first. We DO NOT load
// components in the list view; that would N+1 the index page. The
// builder fetches one recipe-at-a-time via Get().
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	rows, err := h.DB.Query(r.Context(),
		`SELECT id, name, description, output_name_template, config_json,
		        last_run_at, created_at, updated_at,
		        (SELECT COUNT(*) FROM merge_recipe_components c WHERE c.recipe_id = r.id) AS component_count
		   FROM merge_recipes r
		  WHERE org_id = $1
		  ORDER BY created_at DESC`,
		c.OrgID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	type listItem struct {
		recipeDTO
		ComponentCount int `json:"componentCount"`
	}
	out := []listItem{}
	for rows.Next() {
		var item listItem
		var cfgRaw []byte
		var lastRun *time.Time
		var created, updated time.Time
		if err := rows.Scan(
			&item.ID, &item.Name, &item.Description, &item.OutputNameTemplate,
			&cfgRaw, &lastRun, &created, &updated, &item.ComponentCount,
		); err != nil {
			continue
		}
		_ = json.Unmarshal(cfgRaw, &item.Config)
		if lastRun != nil {
			s := lastRun.UTC().Format(time.RFC3339Nano)
			item.LastRunAt = &s
		}
		item.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		item.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
		item.Components = nil // explicit — list view never carries components
		out = append(out, item)
	}
	writeJSON(w, 200, map[string]any{"recipes": out})
}

// Get is GET /v1/merge-recipes/{id} — full recipe + components.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	id := chi.URLParam(r, "id")
	dto, err := h.loadRecipe(r.Context(), c.OrgID, id)
	if err != nil {
		writeErr(w, 404, "not_found", "recipe not found")
		return
	}
	writeJSON(w, 200, dto)
}

func (h *Handler) loadRecipe(ctx context.Context, orgID, id string) (*recipeDTO, error) {
	dto := &recipeDTO{Components: []componentDTO{}}
	var cfgRaw []byte
	var lastRun *time.Time
	var created, updated time.Time
	err := h.DB.QueryRow(ctx,
		`SELECT id, name, description, output_name_template, config_json,
		        last_run_at, created_at, updated_at
		   FROM merge_recipes
		  WHERE id = $1 AND org_id = $2`,
		id, orgID,
	).Scan(&dto.ID, &dto.Name, &dto.Description, &dto.OutputNameTemplate,
		&cfgRaw, &lastRun, &created, &updated)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(cfgRaw, &dto.Config)
	if lastRun != nil {
		s := lastRun.UTC().Format(time.RFC3339Nano)
		dto.LastRunAt = &s
	}
	dto.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	dto.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)

	// Components — left-join file/template names so the builder UI can
	// render the row without a second round-trip per component. We use
	// LEFT JOIN so a component whose source got deleted still renders
	// (with sourceName empty) — the builder marks those red.
	rows, err := h.DB.Query(ctx,
		`SELECT c.id, c.position, c.kind, COALESCE(c.file_id::text,''),
		        COALESCE(c.template_id::text,''),
		        c.pages, c.data_key, c.required, c.flatten, COALESCE(c.label,''),
		        COALESCE(f.name, t.name, '')
		   FROM merge_recipe_components c
		   LEFT JOIN files     f ON f.id = c.file_id
		   LEFT JOIN templates t ON t.id = c.template_id
		  WHERE c.recipe_id = $1
		  ORDER BY c.position`,
		dto.ID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var cmp componentDTO
		if err := rows.Scan(&cmp.ID, &cmp.Position, &cmp.Kind,
			&cmp.FileID, &cmp.TemplateID, &cmp.Pages, &cmp.DataKey,
			&cmp.Required, &cmp.Flatten, &cmp.Label, &cmp.SourceName); err != nil {
			continue
		}
		dto.Components = append(dto.Components, cmp)
	}
	return dto, nil
}

// =====================================================================
//   Create / Update / Delete
// =====================================================================

// Create is POST /v1/merge-recipes.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	var req createRecipeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeErr(w, 400, "bad_request", "name is required")
		return
	}
	cfg := req.Config
	if cfg == nil {
		cfg = map[string]any{}
	}
	cfgBytes, _ := json.Marshal(cfg)

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(r.Context())

	var id string
	if err := tx.QueryRow(r.Context(),
		`INSERT INTO merge_recipes (org_id, owner_id, name, description, output_name_template, config_json)
		 VALUES ($1,$2,$3,$4,$5,$6)
		 RETURNING id`,
		c.OrgID, c.UserID, name, strings.TrimSpace(req.Description),
		strings.TrimSpace(req.OutputNameTemplate), cfgBytes,
	).Scan(&id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := h.replaceComponents(r.Context(), tx, c.OrgID, id, req.Components); err != nil {
		writeUserOrErr(w, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	dto, err := h.loadRecipe(r.Context(), c.OrgID, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 201, dto)
}

// Update is PATCH /v1/merge-recipes/{id}. When `components` is set the
// component list is REPLACED — the builder always sends the full list,
// which keeps the position-shuffling logic in one place.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	id := chi.URLParam(r, "id")

	var req updateRecipeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(r.Context())

	// Verify ownership first so a not-our-org id 404s before we run any
	// updates.
	var existingOrg string
	if err := tx.QueryRow(r.Context(),
		`SELECT org_id::text FROM merge_recipes WHERE id=$1`, id,
	).Scan(&existingOrg); err != nil {
		writeErr(w, 404, "not_found", "recipe not found")
		return
	}
	if existingOrg != c.OrgID {
		writeErr(w, 404, "not_found", "recipe not found")
		return
	}

	sets := []string{"updated_at = now()"}
	args := []any{}
	add := func(col string, val any) {
		args = append(args, val)
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if n == "" {
			writeErr(w, 400, "bad_request", "name cannot be empty")
			return
		}
		add("name", n)
	}
	if req.Description != nil {
		add("description", strings.TrimSpace(*req.Description))
	}
	if req.OutputNameTemplate != nil {
		add("output_name_template", strings.TrimSpace(*req.OutputNameTemplate))
	}
	if req.Config != nil {
		b, _ := json.Marshal(req.Config)
		add("config_json", b)
	}
	args = append(args, id)
	if _, err := tx.Exec(r.Context(),
		fmt.Sprintf(`UPDATE merge_recipes SET %s WHERE id = $%d`, strings.Join(sets, ", "), len(args)),
		args...,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	if req.Components != nil {
		if err := h.replaceComponents(r.Context(), tx, c.OrgID, id, *req.Components); err != nil {
			writeUserOrErr(w, err)
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	dto, err := h.loadRecipe(r.Context(), c.OrgID, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, dto)
}

// Delete is DELETE /v1/merge-recipes/{id}. Components cascade via FK.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM merge_recipes WHERE id=$1 AND org_id=$2`,
		id, c.OrgID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "recipe not found")
		return
	}
	w.WriteHeader(204)
}

// replaceComponents nukes the existing components and inserts the given
// list at positions 0..N-1. Validates per-component shape (kind ↔
// fileId/templateId) and that referenced sources belong to the same
// org.
func (h *Handler) replaceComponents(ctx context.Context, tx pgx.Tx, orgID, recipeID string, comps []componentDTO) error {
	if _, err := tx.Exec(ctx, `DELETE FROM merge_recipe_components WHERE recipe_id=$1`, recipeID); err != nil {
		return err
	}
	for i, cmp := range comps {
		kind := strings.ToLower(strings.TrimSpace(cmp.Kind))
		if kind != "file" && kind != "template" {
			return &userError{status: 400, code: "bad_request",
				msg: fmt.Sprintf("components[%d].kind must be 'file' or 'template'", i)}
		}
		var fileID, templateID *string
		if kind == "file" {
			if cmp.FileID == "" {
				return &userError{status: 400, code: "bad_request",
					msg: fmt.Sprintf("components[%d].fileId is required for file kind", i)}
			}
			// ACL: source file must belong to the same org. We don't
			// require edit — running the recipe just reads bytes.
			var ok bool
			if err := tx.QueryRow(ctx,
				`SELECT EXISTS(SELECT 1 FROM files WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL)`,
				cmp.FileID, orgID,
			).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return &userError{status: 400, code: "bad_source",
					msg: fmt.Sprintf("components[%d]: file not found in this workspace", i)}
			}
			fileID = &cmp.FileID
		} else {
			if cmp.TemplateID == "" {
				return &userError{status: 400, code: "bad_request",
					msg: fmt.Sprintf("components[%d].templateId is required for template kind", i)}
			}
			var ok bool
			if err := tx.QueryRow(ctx,
				`SELECT EXISTS(SELECT 1 FROM templates WHERE id=$1 AND org_id=$2)`,
				cmp.TemplateID, orgID,
			).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return &userError{status: 400, code: "bad_source",
					msg: fmt.Sprintf("components[%d]: template not found in this workspace", i)}
			}
			templateID = &cmp.TemplateID
		}
		pages := strings.TrimSpace(cmp.Pages)
		if pages == "" {
			pages = "all"
		}
		var labelArg any
		if cmp.Label != "" {
			labelArg = cmp.Label
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO merge_recipe_components
			   (recipe_id, position, kind, file_id, template_id, pages, data_key, required, flatten, label)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			recipeID, i, kind, fileID, templateID, pages,
			cmp.DataKey, cmp.Required, cmp.Flatten, labelArg,
		); err != nil {
			return err
		}
	}
	return nil
}

// =====================================================================
//   Error plumbing (mirrors pdfmerge for consistency)
// =====================================================================

type userError struct {
	status int
	code   string
	msg    string
}

func (e *userError) Error() string { return e.msg }

func writeUserOrErr(w http.ResponseWriter, err error) {
	var ue *userError
	if errors.As(err, &ue) {
		writeErr(w, ue.status, ue.code, ue.msg)
		return
	}
	writeErr(w, 500, "internal", err.Error())
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]any{"code": slug, "message": msg},
	})
}
