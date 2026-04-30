package billing

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Phase 4 (migration 052) made org_memberships the canonical source of
// truth for "is this user in this org". Seat counting reads memberships
// directly — the legacy MULTI_ORG_SEATS env flag is gone. Every user
// has a primary-org membership (the migration's invariant assertion
// guarantees it), so the count matches the old `users WHERE org_id=$1`
// behavior for single-org tenants while correctly including cross-org
// members for multi-org ones.

// LimitError is returned by the enforcement helpers when an action would
// exceed the org's plan ceiling. The HTTP code is encoded in `Status`
// so handlers can write the right response without re-deriving it.
//
// Codes the frontend may surface:
//   - "subscription_required" — trial expired, no paid sub; show the
//     paywall and route the admin to /settings/billing to pick a plan
//   - "seat_limit"             — over the seat ceiling for the plan
//   - "storage_limit"          — over the storage ceiling for the plan
//   - "feature_locked"         — feature not in the plan's `features` JSON
type LimitError struct {
	Code    string
	Message string
	Status  int
	Hint    string // optional remediation hint shown in the toast
}

func (e *LimitError) Error() string { return e.Message }

// IsLimitError unwraps to a *LimitError so handlers can branch.
func IsLimitError(err error) (*LimitError, bool) {
	var le *LimitError
	if errors.As(err, &le) {
		return le, true
	}
	return nil, false
}

// trialExpiredError is the canonical 402 returned to writes when an
// org's trial has lapsed and no paid subscription has taken its place.
// Centralised here so the message + hint stay consistent across every
// gated entry point.
func trialExpiredError() *LimitError {
	return &LimitError{
		Code:    "subscription_required",
		Status:  402,
		Message: "your trial has ended; choose a plan to continue",
		Hint:    "Pick a plan on /settings/billing to unblock uploads, invites, and integrations.",
	}
}

// EnsureSubscriptionActive returns subscription_required when the org
// has used its one-time trial and has no active paid subscription. Any
// caller about to do a write that isn't already covered by
// EnsureStorageAvailable / EnsureSeatAvailable / RequireFeature should
// call this first.
//
// Falls open on lookup errors — same defensive pattern as the other
// helpers; we never want a DB hiccup to wedge the whole app.
func EnsureSubscriptionActive(ctx context.Context, db *pgxpool.Pool, orgID string) error {
	limits, err := LoadOrgLimits(ctx, db, orgID)
	if err != nil {
		return nil
	}
	if limits.RequiresUpgrade {
		return trialExpiredError()
	}
	return nil
}

// EnsureSeatAvailable checks whether an org can add one more user.
// `additional` is the number of seats about to be created (1 for a
// single invite, N for a bulk import). Pass 0 to just probe the limit.
func EnsureSeatAvailable(ctx context.Context, db *pgxpool.Pool, orgID string, additional int) error {
	limits, err := LoadOrgLimits(ctx, db, orgID)
	if err != nil {
		return nil // fall open on lookup error — never block on infra hiccups
	}
	if limits.RequiresUpgrade {
		return trialExpiredError()
	}
	if limits.MaxUsers == nil {
		return nil // unlimited
	}
	// Seat count: distinct members of this org, sourced from
	// org_memberships. A user that's a member of two orgs counts once
	// against each org's cap, which is the intended billing semantic
	// (each org pays for its own seats). The migration-052 invariant
	// guarantees every user has at least their primary-org membership
	// row, so this never under-counts vs the legacy `users WHERE
	// org_id=$1` path.
	var count int
	if err := db.QueryRow(ctx,
		`SELECT COUNT(DISTINCT user_id) FROM org_memberships WHERE org_id=$1`,
		orgID,
	).Scan(&count); err != nil {
		return nil
	}
	// Pending invites count too — otherwise an admin could blow past
	// the cap by sending a bunch of invites and waiting for them to land.
	var pending int
	_ = db.QueryRow(ctx,
		`SELECT COUNT(*) FROM invitations
		   WHERE org_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL
		     AND (expires_at IS NULL OR expires_at > now())`,
		orgID,
	).Scan(&pending)
	used := count + pending
	if used+additional > *limits.MaxUsers {
		return &LimitError{
			Code:   "seat_limit",
			Status: 402,
			Message: fmt.Sprintf("plan allows %d seats; %d in use",
				*limits.MaxUsers, used),
			Hint: "Upgrade your plan or remove existing members to add more.",
		}
	}
	return nil
}

// EnsureStorageAvailable rejects an upload that would push the org's
// total active storage past the plan ceiling. `addBytes` is the size
// of the about-to-be-uploaded file.
func EnsureStorageAvailable(ctx context.Context, db *pgxpool.Pool, orgID string, addBytes int64) error {
	limits, err := LoadOrgLimits(ctx, db, orgID)
	if err != nil {
		return nil
	}
	if limits.RequiresUpgrade {
		return trialExpiredError()
	}
	if limits.MaxStorageBytes == nil {
		return nil
	}
	var used int64
	_ = db.QueryRow(ctx,
		`SELECT COALESCE(SUM(size),0)
		   FROM files
		  WHERE org_id=$1 AND trashed_at IS NULL`,
		orgID,
	).Scan(&used)
	if used+addBytes > *limits.MaxStorageBytes {
		return &LimitError{
			Code:   "storage_limit",
			Status: 402,
			Message: fmt.Sprintf("plan allows %.0f GB; %.2f GB used",
				float64(*limits.MaxStorageBytes)/(1024*1024*1024),
				float64(used)/(1024*1024*1024)),
			Hint: "Upgrade your plan or empty trash to free space.",
		}
	}
	return nil
}

// RequireFeature gates a code path on a boolean feature flag from the
// plan's `features` JSONB. Pro/Enterprise typically unlock api_keys,
// webhooks, sso, sla.
func RequireFeature(ctx context.Context, db *pgxpool.Pool, orgID, feature string) error {
	limits, err := LoadOrgLimits(ctx, db, orgID)
	if err != nil {
		return nil
	}
	if limits.RequiresUpgrade {
		return trialExpiredError()
	}
	v, ok := limits.Features[feature].(bool)
	if !ok || !v {
		return &LimitError{
			Code:    "feature_locked",
			Status:  402,
			Message: feature + " is not included on your plan",
			Hint:    "Upgrade to unlock this feature.",
		}
	}
	return nil
}
