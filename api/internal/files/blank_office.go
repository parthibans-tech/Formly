package files

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/officeblank"
	"github.com/docforge/api/internal/uploadpolicy"
)

// blankOfficeReq is the JSON payload for POST /v1/files/blank-office.
// Kind is one of "docx" / "xlsx" / "pptx"; Name is the human display
// name (without extension — we append it). FolderID is optional (empty
// string ⇒ root). The endpoint is intentionally narrow: it doesn't
// expose conflict-resolution strategies the way CreateUploadURL does
// because the caller can pre-compute a unique display name with the
// listing it already has, and "create blank doc" doesn't need a
// replace-in-place flow.
type blankOfficeReq struct {
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	FolderID string `json:"folderId,omitempty"`
}

type blankOfficeResp struct {
	FileID string `json:"fileId"`
	Name   string `json:"name"`
	Mime   string `json:"mime"`
	Size   int    `json:"size"`
}

// BlankOffice creates a fresh file row containing a minimal valid OOXML
// document, uploads the bytes directly via Storage.PutBytes, and marks
// the row as active in one shot. Bypasses the presigned-upload + scan
// pipeline that CreateUploadURL/Complete run for user-supplied content
// because:
//
//   - The bytes are server-generated from a hard-coded template; there's
//     nothing to scan and no policy to enforce. Sending them back out
//     to the browser only to have the browser PUT them back to MinIO
//     would burn round-trips for no win.
//   - The whole point of this endpoint is "fast path: click → editor",
//     which means the file row must exist with status='active' before
//     we redirect into OnlyOffice. Going through the regular flow leaves
//     the row at status='pending' until Complete fires, which the
//     editor refuses to load.
//
// Frontend flow: POST /v1/files/blank-office → navigate to
// /editor/{fileId}.
func (h *Handler) BlankOffice(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req blankOfficeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	kind := officeblank.Kind(strings.ToLower(strings.TrimSpace(req.Kind)))
	switch kind {
	case officeblank.KindDocx, officeblank.KindXlsx, officeblank.KindPptx:
	default:
		writeErr(w, 400, "invalid_kind", "kind must be docx, xlsx, or pptx")
		return
	}

	// Generate the bytes up-front: we use the size to set files.size and
	// catch any (theoretical) generator failure before we touch the DB.
	blob, err := officeblank.Generate(kind)
	if err != nil {
		writeErr(w, 500, "generate_error", err.Error())
		return
	}

	// Default display name when caller didn't pass one — keeps the
	// frontend simple ("just create something"). The matching extension
	// is appended unconditionally when missing so OnlyOffice's
	// fileTypeFor() resolves cleanly off the name.
	display := strings.TrimSpace(req.Name)
	if display == "" {
		switch kind {
		case officeblank.KindDocx:
			display = "Untitled document"
		case officeblank.KindXlsx:
			display = "Untitled spreadsheet"
		case officeblank.KindPptx:
			display = "Untitled presentation"
		}
	}
	if !strings.HasSuffix(strings.ToLower(display), "."+blob.Ext) {
		display = display + "." + blob.Ext
	}
	display = uploadpolicy.SanitizeFilename(display)

	var folderArg any
	if req.FolderID != "" {
		folderArg = req.FolderID
	} else {
		folderArg = nil
	}

	// "Keep both" semantics: if the user already has "Untitled
	// document.docx" in this folder, transparently bump to
	// "Untitled document (2).docx". Avoids forcing the UI to surface a
	// rename modal for a flow that's meant to feel instant.
	display = nextAvailableName(r.Context(), h.DB, c.OrgID, folderArg, display)

	var id string
	if err := h.DB.QueryRow(r.Context(),
		`INSERT INTO files (org_id, owner_id, name, mime, storage_key, folder_id)
		 VALUES ($1,$2,$3,$4,'',$5) RETURNING id`,
		c.OrgID, c.UserID, display, blob.Mime, folderArg,
	).Scan(&id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	key := fmt.Sprintf("orgs/%s/files/%s/%s",
		c.OrgID, id, uploadpolicy.SafeStorageSlug(display))

	if err := h.Storage.PutBytes(r.Context(), key, blob.Mime, blob.Bytes); err != nil {
		// Best-effort cleanup: if the row exists but the blob upload
		// failed, drop the row so the user doesn't end up with a ghost
		// listing entry that won't open. We don't return the cleanup
		// error — the original PutBytes failure is what the user needs
		// to see.
		_, _ = h.DB.Exec(r.Context(), `DELETE FROM files WHERE id=$1`, id)
		writeErr(w, 500, "storage_error", err.Error())
		return
	}

	// status='active' + scan_status='skipped' mirrors the
	// no-scanner branch of Complete. The bytes came from us; running
	// them past clamd would be theatre.
	if _, err := h.DB.Exec(r.Context(),
		`UPDATE files
		    SET storage_key=$1,
		        status='active',
		        scan_status='skipped',
		        scan_engine=COALESCE(scan_engine, 'unconfigured'),
		        size=$2,
		        updated_at=now()
		  WHERE id=$3`,
		key, len(blob.Bytes), id,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	audit.LogHTTP(r, h.DB, "file.blank_office.created", "file", id, map[string]any{
		"kind":     string(kind),
		"name":     display,
		"folderId": req.FolderID,
		"size":     len(blob.Bytes),
	})

	writeJSON(w, 200, blankOfficeResp{
		FileID: id,
		Name:   display,
		Mime:   blob.Mime,
		Size:   len(blob.Bytes),
	})
}
