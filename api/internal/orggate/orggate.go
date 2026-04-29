// Package orggate enforces the per-org freeze + soft-delete flags
// from migration 029 on every authenticated request.
//
// Behavior
// --------
//   - org.deleted_at IS NOT NULL → 410 Gone for every method. Existing
//     sessions ride along until expiry; this is the catch-all so they
//     can't keep mutating data after the tombstone is set.
//   - org.frozen_at IS NOT NULL  → 423 Locked for non-GET/HEAD/OPTIONS
//     methods. Reads stay open so an operator can audit before
//     unfreezing. Super-admin requests (claims.IsSuperAdmin via the
//     users.is_super_admin column) bypass the freeze entirely.
//
// We cache the (frozen_at, deleted_at) pair per-org for `cacheTTL` to
// avoid a DB round-trip on every authenticated request. The cache is
// trivially invalidated by waiting out the TTL — freeze/unfreeze is a
// rare operator action so a few seconds of staleness is fine.
package orggate

import (
	"net/http"
	"sync"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/jackc/pgx/v5/pgxpool"
)

const cacheTTL = 15 * time.Second

type orgState struct {
	frozen    bool
	deleted   bool
	expiresAt time.Time
}

type cache struct {
	mu sync.RWMutex
	m  map[string]orgState
}

func (c *cache) get(orgID string) (orgState, bool) {
	c.mu.RLock()
	s, ok := c.m[orgID]
	c.mu.RUnlock()
	if !ok || time.Now().After(s.expiresAt) {
		return orgState{}, false
	}
	return s, true
}

func (c *cache) set(orgID string, s orgState) {
	c.mu.Lock()
	if c.m == nil {
		c.m = map[string]orgState{}
	}
	c.m[orgID] = s
	c.mu.Unlock()
}

// Middleware returns a chi-compatible middleware that gates traffic
// according to each org's frozen / deleted flags.
func Middleware(db *pgxpool.Pool) func(http.Handler) http.Handler {
	c := &cache{}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
			if claims == nil || claims.OrgID == "" {
				next.ServeHTTP(w, r)
				return
			}
			// Super-admin bypasses the gate entirely — they need to
			// mutate frozen/deleted orgs to recover them.
			if claims.IsSuperAdmin() {
				next.ServeHTTP(w, r)
				return
			}

			s, ok := c.get(claims.OrgID)
			if !ok {
				var frozenAt, deletedAt *time.Time
				err := db.QueryRow(r.Context(),
					`SELECT frozen_at, deleted_at FROM organizations WHERE id=$1`,
					claims.OrgID,
				).Scan(&frozenAt, &deletedAt)
				if err != nil {
					// Don't fail-open silently, but don't take down the
					// whole API on a transient DB error either — fall
					// through. The next request retries.
					next.ServeHTTP(w, r)
					return
				}
				s = orgState{
					frozen:    frozenAt != nil,
					deleted:   deletedAt != nil,
					expiresAt: time.Now().Add(cacheTTL),
				}
				c.set(claims.OrgID, s)
			}

			if s.deleted {
				http.Error(w,
					`{"error":{"code":"org_deleted","message":"this workspace has been deleted"}}`,
					http.StatusGone)
				return
			}
			if s.frozen && !isReadOnly(r.Method) {
				http.Error(w,
					`{"error":{"code":"org_frozen","message":"this workspace is frozen — contact support"}}`,
					http.StatusLocked)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func isReadOnly(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return false
}
