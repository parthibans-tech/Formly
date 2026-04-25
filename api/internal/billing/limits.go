package billing

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// LimitError is returned by the enforcement helpers when an action would
// exceed the org's plan ceiling. The HTTP code is encoded in `Status`
// so handlers can write the right response without re-deriving it.
type LimitError struct {
	Code    string // machine code: "seat_limit", "storage_limit", "feature_locked"
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

// EnsureSeatAvailable checks whether an org can add one more user.
// `additional` is the number of seats about to be created (1 for a
// single invite, N for a bulk import). Pass 0 to just probe the limit.
func EnsureSeatAvailable(ctx context.Context, db *pgxpool.Pool, orgID string, additional int) error {
	limits, err := LoadOrgLimits(ctx, db, orgID)
	if err != nil {
		return nil // fall open on lookup error — never block on infra hiccups
	}
	if limits.MaxUsers == nil {
		return nil // unlimited
	}
	var count int
	if err := db.QueryRow(ctx,
		`SELECT COUNT(*) FROM users WHERE org_id=$1`, orgID,
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
