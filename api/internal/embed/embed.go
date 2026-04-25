// Package embed exposes an unauthenticated read-only endpoint that the
// Next.js middleware calls before rendering a public embed page (form,
// share, review) so it can emit a per-org Content-Security-Policy
// `frame-ancestors` directive.
//
//	GET /v1/public/embed-policy?kind={form|share|review}&token=<tok>
//	→  200 { "origins": ["https://customer.example", ...] }
//	→  404 { "error": ... } when the token doesn't resolve
//
// What's exposed: only the org's embed allowlist for that one token.
// That list is data the org admin already published the moment they
// pasted our embed snippet on those origins — the endpoint isn't
// leaking anything new. It's deliberately NOT scoped to a session
// (cookies / bearer tokens) because the page about to be rendered is
// itself anonymous.
//
// What's protected:
//
//   - The endpoint never reveals whether a token is valid for "the
//     wrong kind" — a `kind=form` lookup that finds a share-link
//     token still 404s, so the endpoint can't be used as an
//     existence oracle that distinguishes share/form/review tokens.
//   - Tokens are only ever compared by exact equality against the
//     indexed `token` column, so timing leaks reduce to whatever the
//     index lookup itself reveals.
//   - Rate-limited at the router (mounted behind the same fixed-
//     window limiter the auth endpoints use) to make brute-forcing
//     the token namespace impractical.
//
// The data path is short: token → org_id (single PK lookup) →
// uploadpolicy.Service.Effective (in-process cache, 60s TTL) →
// Policy.EmbedAllowedOrigins.
package embed

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/docforge/api/internal/uploadpolicy"
)

// Handler is the HTTP surface. The `Policy` dependency is the same
// uploadpolicy.Service used everywhere else; we hold it as an interface
// to keep this package testable without spinning up a real pgxpool.
type Handler struct {
	DB     *pgxpool.Pool
	Policy *uploadpolicy.Service
}

func New(db *pgxpool.Pool, p *uploadpolicy.Service) *Handler {
	return &Handler{DB: db, Policy: p}
}

// Resolve handles GET /v1/public/embed-policy.
func (h *Handler) Resolve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	kind := strings.ToLower(strings.TrimSpace(q.Get("kind")))
	token := strings.TrimSpace(q.Get("token"))
	if token == "" {
		writeErr(w, 400, "missing_token", "token query parameter is required")
		return
	}
	if !validKind(kind) {
		writeErr(w, 400, "invalid_kind", "kind must be one of form, share, review")
		return
	}

	orgID, err := resolveTokenOrg(r.Context(), h.DB, kind, token)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Same 404 for "doesn't exist" and "wrong kind" so the
			// endpoint can't be used to enumerate.
			writeErr(w, 404, "not_found", "embed token not found")
			return
		}
		writeErr(w, 500, "lookup_failed", err.Error())
		return
	}

	pol, err := h.Policy.Effective(r.Context(), orgID)
	if err != nil {
		writeErr(w, 500, "policy_error", err.Error())
		return
	}

	// Return the canonical allowlist. The middleware composes the final
	// frame-ancestors directive (it also has to know the SPA's own
	// origin to add 'self'), so we keep this response minimal — just
	// the data the admin configured.
	origins := pol.EmbedAllowedOrigins
	if origins == nil {
		origins = []string{}
	}
	writeJSON(w, 200, map[string]any{
		"kind":    kind,
		"origins": origins,
	})
}

// resolveTokenOrg looks up the org_id that owns `token` for `kind`.
// Returns pgx.ErrNoRows when the token doesn't match the kind — callers
// translate that to 404 without distinguishing it from "wrong kind"
// (avoids being an enumeration oracle).
func resolveTokenOrg(ctx context.Context, db *pgxpool.Pool, kind, token string) (string, error) {
	var orgID string
	switch kind {
	case "form":
		err := db.QueryRow(ctx,
			`SELECT org_id::text FROM form_links WHERE token=$1`, token,
		).Scan(&orgID)
		return orgID, err
	case "review":
		err := db.QueryRow(ctx,
			`SELECT org_id::text FROM review_links WHERE token=$1`, token,
		).Scan(&orgID)
		return orgID, err
	case "share":
		// share_links doesn't carry org_id directly — it lives one hop
		// over via files. The presence of the JOIN keeps a revoked /
		// trashed-file share from leaking origins (the row simply
		// won't match, returning the same 404 as a bogus token).
		err := db.QueryRow(ctx, `
			SELECT f.org_id::text
			  FROM share_links s
			  JOIN files f ON f.id = s.file_id
			 WHERE s.token=$1
			   AND s.revoked_at IS NULL
			   AND f.trashed_at IS NULL`,
			token,
		).Scan(&orgID)
		return orgID, err
	default:
		return "", pgx.ErrNoRows
	}
}

func validKind(k string) bool {
	switch k {
	case "form", "share", "review":
		return true
	}
	return false
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, max-age=30")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{"code": slug, "message": msg},
	})
}
