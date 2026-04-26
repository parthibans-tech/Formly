// HTTP surface for the OCR profile picker + admin CRUD.
//
// # Routing
//
//	GET    /v1/ocr/profiles            — anyone authenticated; returns
//	                                      built-ins + the caller's org's
//	                                      authored profiles. The picker
//	                                      reads from this.
//	POST   /v1/ocr/profiles            — org admin (creates an org-scoped
//	                                      profile) or super admin (may
//	                                      create a built-in by setting
//	                                      builtin=true on the body).
//	GET    /v1/ocr/profiles/{id}       — same visibility rules as List.
//	PUT    /v1/ocr/profiles/{id}       — org admin can edit own org's
//	                                      rows; super admin can also
//	                                      edit built-ins.
//	DELETE /v1/ocr/profiles/{id}       — same gating as PUT. The
//	                                      `generic` built-in is undeletable
//	                                      because the runtime falls back
//	                                      to it for unknown slugs.
//
// # Validation
//
// Slugs must match `^[a-z0-9][a-z0-9-]*$` so they round-trip through the
// localStorage cache key + URL params without escaping. Each extractor
// regex is compiled at write time — failing to compile rejects the
// request rather than letting the bad pattern reach `/extract-text`
// where it would silently disable extraction. PSM is bounded to
// [-1, 13] (tesseract's documented range, with -1 = inherit).
//
// # Why no caching of the read endpoints
//
// The picker reloads on every designer mount and the response is small
// (low-double-digit rows even for the largest org). A 5-minute Cache-
// Control would save us nothing measurable while making "I just edited
// a profile, why isn't it showing up?" the most common bug report.
package ocrprofiles

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// slugPattern matches the subset of strings safe to use as URL params,
// localStorage keys, and SQL identifiers. Lowercase ASCII + digits +
// dashes; must start with an alphanumeric so `--foo` (which some shells
// treat as a flag) is rejected.
var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// Handler binds the CRUD endpoints to the DB pool. Stateless across
// requests; safe to share.
type Handler struct {
	DB       *pgxpool.Pool
	Registry *DBRegistry
}

// NewHandler constructs the production HTTP handler. The Registry is
// the same DBRegistry the docchat package consumes for read-time
// profile lookups — sharing it means the static fallback toggles in
// lockstep across both surfaces.
func NewHandler(db *pgxpool.Pool) *Handler {
	return &Handler{DB: db, Registry: NewDBRegistry(db)}
}

// Mount wires the routes under the parent (already-authenticated)
// router. The handler enforces role checks per route — there's no
// "requires admin" middleware on the subtree because the GET endpoints
// are open to every authenticated user.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/v1/ocr/profiles", h.List)
	r.Get("/v1/ocr/profiles/{id}", h.Get)
	r.Post("/v1/ocr/profiles", h.Create)
	r.Put("/v1/ocr/profiles/{id}", h.Update)
	r.Delete("/v1/ocr/profiles/{id}", h.Delete)
}

/* --------------------------------- DTOs --------------------------------- */

// profileDTO is the wire shape for read + write. Mirrors Profile minus
// the lazy-compile internals. We use a separate struct (rather than
// reusing Profile) so the JSON tags stay decoupled from the storage
// shape — e.g. on responses we always include `id` while on requests
// we ignore it (the URL param is the source of truth on PUT).
type profileDTO struct {
	ID            string            `json:"id,omitempty"`
	Slug          string            `json:"slug"`
	Name          string            `json:"name"`
	Description   string            `json:"description"`
	Icon          string            `json:"icon"`
	Lang          string            `json:"lang,omitempty"`
	PSM           int               `json:"psm"`
	Preprocess    *bool             `json:"preprocess,omitempty"`
	Fields        []string          `json:"fields"`
	Extractors    map[string]string `json:"extractors"`
	LLMPrompt     string            `json:"llmPrompt"`
	Builtin       bool              `json:"builtin"`
	OrgScoped     bool              `json:"orgScoped"`
	CreatedAt     time.Time         `json:"createdAt,omitempty"`
	UpdatedAt     time.Time         `json:"updatedAt,omitempty"`
}

func toDTO(p Profile, createdAt, updatedAt time.Time) profileDTO {
	return profileDTO{
		ID:          p.ID,
		Slug:        p.Slug,
		Name:        p.Name,
		Description: p.Description,
		Icon:        p.Icon,
		Lang:        p.Lang,
		PSM:         p.PSM,
		Preprocess:  p.Preprocess,
		Fields:      orEmpty(p.Fields),
		Extractors:  orEmptyMap(p.Extractors),
		LLMPrompt:   p.LLMPromptText,
		Builtin:     p.Builtin,
		OrgScoped:   p.OrgID != "",
		CreatedAt:   createdAt,
		UpdatedAt:   updatedAt,
	}
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func orEmptyMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

/* ------------------------------ Read paths ------------------------------ */

// List returns built-ins + the caller's org-authored profiles. Open to
// every authenticated user — picker UI on every designer surface needs
// this.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}

	rows, err := h.DB.Query(r.Context(), `
		SELECT id, COALESCE(org_id::text, ''), slug, name, description, icon,
		       lang, psm, preprocess, fields, extractors, llm_prompt, is_builtin,
		       created_at, updated_at
		  FROM ocr_profiles
		 WHERE org_id IS NULL OR org_id = $1::uuid
		 ORDER BY is_builtin DESC, name ASC
	`, nullableUUID(c.OrgID))
	if err != nil {
		// Table not yet migrated? Fall back to the static set so the
		// picker still works. We deliberately don't log this as a
		// warning — a fresh dev box hits this path on day one.
		writeJSON(w, 200, map[string]any{"profiles": staticDTOs()})
		return
	}
	defer rows.Close()

	out := make([]profileDTO, 0, 8)
	for rows.Next() {
		dto, err := scanDTO(rows)
		if err != nil {
			continue
		}
		out = append(out, dto)
	}
	if len(out) == 0 {
		out = staticDTOs()
	}
	writeJSON(w, 200, map[string]any{"profiles": out})
}

// Get returns one profile by id. Visibility: built-ins or own org's.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	id := chi.URLParam(r, "id")

	row := h.DB.QueryRow(r.Context(), `
		SELECT id, COALESCE(org_id::text, ''), slug, name, description, icon,
		       lang, psm, preprocess, fields, extractors, llm_prompt, is_builtin,
		       created_at, updated_at
		  FROM ocr_profiles
		 WHERE id = $1
		   AND (org_id IS NULL OR org_id = $2::uuid)
	`, id, nullableUUID(c.OrgID))
	dto, err := scanDTO(row)
	if err != nil {
		writeErr(w, 404, "not_found", "profile not found")
		return
	}
	writeJSON(w, 200, dto)
}

// scanDTO covers the standard SELECT projection used in List/Get/
// post-mutation re-reads. Returns the DTO ready for JSON encoding.
func scanDTO(r rowScanner) (profileDTO, error) {
	var (
		dto            profileDTO
		orgID          string
		preprocess     *bool
		fieldsJSON     []byte
		extractorsJSON []byte
		createdAt      time.Time
		updatedAt      time.Time
	)
	if err := r.Scan(
		&dto.ID, &orgID, &dto.Slug, &dto.Name, &dto.Description, &dto.Icon,
		&dto.Lang, &dto.PSM, &preprocess, &fieldsJSON, &extractorsJSON,
		&dto.LLMPrompt, &dto.Builtin, &createdAt, &updatedAt,
	); err != nil {
		return profileDTO{}, err
	}
	dto.Preprocess = preprocess
	dto.OrgScoped = orgID != ""
	dto.CreatedAt = createdAt
	dto.UpdatedAt = updatedAt
	if len(fieldsJSON) > 0 {
		_ = json.Unmarshal(fieldsJSON, &dto.Fields)
	}
	if dto.Fields == nil {
		dto.Fields = []string{}
	}
	if len(extractorsJSON) > 0 {
		_ = json.Unmarshal(extractorsJSON, &dto.Extractors)
	}
	if dto.Extractors == nil {
		dto.Extractors = map[string]string{}
	}
	return dto, nil
}

// staticDTOs renders the hardcoded fallback as wire DTOs so the picker
// keeps working when the migration hasn't run.
func staticDTOs() []profileDTO {
	src := staticRegistry.List(nil, "")
	out := make([]profileDTO, 0, len(src))
	for _, p := range src {
		out = append(out, toDTO(p, time.Time{}, time.Time{}))
	}
	return out
}

/* ------------------------------ Write paths ----------------------------- */

// Create inserts a new profile. Two flavours, gated by role:
//
//   - Org admins (IsAdmin) create org-scoped profiles for their own
//     org. The body's `builtin` flag is forced to false.
//   - Super admins (IsSuperAdmin) may additionally set `builtin=true`
//     to create a platform-wide profile (org_id NULL).
//
// Anyone else gets 403. The slug is validated for uniqueness in the
// appropriate scope; collisions return 409.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	if !c.IsAdmin() {
		writeErr(w, 403, "forbidden", "admin role required")
		return
	}

	var body profileDTO
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}

	// Decide whether this is an org-scoped or platform-built-in row.
	// A non-super admin asking for builtin=true is a 403 (rather than
	// a silent downgrade) so the UI can detect "you don't have rights
	// for this checkbox" without ambiguity.
	wantBuiltin := body.Builtin
	if wantBuiltin && !c.IsSuperAdmin() {
		writeErr(w, 403, "forbidden", "super-admin required to create built-in profiles")
		return
	}

	if err := validateBody(body); err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}

	var ownerOrg any = c.OrgID
	if wantBuiltin {
		ownerOrg = nil // built-ins live with org_id NULL
	}

	row := h.DB.QueryRow(r.Context(), `
		INSERT INTO ocr_profiles
		    (org_id, slug, name, description, icon, lang, psm, preprocess,
		     fields, extractors, llm_prompt, is_builtin, created_by)
		VALUES
		    ($1::uuid, $2, $3, $4, $5, $6, $7, $8,
		     $9::jsonb, $10::jsonb, $11, $12, $13::uuid)
		RETURNING id, COALESCE(org_id::text, ''), slug, name, description, icon,
		          lang, psm, preprocess, fields, extractors, llm_prompt, is_builtin,
		          created_at, updated_at
	`,
		ownerOrg, body.Slug, body.Name, body.Description, defaultIcon(body.Icon),
		body.Lang, body.PSM, body.Preprocess,
		mustJSON(orEmpty(body.Fields)), mustJSON(orEmptyMap(body.Extractors)),
		body.LLMPrompt, wantBuiltin, c.UserID,
	)
	dto, err := scanDTO(row)
	if err != nil {
		if isUniqueViolation(err) {
			writeErr(w, 409, "slug_conflict", "a profile with this slug already exists")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 201, dto)
}

// Update edits an existing profile. Gating mirrors Create: org admins
// can only touch their own org's rows; super admins can additionally
// touch built-ins. The slug + builtin flag are immutable post-create
// (changing slug would break clients caching the previous one in
// localStorage; flipping builtin would orphan or hijack rows).
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	if !c.IsAdmin() {
		writeErr(w, 403, "forbidden", "admin role required")
		return
	}
	id := chi.URLParam(r, "id")

	// Resolve the existing row to figure out which gate applies.
	var existingOrgID string
	var isBuiltin bool
	if err := h.DB.QueryRow(r.Context(),
		`SELECT COALESCE(org_id::text, ''), is_builtin FROM ocr_profiles WHERE id=$1`,
		id,
	).Scan(&existingOrgID, &isBuiltin); err != nil {
		writeErr(w, 404, "not_found", "profile not found")
		return
	}
	if isBuiltin && !c.IsSuperAdmin() {
		writeErr(w, 403, "forbidden", "super-admin required to edit built-in profiles")
		return
	}
	if !isBuiltin && existingOrgID != c.OrgID {
		// Org admin trying to touch another org's row. Mask as 404 so
		// we don't leak which IDs exist.
		writeErr(w, 404, "not_found", "profile not found")
		return
	}

	var body profileDTO
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}
	// Slug + builtin are immutable on update — see comment above.
	body.Slug = "" // skip slug validation; we won't write it
	if err := validateBody(body); err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}

	row := h.DB.QueryRow(r.Context(), `
		UPDATE ocr_profiles
		   SET name=$2, description=$3, icon=$4, lang=$5, psm=$6, preprocess=$7,
		       fields=$8::jsonb, extractors=$9::jsonb, llm_prompt=$10,
		       updated_at=now()
		 WHERE id=$1
		RETURNING id, COALESCE(org_id::text, ''), slug, name, description, icon,
		          lang, psm, preprocess, fields, extractors, llm_prompt, is_builtin,
		          created_at, updated_at
	`,
		id, body.Name, body.Description, defaultIcon(body.Icon),
		body.Lang, body.PSM, body.Preprocess,
		mustJSON(orEmpty(body.Fields)), mustJSON(orEmptyMap(body.Extractors)),
		body.LLMPrompt,
	)
	dto, err := scanDTO(row)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, dto)
}

// Delete removes a profile. Same gating as Update plus an extra rule:
// the `generic` built-in cannot be deleted because the runtime falls
// back to it for unknown slugs — losing it would crash extraction.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	if !c.IsAdmin() {
		writeErr(w, 403, "forbidden", "admin role required")
		return
	}
	id := chi.URLParam(r, "id")

	var existingOrgID, slug string
	var isBuiltin bool
	if err := h.DB.QueryRow(r.Context(),
		`SELECT COALESCE(org_id::text, ''), slug, is_builtin FROM ocr_profiles WHERE id=$1`,
		id,
	).Scan(&existingOrgID, &slug, &isBuiltin); err != nil {
		writeErr(w, 404, "not_found", "profile not found")
		return
	}
	if isBuiltin && !c.IsSuperAdmin() {
		writeErr(w, 403, "forbidden", "super-admin required to delete built-in profiles")
		return
	}
	if !isBuiltin && existingOrgID != c.OrgID {
		writeErr(w, 404, "not_found", "profile not found")
		return
	}
	if isBuiltin && slug == "generic" {
		writeErr(w, 400, "undeletable",
			"the generic profile is the runtime fallback and cannot be deleted")
		return
	}

	if _, err := h.DB.Exec(r.Context(), `DELETE FROM ocr_profiles WHERE id=$1`, id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

/* ----------------------------- Validation ------------------------------ */

// validateBody enforces the shape we'll accept on Create/Update. Slug
// is only checked when present (Update sets it to "" to skip — slug is
// immutable post-create).
func validateBody(b profileDTO) error {
	if b.Slug != "" {
		if !slugPattern.MatchString(b.Slug) {
			return errors.New("slug must match ^[a-z0-9][a-z0-9-]*$")
		}
		if len(b.Slug) > 64 {
			return errors.New("slug must be 64 chars or fewer")
		}
	}
	if strings.TrimSpace(b.Name) == "" {
		return errors.New("name is required")
	}
	if len(b.Name) > 120 {
		return errors.New("name must be 120 chars or fewer")
	}
	if len(b.Description) > 500 {
		return errors.New("description must be 500 chars or fewer")
	}
	if b.PSM < -1 || b.PSM > 13 {
		return errors.New("psm must be between -1 (inherit) and 13")
	}
	if len(b.Lang) > 32 {
		return errors.New("lang must be 32 chars or fewer")
	}
	if len(b.LLMPrompt) > 4000 {
		return errors.New("llmPrompt must be 4000 chars or fewer")
	}
	for k, src := range b.Extractors {
		if k == "" {
			return errors.New("extractor field key cannot be empty")
		}
		if len(src) > 500 {
			return fmt.Errorf("extractor %q regex too long (max 500 chars)", k)
		}
		if _, err := regexp.Compile(src); err != nil {
			return fmt.Errorf("extractor %q invalid regex: %v", k, err)
		}
	}
	return nil
}

// defaultIcon picks a sensible fallback when the caller leaves icon
// blank. Mirrors the static `generic` profile.
func defaultIcon(s string) string {
	if strings.TrimSpace(s) == "" {
		return "file-text"
	}
	return s
}

// mustJSON marshals a value we know is JSON-safe. Keeps the call sites
// readable; a panic here would be a programmer bug, not user input.
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// Fields/Extractors are always [] / {} — Marshal can't fail.
		panic(fmt.Sprintf("ocrprofiles: mustJSON: %v", err))
	}
	return b
}

// isUniqueViolation matches Postgres's "23505 unique_violation" SQLSTATE.
// We use it to translate the partial-unique-index collision on slug into
// a 409, rather than a generic 500.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	// pgx surfaces the SQLSTATE on its PgError; we string-match because
	// pulling in pgconn just for this would expand the import surface.
	var pgxErr interface{ SQLState() string }
	if errors.As(err, &pgxErr) {
		return pgxErr.SQLState() == "23505"
	}
	return strings.Contains(err.Error(), "23505")
}

// Sentinel for callers that want to know if a row actually existed
// before the mutation — currently unused outside this file but exposed
// so future audit-log wiring can detect the "row vanished mid-update"
// case without re-implementing the check.
var ErrNotFound = pgx.ErrNoRows

/* ------------------------- Response helpers ---------------------------- */

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
