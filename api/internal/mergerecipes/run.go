package mergerecipes

// Run handler — POST /v1/merge-recipes/{id}/run.
//
// Sync vs async
//
// Same split as /v1/files/merge: small all-PDF jobs run inline (≤ a
// handful of components, no soffice conversion needed); anything
// heavier — or the integrator explicitly setting `async:true` — falls
// through to TaskRunMergeRecipe for the worker to handle. The same
// merge_jobs table the ad-hoc merge uses backs the polling endpoint;
// callers don't need a different polling URL for recipe runs.
//
// What "running" means in code
//
//   1. Load recipe + components (ordered by position).
//   2. For each template component:
//        - Pull data[component.DataKey] (or the whole `data` if empty).
//        - Validate `required` semantics — a missing key on a required
//          component is a 422; a missing key on an optional component
//          skips that component entirely.
//        - Render in-memory via Runner.RenderInline (no drive row).
//   3. For each file component:
//        - Fetch bytes via Storage.GetBytes.
//   4. Pipe the assembled list into PDFMerge.AssembleInline.
//   5. Persist as a new file (or stream as a presigned download for
//      `download:true` callers — left as a future flag; today we
//      always persist).

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/docconvert"
	"github.com/docforge/api/internal/pdfmerge"
	"github.com/docforge/api/internal/queue"
	"github.com/go-chi/chi/v5"
)

// runRequest is the body POSTed to /v1/merge-recipes/{id}/run.
type runRequest struct {
	// Data is the caller's payload. Each template component reads its
	// slice as data[component.DataKey].
	Data map[string]any `json:"data"`
	// Async forces the worker path. Useful when the integrator knows
	// the recipe is heavy and doesn't want to hold an HTTP connection
	// open for tens of seconds.
	Async bool `json:"async,omitempty"`
	// OutputName overrides the recipe's output_name_template / name.
	// Empty falls back to the recipe's configured naming.
	OutputName string `json:"outputName,omitempty"`
	// FolderID for the output file. Empty = root.
	FolderID string `json:"folderId,omitempty"`
}

// Run is POST /v1/merge-recipes/{id}/run.
func (h *Handler) Run(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	id := chi.URLParam(r, "id")

	var req runRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}
	if req.Data == nil {
		req.Data = map[string]any{}
	}

	dto, err := h.loadRecipe(r.Context(), c.OrgID, id)
	if err != nil {
		writeErr(w, 404, "not_found", "recipe not found")
		return
	}
	if len(dto.Components) == 0 {
		writeErr(w, 400, "empty_recipe", "recipe has no components — add at least one before running")
		return
	}

	// Decide sync vs async. Heuristic: any soffice conversion (DOCX
	// component) or > 4 components routes async. The integrator can
	// always force async via `async:true`.
	wantAsync := req.Async || h.shouldRunAsync(dto)

	if wantAsync {
		if h.Queue == nil {
			writeErr(w, 503, "queue_unavailable", "async runs not available (worker queue not configured)")
			return
		}
		jobID, err := h.kickoffAsync(r.Context(), c, id, req)
		if err != nil {
			writeErr(w, 500, "queue_error", err.Error())
			return
		}
		writeJSON(w, 202, map[string]any{
			"async": true,
			"jobId": jobID,
		})
		return
	}

	// Sync path.
	res, err := h.runSync(r.Context(), c.OrgID, c.UserID, id, req)
	if err != nil {
		writeUserOrErr(w, err)
		return
	}
	// Bump last_run_at so the list view sorts by recency.
	_, _ = h.DB.Exec(r.Context(),
		`UPDATE merge_recipes SET last_run_at=now() WHERE id=$1`, id)

	writeJSON(w, 201, map[string]any{
		"async":  false,
		"fileId": res.FileID,
		"name":   res.Name,
		"size":   res.Size,
	})
}

// shouldRunAsync returns true when a recipe is "heavy" — at least one
// non-PDF file component (needs soffice) or many components. Conservative
// thresholds since the inline path is the fast-feedback path for the
// recipe builder's "Run" button; integrators with bulk workloads can
// always pass `async:true`.
func (h *Handler) shouldRunAsync(dto *recipeDTO) bool {
	if len(dto.Components) > 4 {
		return true
	}
	for _, cmp := range dto.Components {
		if cmp.Kind != "file" || cmp.FileID == "" {
			continue
		}
		// Cheap check: look at the file's mime/name. If non-PDF and
		// non-image, we'll need soffice — go async.
		var mime, name string
		_ = h.DB.QueryRow(context.Background(),
			`SELECT mime, name FROM files WHERE id=$1`, cmp.FileID,
		).Scan(&mime, &name)
		if !isPDFLike(mime, name) && !isImageLike(mime, name) {
			return true
		}
	}
	return false
}

// =====================================================================
//   Sync execution
// =====================================================================

// runResult is what RunSync / RunForJob produce. Carries the persisted
// output file's id + metadata so the HTTP handler can return it and
// the worker can update merge_jobs.
type runResult struct {
	FileID string
	Name   string
	Size   int
}

// runSync is the in-line recipe execution. Same code path is used by
// the async worker via RunForJob — the only difference is whether
// merge_jobs gets updated.
func (h *Handler) runSync(ctx context.Context, orgID, userID, recipeID string, req runRequest) (*runResult, error) {
	dto, err := h.loadRecipe(ctx, orgID, recipeID)
	if err != nil {
		return nil, &userError{status: 404, code: "not_found", msg: "recipe not found"}
	}

	sources, err := h.buildInlineSources(ctx, orgID, dto, req.Data)
	if err != nil {
		return nil, err
	}
	if len(sources) == 0 {
		return nil, &userError{status: 422, code: "no_components",
			msg: "no components produced output — every optional component skipped and no required components ran"}
	}

	pdfBytes, _, err := h.PDFMerge.AssembleInline(ctx, sources)
	if err != nil {
		return nil, fmt.Errorf("assemble: %w", err)
	}

	outName := chooseOutputName(dto, req, req.Data)
	fileID, err := h.persistOutput(ctx, orgID, userID, outName, req.FolderID, pdfBytes)
	if err != nil {
		return nil, err
	}
	return &runResult{FileID: fileID, Name: outName, Size: len(pdfBytes)}, nil
}

// buildInlineSources walks the recipe's components in position order,
// producing one pdfmerge.InlineSource per component. Templates are
// rendered (RenderInline); files are fetched (Storage.GetBytes). A
// missing data sub-object skips an optional component and 422s a
// required one.
func (h *Handler) buildInlineSources(ctx context.Context, orgID string, dto *recipeDTO, data map[string]any) ([]pdfmerge.InlineSource, error) {
	out := make([]pdfmerge.InlineSource, 0, len(dto.Components))
	for i, cmp := range dto.Components {
		// Resolve the data slice for template components.
		var slice map[string]any
		if cmp.Kind == "template" {
			key := strings.TrimSpace(cmp.DataKey)
			if key == "" {
				slice = data
			} else {
				raw, present := data[key]
				if !present {
					if cmp.Required {
						return nil, &userError{status: 422, code: "missing_data",
							msg: fmt.Sprintf("components[%d]: required data key %q is missing", i, key)}
					}
					continue // optional → skip
				}
				m, ok := raw.(map[string]any)
				if !ok {
					return nil, &userError{status: 400, code: "bad_data",
						msg: fmt.Sprintf("components[%d]: data[%q] must be an object, got %T", i, key, raw)}
				}
				slice = m
			}
			// Render in-memory.
			pdfBytes, _, rerr := h.Runner.RenderInline(ctx, orgID, cmp.TemplateID, slice, cmp.Flatten)
			if rerr != nil {
				return nil, &userError{status: 422, code: "render_failed",
					msg: fmt.Sprintf("components[%d] (template %s): %s", i, cmp.TemplateID, rerr.Error())}
			}
			out = append(out, pdfmerge.InlineSource{
				Bytes: pdfBytes,
				Mime:  "application/pdf",
				Name:  fmt.Sprintf("component-%d.pdf", i),
				Pages: cmp.Pages,
			})
			continue
		}

		// File component — fetch bytes from storage. ON DELETE SET NULL
		// on the FK means a deleted source leaves an empty file_id; we
		// treat that as a "broken component" 422 (matching the design
		// rationale on the migration: precise error vs confusing 500).
		if cmp.FileID == "" {
			if cmp.Required {
				return nil, &userError{status: 422, code: "missing_source",
					msg: fmt.Sprintf("components[%d]: source file is no longer available", i)}
			}
			continue
		}
		var name, mime, key string
		if err := h.DB.QueryRow(ctx,
			`SELECT name, mime, storage_key FROM files
			   WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`,
			cmp.FileID, orgID,
		).Scan(&name, &mime, &key); err != nil {
			if cmp.Required {
				return nil, &userError{status: 422, code: "missing_source",
					msg: fmt.Sprintf("components[%d]: source file not found", i)}
			}
			continue
		}
		bytesRaw, err := h.Storage.GetBytes(ctx, key)
		if err != nil {
			return nil, fmt.Errorf("components[%d]: read source: %w", i, err)
		}
		out = append(out, pdfmerge.InlineSource{
			Bytes: bytesRaw,
			Name:  name,
			Mime:  mime,
			Pages: cmp.Pages,
		})
	}
	return out, nil
}

// persistOutput inserts a new files row + uploads the bytes. Mirrors
// the pdfmerge.persistNewPDF flow so output files from recipes look
// identical to those from the ad-hoc merge endpoint.
func (h *Handler) persistOutput(ctx context.Context, orgID, userID, name, folderID string, data []byte) (string, error) {
	var folderArg any
	if id := strings.TrimSpace(folderID); id != "" {
		folderArg = id
	}
	var id string
	if err := h.DB.QueryRow(ctx,
		`INSERT INTO files (org_id, owner_id, name, mime, storage_key, folder_id)
		 VALUES ($1,$2,$3,'application/pdf','',$4)
		 RETURNING id`,
		orgID, userID, name, folderArg,
	).Scan(&id); err != nil {
		return "", err
	}
	key := fmt.Sprintf("orgs/%s/files/%s/%s", orgID, id, name)
	if _, err := h.DB.Exec(ctx, `UPDATE files SET storage_key=$1 WHERE id=$2`, key, id); err != nil {
		return "", err
	}
	if err := h.Storage.PutBytes(ctx, key, "application/pdf", data); err != nil {
		_, _ = h.DB.Exec(ctx, `DELETE FROM files WHERE id=$1`, id)
		return "", err
	}
	if _, err := h.DB.Exec(ctx,
		`UPDATE files SET status='active', size=$1, updated_at=now() WHERE id=$2`,
		len(data), id,
	); err != nil {
		return "", err
	}
	return id, nil
}

// chooseOutputName picks the output file name in priority order:
//   1. req.OutputName (explicit caller override),
//   2. recipe.OutputNameTemplate after Mustache-flavored substitution,
//   3. recipe.Name + ".pdf".
//
// We support a deliberately tiny substitution grammar — `{{ name }}`,
// `{{ date }}`, and dotted paths into the data object. No conditionals,
// no helpers; integrators wanting more should set OutputName explicitly.
func chooseOutputName(dto *recipeDTO, req runRequest, data map[string]any) string {
	if n := strings.TrimSpace(req.OutputName); n != "" {
		return ensurePDFExt(n)
	}
	tpl := strings.TrimSpace(dto.OutputNameTemplate)
	if tpl == "" {
		return ensurePDFExt(dto.Name)
	}
	out := tpl
	out = strings.ReplaceAll(out, "{{ name }}", dto.Name)
	out = strings.ReplaceAll(out, "{{name}}", dto.Name)
	today := time.Now().UTC().Format("2006-01-02")
	out = strings.ReplaceAll(out, "{{ date }}", today)
	out = strings.ReplaceAll(out, "{{date}}", today)
	out = expandDataPlaceholders(out, data)
	return ensurePDFExt(out)
}

// expandDataPlaceholders replaces `{{ a.b.c }}` with data["a"]["b"]["c"]
// stringified. Missing paths render as the empty string — same
// permissive policy templates have for missing placeholders.
func expandDataPlaceholders(s string, data map[string]any) string {
	var out strings.Builder
	i := 0
	for i < len(s) {
		j := strings.Index(s[i:], "{{")
		if j < 0 {
			out.WriteString(s[i:])
			break
		}
		out.WriteString(s[i : i+j])
		k := strings.Index(s[i+j:], "}}")
		if k < 0 {
			out.WriteString(s[i+j:])
			break
		}
		expr := strings.TrimSpace(s[i+j+2 : i+j+k])
		// Skip `name` / `date` — handled by caller.
		if expr == "name" || expr == "date" {
			out.WriteString(s[i+j : i+j+k+2])
			i = i + j + k + 2
			continue
		}
		out.WriteString(stringifyPath(data, expr))
		i = i + j + k + 2
	}
	return out.String()
}

func stringifyPath(data map[string]any, path string) string {
	parts := strings.Split(path, ".")
	var cur any = data
	for _, p := range parts {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		cur = m[p]
	}
	if cur == nil {
		return ""
	}
	return fmt.Sprintf("%v", cur)
}

func ensurePDFExt(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "merged"
	}
	if !strings.HasSuffix(strings.ToLower(name), ".pdf") {
		name += ".pdf"
	}
	return name
}

// =====================================================================
//   Async kickoff
// =====================================================================

func (h *Handler) kickoffAsync(ctx context.Context, c *auth.Claims, recipeID string, req runRequest) (string, error) {
	payload := map[string]any{
		"recipeId":   recipeID,
		"data":       req.Data,
		"outputName": req.OutputName,
		"folderId":   req.FolderID,
	}
	payloadBytes, _ := json.Marshal(payload)

	var jobID string
	if err := h.DB.QueryRow(ctx,
		`INSERT INTO merge_jobs (org_id, user_id, status, payload, recipe_id)
		 VALUES ($1, $2, 'queued', $3::jsonb, $4)
		 RETURNING id`,
		c.OrgID, c.UserID, payloadBytes, recipeID,
	).Scan(&jobID); err != nil {
		return "", err
	}

	task, err := queue.NewRunMergeRecipe(queue.RunMergeRecipePayload{
		JobID:      jobID,
		OrgID:      c.OrgID,
		UserID:     c.UserID,
		RecipeID:   recipeID,
		Data:       req.Data,
		OutputName: req.OutputName,
		FolderID:   req.FolderID,
	})
	if err != nil {
		return "", err
	}
	if _, err := h.Queue.EnqueueContext(ctx, task); err != nil {
		return "", err
	}
	return jobID, nil
}

// =====================================================================
//   Worker entry point — wired from cmd/worker/main.go via worker.Handlers.
// =====================================================================

// RunForJob is the worker side of TaskRunMergeRecipe. Drives the same
// runSync code path and updates merge_jobs from queued → running →
// done/failed. Returning a non-nil error makes asynq retry per the
// task's MaxRetry budget.
func (h *Handler) RunForJob(ctx context.Context, p queue.RunMergeRecipePayload) error {
	if _, err := h.DB.Exec(ctx,
		`UPDATE merge_jobs SET status='running', updated_at=now()
		   WHERE id=$1 AND status IN ('queued','running','failed')`,
		p.JobID,
	); err != nil {
		return err
	}
	res, err := h.runSync(ctx, p.OrgID, p.UserID, p.RecipeID, runRequest{
		Data:       p.Data,
		OutputName: p.OutputName,
		FolderID:   p.FolderID,
	})
	if err != nil {
		// Flatten userError into a user-readable string.
		msg := err.Error()
		if len(msg) > 4000 {
			msg = msg[:4000]
		}
		_, _ = h.DB.Exec(ctx,
			`UPDATE merge_jobs SET status='failed', error=$1, updated_at=now() WHERE id=$2`,
			msg, p.JobID,
		)
		return err
	}
	if _, err := h.DB.Exec(ctx,
		`UPDATE merge_jobs SET status='done', file_id=$1, error=NULL, updated_at=now()
		   WHERE id=$2`,
		res.FileID, p.JobID,
	); err != nil {
		return err
	}
	_, _ = h.DB.Exec(ctx,
		`UPDATE merge_recipes SET last_run_at=now() WHERE id=$1`, p.RecipeID)
	return nil
}

// =====================================================================
//   Local mime / name helpers — small enough to keep here, avoids a
//   circular dep on internal/pdfmerge for these predicates.
// =====================================================================

func isPDFLike(mime, name string) bool {
	if strings.EqualFold(mime, "application/pdf") {
		return true
	}
	return strings.HasSuffix(strings.ToLower(name), ".pdf")
}

func isImageLike(mime, name string) bool {
	if strings.HasPrefix(strings.ToLower(mime), "image/") {
		return true
	}
	switch strings.ToLower(filepathExt(name)) {
	case ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".gif", ".bmp", ".webp":
		return true
	}
	return false
}

// filepathExt is a one-liner replacement for filepath.Ext — keeps the
// import list short.
func filepathExt(name string) string {
	i := strings.LastIndex(name, ".")
	if i < 0 {
		return ""
	}
	return name[i:]
}

// docconvert reference pin so the import resolves even when callers
// trim soffice handling. The actual conversion is done inside
// pdfmerge.AssembleInline; we keep the import as documentation that
// recipes participate in the same heterogeneous-input pipeline.
var _ = docconvert.IsConvertible
