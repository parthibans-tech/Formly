package sharing

// Access requests — the "I'm a viewer, can I please have edit access"
// flow. Complements the owner-push grant handlers in acl.go.
//
// Lifecycle:
//
//   viewer POSTs /v1/files/:id/request-access
//     → one row inserted in access_requests with status='pending'
//     → a partial unique index blocks second concurrent pending rows,
//       so refresh + re-click doesn't spam the owner's inbox
//
//   owner GETs /v1/access-requests (inbox view) to see pending rows
//     for every file they own. Rows from other owners are filtered
//     out at the SQL level.
//
//   owner POSTs /v1/access-requests/:id/approve
//     → a resource_shares row is upserted (user becomes editor/viewer
//       depending on requested_role) AND the access_requests row flips
//       to 'approved'. Done in a single tx so the two never disagree.
//
//   owner POSTs /v1/access-requests/:id/deny
//     → request row moves to 'denied'; resource_shares untouched.
//
//   requester can POST /v1/access-requests/:id/cancel on their own
//     row to withdraw a pending request (useful if they got access
//     another way in the meantime).

import (
	"context"
	"encoding/json"
	"html"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
)

type accessRequestReq struct {
	Role    string `json:"role"`    // "viewer" | "editor", default "editor"
	Message string `json:"message"` // optional note to the owner
}

type accessRequestDTO struct {
	ID             string    `json:"id"`
	FileID         string    `json:"fileId"`
	FileName       string    `json:"fileName"`
	RequesterID    string    `json:"requesterId"`
	RequesterEmail string    `json:"requesterEmail"`
	RequesterName  string    `json:"requesterName,omitempty"`
	Role           string    `json:"role"`
	Message        string    `json:"message"`
	Status         string    `json:"status"`
	CreatedAt      time.Time `json:"createdAt"`
}

// RequestFileAccess — any authenticated user in the org can file a
// request. We intentionally don't gate on "does the user currently
// have view access?" — a teammate who stumbled on the file via a
// share link preview should still be able to ask the owner for a
// real share.
func (h *Handler) RequestFileAccess(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	fileID := chi.URLParam(r, "id")

	var req accessRequestReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// Tolerate empty body — zero-value struct is fine.
		req = accessRequestReq{}
	}
	role := strings.ToLower(strings.TrimSpace(req.Role))
	if role == "" {
		role = "editor"
	}
	if role != "viewer" && role != "editor" {
		writeErr(w, 400, "invalid_role", "role must be viewer or editor")
		return
	}

	// Confirm the file exists in this org and look up its owner so we
	// can short-circuit a silly case: the owner asking themselves for
	// edit access on their own file. The 409 here is deliberate — a
	// 200 would pretend we filed a no-op request.
	var ownerID string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT owner_id FROM files WHERE id=$1 AND org_id=$2`,
		fileID, c.OrgID,
	).Scan(&ownerID); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	if ownerID == c.UserID {
		writeErr(w, 409, "is_owner", "you already own this file")
		return
	}

	// The partial unique index on (file_id, requester_id) WHERE
	// status='pending' means re-clicking the button while a request
	// is open collapses to the same row — we return 200 either way
	// so the UI can treat "already pending" as success.
	var id, fileName string
	err := h.DB.QueryRow(r.Context(),
		`WITH ins AS (
			INSERT INTO access_requests
				(org_id, file_id, requester_id, requested_role, message)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (file_id, requester_id) WHERE status = 'pending'
			 DO UPDATE SET message = EXCLUDED.message
			 RETURNING id, file_id
		)
		SELECT ins.id, f.name FROM ins JOIN files f ON f.id = ins.file_id`,
		c.OrgID, fileID, c.UserID, role, req.Message,
	).Scan(&id, &fileName)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	// Notify the owner. We don't fail the API call if the email fails —
	// the request is in the DB and will show up in the inbox regardless.
	h.notifyOwnerOfRequest(r.Context(), c.OrgID, ownerID, c.Email, fileName, id, role, req.Message)

	writeJSON(w, 200, map[string]any{"id": id, "status": "pending"})
}

// ListAccessRequests — inbox for owners. Returns every pending
// request for files the caller owns. Admins additionally see
// requests across the whole org so they can unblock things.
//
// A `?scope=mine` query param (default) returns rows for the
// requester — the caller's own outgoing requests — so the viewer's
// "pending" badge can flip off once the owner decides.
func (h *Handler) ListAccessRequests(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "inbox"
	}

	var sql string
	var args []any
	switch scope {
	case "outbox":
		// My outgoing requests — useful to show a pending state
		// next to the file in Drive.
		sql = `SELECT ar.id, ar.file_id, f.name, ar.requester_id,
		              u.email, COALESCE(u.name,''), ar.requested_role,
		              ar.message, ar.status, ar.created_at
		         FROM access_requests ar
		         JOIN files f ON f.id = ar.file_id
		         JOIN users u ON u.id = ar.requester_id
		        WHERE ar.org_id = $1 AND ar.requester_id = $2::uuid
		        ORDER BY ar.created_at DESC
		        LIMIT 200`
		args = []any{c.OrgID, c.UserID}
	default: // "inbox"
		// Owner-side: rows for files the caller owns, plus any
		// org-wide view for admins. `status='pending'` is the
		// default so stale decided rows don't clutter the UI;
		// clients that want history can pass ?status=all.
		includeDecided := r.URL.Query().Get("status") == "all"
		statusClause := "AND ar.status = 'pending'"
		if includeDecided {
			statusClause = ""
		}
		if c.IsAdmin() && r.URL.Query().Get("scope") == "org" {
			sql = `SELECT ar.id, ar.file_id, f.name, ar.requester_id,
			              u.email, COALESCE(u.name,''), ar.requested_role,
			              ar.message, ar.status, ar.created_at
			         FROM access_requests ar
			         JOIN files f ON f.id = ar.file_id
			         JOIN users u ON u.id = ar.requester_id
			        WHERE ar.org_id = $1 ` + statusClause + `
			        ORDER BY ar.created_at DESC
			        LIMIT 500`
			args = []any{c.OrgID}
		} else {
			sql = `SELECT ar.id, ar.file_id, f.name, ar.requester_id,
			              u.email, COALESCE(u.name,''), ar.requested_role,
			              ar.message, ar.status, ar.created_at
			         FROM access_requests ar
			         JOIN files f ON f.id = ar.file_id
			         JOIN users u ON u.id = ar.requester_id
			        WHERE ar.org_id = $1
			          AND f.owner_id = $2::uuid ` + statusClause + `
			        ORDER BY ar.created_at DESC
			        LIMIT 200`
			args = []any{c.OrgID, c.UserID}
		}
	}

	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	out := []accessRequestDTO{}
	for rows.Next() {
		var d accessRequestDTO
		if err := rows.Scan(&d.ID, &d.FileID, &d.FileName, &d.RequesterID,
			&d.RequesterEmail, &d.RequesterName, &d.Role, &d.Message,
			&d.Status, &d.CreatedAt); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		out = append(out, d)
	}
	writeJSON(w, 200, map[string]any{"requests": out})
}

// ApproveAccessRequest flips the request to status='approved' AND
// upserts a matching resource_shares row in one tx. The two-step
// flow (approve request, then hit /access to grant) would leave
// the door open for half-applied state if the second call failed,
// so we do both here.
func (h *Handler) ApproveAccessRequest(w http.ResponseWriter, r *http.Request) {
	h.decideAccessRequest(w, r, "approved")
}

// DenyAccessRequest flips the row to status='denied' — nothing else.
// The requester can re-file later (the partial unique index only
// covers pending rows).
func (h *Handler) DenyAccessRequest(w http.ResponseWriter, r *http.Request) {
	h.decideAccessRequest(w, r, "denied")
}

// CancelAccessRequest is the requester-side withdraw. Only the user
// who opened the request can cancel their own row.
func (h *Handler) CancelAccessRequest(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	res, err := h.DB.Exec(r.Context(),
		`UPDATE access_requests
		    SET status='cancelled', decided_at=now(), decided_by=$1::uuid
		  WHERE id=$2 AND org_id=$3 AND requester_id=$1::uuid AND status='pending'`,
		c.UserID, id, c.OrgID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if res.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "request not found or already decided")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) decideAccessRequest(w http.ResponseWriter, r *http.Request, decision string) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	// Load the row + gate on ownership. A single query because we
	// need the file/role/requester details to mint the share row if
	// the decision is approve.
	var fileID, requesterID, role, ownerID string
	err := h.DB.QueryRow(r.Context(),
		`SELECT ar.file_id, ar.requester_id, ar.requested_role, f.owner_id
		   FROM access_requests ar
		   JOIN files f ON f.id = ar.file_id
		  WHERE ar.id=$1 AND ar.org_id=$2 AND ar.status='pending'`,
		id, c.OrgID,
	).Scan(&fileID, &requesterID, &role, &ownerID)
	if err != nil {
		writeErr(w, 404, "not_found", "request not found or already decided")
		return
	}
	if !c.IsAdmin() && ownerID != c.UserID {
		writeErr(w, 403, "forbidden", "only the owner can decide this request")
		return
	}

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := tx.Exec(r.Context(),
		`UPDATE access_requests
		    SET status=$1, decided_at=now(), decided_by=$2::uuid
		  WHERE id=$3`,
		decision, c.UserID, id,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	if decision == "approved" {
		// Upsert the share. Same SQL shape as grantOn — keeps
		// ON CONFLICT behaviour consistent with owner-initiated
		// grants so we never end up with duplicate rows.
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO resource_shares
				(org_id, resource_type, resource_id, user_id, role, created_by)
			 VALUES ($1,'file',$2,$3,$4,$5)
			 ON CONFLICT (resource_type, resource_id, user_id) WHERE user_id IS NOT NULL
			 DO UPDATE SET role = EXCLUDED.role`,
			c.OrgID, fileID, requesterID, role, c.UserID,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	// Tell the requester what happened. Best-effort — DB state already
	// reflects the decision so a missing email is recoverable (they'll
	// see the change next time they refresh the file or My Requests).
	h.notifyRequesterOfDecision(r.Context(), c.OrgID, requesterID, fileID, role, decision)

	writeJSON(w, 200, map[string]any{"ok": true, "status": decision})
}

// -- notifications -------------------------------------------------------
//
// All access-request notifications go through the injected Notifier
// (mail.Mailer in production). When Mailer is nil we no-op, which
// keeps integration tests that build a Handler directly working
// without standing up an SMTP/SES dependency.

func (h *Handler) notifyOwnerOfRequest(
	ctx context.Context,
	orgID, ownerID, requesterEmail, fileName, requestID, requestedRole, message string,
) {
	if h.Mailer == nil {
		return
	}
	ownerEmail, ownerName := h.lookupUser(ctx, ownerID)
	if ownerEmail == "" {
		return
	}
	subject := requesterEmail + " is requesting access to " + fileName
	html := buildOwnerRequestHTML(ownerName, requesterEmail, fileName, requestedRole, message)
	text := requesterEmail + " is asking for " + requestedRole +
		" access to \"" + fileName + "\". Decide at /settings/access-requests."

	_, _ = h.Mailer.Send(ctx, NotifyOptions{
		OrgID:    orgID,
		UserID:   ownerID,
		Kind:     "access_request_filed",
		Source:   "sharing.access_request_filed",
		To:       []string{ownerEmail},
		Subject:  subject,
		HTMLBody: html,
		TextBody: text,
		Metadata: map[string]any{
			"requestId":      requestID,
			"fileName":       fileName,
			"requesterEmail": requesterEmail,
			"requestedRole":  requestedRole,
		},
	})
}

func (h *Handler) notifyRequesterOfDecision(
	ctx context.Context,
	orgID, requesterID, fileID, role, decision string,
) {
	if h.Mailer == nil {
		return
	}
	reqEmail, reqName := h.lookupUser(ctx, requesterID)
	if reqEmail == "" {
		return
	}
	var fileName string
	_ = h.DB.QueryRow(ctx, `SELECT name FROM files WHERE id=$1`, fileID).Scan(&fileName)

	subject := "Your access request was " + decision
	html := buildRequesterDecisionHTML(reqName, fileName, role, decision)
	text := "Your request for " + role + " access to \"" + fileName + "\" was " + decision + "."

	kind := "access_request_" + decision
	_, _ = h.Mailer.Send(ctx, NotifyOptions{
		OrgID:    orgID,
		UserID:   requesterID,
		Kind:     kind,
		Source:   "sharing.access_request_" + decision,
		To:       []string{reqEmail},
		Subject:  subject,
		HTMLBody: html,
		TextBody: text,
		Metadata: map[string]any{
			"fileId":   fileID,
			"fileName": fileName,
			"role":     role,
		},
	})
}

func (h *Handler) lookupUser(ctx context.Context, userID string) (emailAddr, name string) {
	_ = h.DB.QueryRow(ctx,
		`SELECT email, COALESCE(name,'') FROM users WHERE id=$1`, userID,
	).Scan(&emailAddr, &name)
	return
}

// buildOwnerRequestHTML renders the email the owner sees when a viewer
// asks for access. Plain inline-style HTML — no template engine — keeps
// the dependency surface small and the email looks fine in every client.
func buildOwnerRequestHTML(ownerName, requesterEmail, fileName, role, message string) string {
	greeting := "Hi"
	if ownerName != "" {
		greeting = "Hi " + ownerName
	}
	body := `<div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px">
  <h2 style="margin:0 0 12px">Access request</h2>
  <p>` + greeting + `,</p>
  <p><strong>` + escapeHTML(requesterEmail) + `</strong> is requesting <strong>` + escapeHTML(role) +
		`</strong> access to <strong>` + escapeHTML(fileName) + `</strong>.</p>`
	if message != "" {
		body += `<blockquote style="margin:12px 0;padding:8px 12px;border-left:3px solid #e5e7eb;color:#4b5563">` +
			escapeHTML(message) + `</blockquote>`
	}
	body += `<p>Open <a href="` + appURL("/settings/access-requests") +
		`">your access requests inbox</a> to approve or deny.</p>
  <p style="color:#6b7280;font-size:12px">You're receiving this because you own the file in question.</p>
</div>`
	return body
}

func buildRequesterDecisionHTML(name, fileName, role, decision string) string {
	greeting := "Hi"
	if name != "" {
		greeting = "Hi " + name
	}
	color := "#16a34a"
	if decision == "denied" {
		color = "#dc2626"
	}
	cta := ""
	if decision == "approved" {
		cta = `<p>Open the file: <a href="` + appURL("/drive") + `">go to Drive</a>.</p>`
	}
	return `<div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px">
  <h2 style="margin:0 0 12px">Access request ` + decision + `</h2>
  <p>` + greeting + `,</p>
  <p>Your request for <strong>` + escapeHTML(role) + `</strong> access to
     <strong>` + escapeHTML(fileName) + `</strong> was
     <span style="color:` + color + `;font-weight:600">` + decision + `</span>.</p>
  ` + cta + `
</div>`
}

func appURL(path string) string {
	base := os.Getenv("APP_URL")
	if base == "" {
		base = "http://localhost:3000"
	}
	return base + path
}

// escapeHTML wraps html.EscapeString — split out so the email builders
// read top-to-bottom without an import-heavy aside.
func escapeHTML(s string) string { return html.EscapeString(s) }

// HasPendingRequest returns true iff the caller has an open request
// on the given file. Used by the TemplateViewer to toggle the
// "Request sent" vs "Request access" button label.
func (h *Handler) HasPendingRequest(ctx context.Context, userID, orgID, fileID string) (bool, error) {
	var ok bool
	err := h.DB.QueryRow(ctx,
		`SELECT EXISTS(
		   SELECT 1 FROM access_requests
		    WHERE file_id=$1 AND requester_id=$2::uuid
		      AND org_id=$3 AND status='pending')`,
		fileID, userID, orgID,
	).Scan(&ok)
	return ok, err
}
