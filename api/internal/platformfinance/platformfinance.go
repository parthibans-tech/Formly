// Package platformfinance powers the super-admin "Revenue & Expenses"
// console — a single P&L view of the product across every workspace.
//
// What "revenue" means here
// -------------------------
// Anything in the existing `invoices` table with status='paid'.
// Multi-currency: invoices carry a currency column (INR / USD), so we
// never silently sum across currencies. Every total is reported per
// currency and the UI lays them out side by side.
//
// What "expense" means here
// -------------------------
// Operator-tracked rows in the new `expenses` table (see migration
// 053_expenses.sql). Categories are free-text — the UI suggests a
// canonical list (infrastructure, payroll, software, marketing,
// payment_fees, taxes, legal, office, other) but won't reject a
// custom one. Recurring rows (monthly / quarterly / yearly) are
// normalised into a monthly run rate the same way subscriptions are
// for MRR.
//
// Surface
// -------
//
//	GET    /v1/admin/finance/overview        — KPIs, MRR, MRE, by-currency
//	                                           and by-category totals,
//	                                           daily/weekly time series,
//	                                           top vendors + top paying
//	                                           orgs.
//	GET    /v1/admin/finance/expenses        — list (filter + paginate)
//	POST   /v1/admin/finance/expenses        — create
//	PATCH  /v1/admin/finance/expenses/{id}   — update
//	DELETE /v1/admin/finance/expenses/{id}   — soft delete
//	GET    /v1/admin/finance/export.csv      — line-item export of both
//	                                           invoices and expenses
//
// Authorization: every route mounts behind requireSuperAdmin in
// cmd/api/main.go. Handlers don't re-check; state-changing actions
// write a `super_admin.finance.*` audit row.
package platformfinance

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

// -----------------------------------------------------------------------
// Overview
// -----------------------------------------------------------------------

// resolveWindow picks the (days, bucket) pair from ?window=. Mirrors
// the conventions used in platformanalytics so the UI shares its window
// selector.
func resolveWindow(r *http.Request) (days int, bucket string) {
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("window"))) {
	case "7d":
		return 7, "day"
	case "90d":
		return 90, "week"
	case "180d":
		return 180, "week"
	case "365d":
		return 365, "month"
	}
	return 30, "day"
}

type kvCents struct {
	Label    string `json:"label"`
	Currency string `json:"currency"`
	Cents    int64  `json:"cents"`
}

type kvCount struct {
	Label string `json:"label"`
	Count int64  `json:"count"`
	Cents int64  `json:"cents"`
}

type seriesPoint struct {
	Bucket       string `json:"bucket"`
	RevenueCents int64  `json:"revenueCents"`
	ExpenseCents int64  `json:"expenseCents"`
}

// Overview returns a single-shot snapshot for the /admin/finance
// landing page. All money is bucketed by currency — we never sum
// across currencies because there's no FX layer.
//
// GET /v1/admin/finance/overview?window=30d|7d|90d|180d|365d
func (h *Handler) Overview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	days, bucket := resolveWindow(r)

	out := map[string]any{
		"window":    fmt.Sprintf("%dd", days),
		"bucket":    bucket,
		"generated": time.Now().UTC().Format(time.RFC3339),
	}

	// ---- Revenue side -----------------------------------------------

	// Total paid revenue in window, per currency.
	revenueByCurrency := []kvCents{}
	if rows, err := h.DB.Query(ctx, `
		SELECT currency, COALESCE(SUM(total_cents),0)::bigint
		  FROM invoices
		 WHERE status='paid'
		   AND issued_at > now() - ($1 || ' days')::interval
		 GROUP BY currency
		 ORDER BY 2 DESC`, days); err == nil {
		defer rows.Close()
		for rows.Next() {
			var c string
			var n int64
			if rows.Scan(&c, &n) == nil {
				revenueByCurrency = append(revenueByCurrency, kvCents{
					Label: c, Currency: c, Cents: n,
				})
			}
		}
	}
	out["revenueByCurrency"] = revenueByCurrency

	// Refunds / writeoffs: invoices that ended up void or
	// uncollectible inside the window. Operators want this visible
	// because it eats into the headline revenue number.
	writeoffByCurrency := []kvCents{}
	if rows, err := h.DB.Query(ctx, `
		SELECT currency, COALESCE(SUM(total_cents),0)::bigint
		  FROM invoices
		 WHERE status IN ('void','uncollectible')
		   AND issued_at > now() - ($1 || ' days')::interval
		 GROUP BY currency
		 ORDER BY 2 DESC`, days); err == nil {
		defer rows.Close()
		for rows.Next() {
			var c string
			var n int64
			if rows.Scan(&c, &n) == nil {
				writeoffByCurrency = append(writeoffByCurrency, kvCents{
					Label: c, Currency: c, Cents: n,
				})
			}
		}
	}
	out["writeoffByCurrency"] = writeoffByCurrency

	// MRR — same calc as platformdashboard.Get(): sum active +
	// trialing + past_due plan amounts, normalising yearly to
	// monthly (annual / 12). Per currency.
	mrr := []kvCents{}
	if rows, err := h.DB.Query(ctx, `
		SELECT s.currency,
		       COALESCE(SUM(CASE WHEN p.interval='year'
		                         THEN p.amount_cents / 12
		                         ELSE p.amount_cents END), 0)::bigint
		  FROM subscriptions s
		  JOIN plans p ON p.id = s.plan_id
		 WHERE s.status IN ('active','trialing','past_due')
		   AND p.amount_cents IS NOT NULL
		 GROUP BY s.currency
		 ORDER BY 2 DESC`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var c string
			var n int64
			if rows.Scan(&c, &n) == nil {
				mrr = append(mrr, kvCents{Label: c, Currency: c, Cents: n})
			}
		}
	}
	out["mrr"] = mrr

	// ARR is just MRR * 12 — compute on the server so the UI doesn't
	// need to know the convention.
	arr := make([]kvCents, 0, len(mrr))
	for _, m := range mrr {
		arr = append(arr, kvCents{Label: m.Label, Currency: m.Currency, Cents: m.Cents * 12})
	}
	out["arr"] = arr

	// Subscription state breakdown (count by status). Useful as a
	// leading indicator — a spike in past_due predicts revenue dip.
	subStates := []kvCount{}
	if rows, err := h.DB.Query(ctx, `
		SELECT status, COUNT(*)::bigint, 0::bigint
		  FROM subscriptions
		 GROUP BY status
		 ORDER BY 2 DESC`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var k kvCount
			if rows.Scan(&k.Label, &k.Count, &k.Cents) == nil {
				subStates = append(subStates, k)
			}
		}
	}
	out["subscriptionStates"] = subStates

	// Top paying orgs in window, joined to organizations for the
	// display name. Cap 10. Per (org, currency) — a single org can
	// pay in multiple currencies (rare but possible after a region
	// migration).
	type topOrg struct {
		OrgID    string `json:"orgId"`
		OrgName  string `json:"orgName"`
		Currency string `json:"currency"`
		Cents    int64  `json:"cents"`
		Invoices int64  `json:"invoices"`
	}
	topOrgs := []topOrg{}
	if rows, err := h.DB.Query(ctx, `
		SELECT i.org_id::text,
		       COALESCE(o.name,''),
		       i.currency,
		       COALESCE(SUM(i.total_cents),0)::bigint,
		       COUNT(*)::bigint
		  FROM invoices i
		  LEFT JOIN organizations o ON o.id = i.org_id
		 WHERE i.status='paid'
		   AND i.issued_at > now() - ($1 || ' days')::interval
		 GROUP BY i.org_id, o.name, i.currency
		 ORDER BY 4 DESC
		 LIMIT 10`, days); err == nil {
		defer rows.Close()
		for rows.Next() {
			var t topOrg
			if rows.Scan(&t.OrgID, &t.OrgName, &t.Currency, &t.Cents, &t.Invoices) == nil {
				topOrgs = append(topOrgs, t)
			}
		}
	}
	out["topPayingOrgs"] = topOrgs

	// Plan-tier mix of paid revenue. Joined to subscriptions to
	// resolve the tier (free invoices won't appear since there's no
	// money in them).
	planMix := []kvCents{}
	if rows, err := h.DB.Query(ctx, `
		SELECT COALESCE(p.tier, 'unknown') AS tier,
		       i.currency,
		       COALESCE(SUM(i.total_cents),0)::bigint
		  FROM invoices i
		  LEFT JOIN subscriptions s ON s.id = i.subscription_id
		  LEFT JOIN plans p ON p.id = s.plan_id
		 WHERE i.status='paid'
		   AND i.issued_at > now() - ($1 || ' days')::interval
		 GROUP BY p.tier, i.currency
		 ORDER BY 3 DESC`, days); err == nil {
		defer rows.Close()
		for rows.Next() {
			var k kvCents
			if rows.Scan(&k.Label, &k.Currency, &k.Cents) == nil {
				planMix = append(planMix, k)
			}
		}
	}
	out["planMix"] = planMix

	// ---- Expense side -----------------------------------------------

	expenseByCurrency := []kvCents{}
	if rows, err := h.DB.Query(ctx, `
		SELECT currency, COALESCE(SUM(amount_cents),0)::bigint
		  FROM expenses
		 WHERE deleted_at IS NULL
		   AND occurred_on > current_date - ($1 || ' days')::interval
		 GROUP BY currency
		 ORDER BY 2 DESC`, days); err == nil {
		defer rows.Close()
		for rows.Next() {
			var c string
			var n int64
			if rows.Scan(&c, &n) == nil {
				expenseByCurrency = append(expenseByCurrency, kvCents{
					Label: c, Currency: c, Cents: n,
				})
			}
		}
	}
	out["expenseByCurrency"] = expenseByCurrency

	// Monthly Recurring Expense (MRE): the operator-side mirror of
	// MRR. Recurring rows normalise to a per-month figure; one_time
	// rows don't contribute. Per currency.
	mre := []kvCents{}
	if rows, err := h.DB.Query(ctx, `
		SELECT currency,
		       COALESCE(SUM(
		         CASE recurrence
		           WHEN 'monthly'   THEN amount_cents
		           WHEN 'quarterly' THEN amount_cents / 3
		           WHEN 'yearly'    THEN amount_cents / 12
		           ELSE 0
		         END
		       ), 0)::bigint
		  FROM expenses
		 WHERE deleted_at IS NULL
		   AND recurrence <> 'one_time'
		 GROUP BY currency
		 ORDER BY 2 DESC`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var c string
			var n int64
			if rows.Scan(&c, &n) == nil {
				mre = append(mre, kvCents{Label: c, Currency: c, Cents: n})
			}
		}
	}
	out["mre"] = mre

	// Expense breakdown by category, per currency.
	expenseByCategory := []kvCents{}
	if rows, err := h.DB.Query(ctx, `
		SELECT category, currency, COALESCE(SUM(amount_cents),0)::bigint
		  FROM expenses
		 WHERE deleted_at IS NULL
		   AND occurred_on > current_date - ($1 || ' days')::interval
		 GROUP BY category, currency
		 ORDER BY 3 DESC`, days); err == nil {
		defer rows.Close()
		for rows.Next() {
			var k kvCents
			if rows.Scan(&k.Label, &k.Currency, &k.Cents) == nil {
				expenseByCategory = append(expenseByCategory, k)
			}
		}
	}
	out["expenseByCategory"] = expenseByCategory

	// Top vendors by spend in window.
	type topVendor struct {
		Vendor   string `json:"vendor"`
		Currency string `json:"currency"`
		Cents    int64  `json:"cents"`
		Entries  int64  `json:"entries"`
	}
	topVendors := []topVendor{}
	if rows, err := h.DB.Query(ctx, `
		SELECT NULLIF(vendor,'') AS v,
		       currency,
		       COALESCE(SUM(amount_cents),0)::bigint,
		       COUNT(*)::bigint
		  FROM expenses
		 WHERE deleted_at IS NULL
		   AND occurred_on > current_date - ($1 || ' days')::interval
		   AND COALESCE(vendor,'') <> ''
		 GROUP BY v, currency
		 ORDER BY 3 DESC
		 LIMIT 10`, days); err == nil {
		defer rows.Close()
		for rows.Next() {
			var v topVendor
			if rows.Scan(&v.Vendor, &v.Currency, &v.Cents, &v.Entries) == nil {
				topVendors = append(topVendors, v)
			}
		}
	}
	out["topVendors"] = topVendors

	// ---- Time series (revenue + expense, same buckets) --------------
	//
	// Done as two queries that share the same bucket grain so the UI
	// can stack them without alignment work. Currency-collapsed at
	// this point (operator wants the trend, the per-currency split
	// lives in the headline cards above).
	revPoints := bucketSum(ctx, h.DB, `
		SELECT date_trunc($2, issued_at) AS b,
		       COALESCE(SUM(total_cents),0)::bigint
		  FROM invoices
		 WHERE status='paid'
		   AND issued_at > now() - ($1 || ' days')::interval
		 GROUP BY b ORDER BY b ASC`, days, bucket)
	expPoints := bucketSum(ctx, h.DB, `
		SELECT date_trunc($2, occurred_on)::timestamptz AS b,
		       COALESCE(SUM(amount_cents),0)::bigint
		  FROM expenses
		 WHERE deleted_at IS NULL
		   AND occurred_on > current_date - ($1 || ' days')::interval
		 GROUP BY b ORDER BY b ASC`, days, bucket)
	out["timeSeries"] = mergeSeries(revPoints, expPoints)

	// ---- Net & margin per currency ----------------------------------
	//
	// We don't sum across currencies (no FX). We compute net per
	// currency by joining the two maps; missing currencies on either
	// side default to zero.
	type netRow struct {
		Currency      string  `json:"currency"`
		RevenueCents  int64   `json:"revenueCents"`
		ExpenseCents  int64   `json:"expenseCents"`
		NetCents      int64   `json:"netCents"`
		MarginPercent float64 `json:"marginPercent"`
	}
	curr := map[string]*netRow{}
	for _, r := range revenueByCurrency {
		curr[r.Currency] = &netRow{Currency: r.Currency, RevenueCents: r.Cents}
	}
	for _, e := range expenseByCurrency {
		if v, ok := curr[e.Currency]; ok {
			v.ExpenseCents = e.Cents
		} else {
			curr[e.Currency] = &netRow{Currency: e.Currency, ExpenseCents: e.Cents}
		}
	}
	netRows := make([]netRow, 0, len(curr))
	for _, v := range curr {
		v.NetCents = v.RevenueCents - v.ExpenseCents
		if v.RevenueCents > 0 {
			v.MarginPercent = float64(v.NetCents) / float64(v.RevenueCents) * 100
		}
		netRows = append(netRows, *v)
	}
	out["netByCurrency"] = netRows

	// Recent invoices + recent expenses for the activity feed at the
	// bottom of the page.
	type recentInvoice struct {
		ID        string `json:"id"`
		Number    string `json:"number"`
		OrgName   string `json:"orgName"`
		Currency  string `json:"currency"`
		Cents     int64  `json:"cents"`
		Status    string `json:"status"`
		IssuedAt  string `json:"issuedAt"`
	}
	recInv := []recentInvoice{}
	if rows, err := h.DB.Query(ctx, `
		SELECT i.id::text, i.number, COALESCE(o.name,''), i.currency,
		       i.total_cents, i.status, i.issued_at
		  FROM invoices i
		  LEFT JOIN organizations o ON o.id = i.org_id
		 ORDER BY i.issued_at DESC
		 LIMIT 8`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var r recentInvoice
			var at time.Time
			if rows.Scan(&r.ID, &r.Number, &r.OrgName, &r.Currency,
				&r.Cents, &r.Status, &at) == nil {
				r.IssuedAt = at.UTC().Format(time.RFC3339)
				recInv = append(recInv, r)
			}
		}
	}
	out["recentInvoices"] = recInv

	type recentExpense struct {
		ID         string `json:"id"`
		Category   string `json:"category"`
		Vendor     string `json:"vendor"`
		Currency   string `json:"currency"`
		Cents      int64  `json:"cents"`
		Recurrence string `json:"recurrence"`
		OccurredOn string `json:"occurredOn"`
	}
	recExp := []recentExpense{}
	if rows, err := h.DB.Query(ctx, `
		SELECT id::text, category, vendor, currency, amount_cents,
		       recurrence, occurred_on
		  FROM expenses
		 WHERE deleted_at IS NULL
		 ORDER BY occurred_on DESC, created_at DESC
		 LIMIT 8`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var r recentExpense
			var occ time.Time
			if rows.Scan(&r.ID, &r.Category, &r.Vendor, &r.Currency,
				&r.Cents, &r.Recurrence, &occ) == nil {
				r.OccurredOn = occ.Format("2006-01-02")
				recExp = append(recExp, r)
			}
		}
	}
	out["recentExpenses"] = recExp

	writeJSON(w, 200, out)
}

// bucketSum runs a (timestamp bucket, sum) query whose first two
// positional args are $1=days and $2=bucket. Returns []bucketed.
type bucketed struct {
	At    time.Time
	Cents int64
}

func bucketSum(ctx pgxCtx, db *pgxpool.Pool, sql string, days int, bucket string) []bucketed {
	rows, err := db.Query(ctx, sql, days, bucket)
	if err != nil {
		return []bucketed{}
	}
	defer rows.Close()
	out := []bucketed{}
	for rows.Next() {
		var b bucketed
		if rows.Scan(&b.At, &b.Cents) == nil {
			out = append(out, b)
		}
	}
	return out
}

// mergeSeries takes two bucketed series (revenue, expense) and zips
// them onto a shared sorted bucket axis. Missing buckets on either
// side become zero.
func mergeSeries(rev, exp []bucketed) []seriesPoint {
	// Build a sorted unique key set.
	idx := map[string]*seriesPoint{}
	keys := []string{}
	add := func(at time.Time) string {
		k := at.UTC().Format(time.RFC3339)
		if _, ok := idx[k]; !ok {
			idx[k] = &seriesPoint{Bucket: k}
			keys = append(keys, k)
		}
		return k
	}
	for _, p := range rev {
		k := add(p.At)
		idx[k].RevenueCents = p.Cents
	}
	for _, p := range exp {
		k := add(p.At)
		idx[k].ExpenseCents = p.Cents
	}
	// Sort by bucket time.
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	out := make([]seriesPoint, 0, len(keys))
	for _, k := range keys {
		out = append(out, *idx[k])
	}
	return out
}

// pgxCtx is a tiny alias so bucketSum can take either a request
// context or background — keeps the call site clean.
type pgxCtx = interface {
	Done() <-chan struct{}
	Err() error
	Value(any) any
	Deadline() (time.Time, bool)
}

// -----------------------------------------------------------------------
// Expenses — list / create / update / delete
// -----------------------------------------------------------------------

type expenseRow struct {
	ID          string `json:"id"`
	Category    string `json:"category"`
	Vendor      string `json:"vendor"`
	AmountCents int64  `json:"amountCents"`
	Currency    string `json:"currency"`
	OccurredOn  string `json:"occurredOn"`
	Recurrence  string `json:"recurrence"`
	Notes       string `json:"notes"`
	CreatedBy   string `json:"createdBy,omitempty"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

// ListExpenses paginates the expense ledger. Filters supported:
//
//	category, currency, recurrence, vendor (substring),
//	from, to (YYYY-MM-DD inclusive), limit (default 100, cap 500).
//
// GET /v1/admin/finance/expenses
func (h *Handler) ListExpenses(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 100
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n > 500 {
				n = 500
			}
			limit = n
		}
	}
	conds := []string{"deleted_at IS NULL"}
	args := []any{}
	add := func(cond string, val any) {
		args = append(args, val)
		conds = append(conds, strings.ReplaceAll(cond, "$?", "$"+strconv.Itoa(len(args))))
	}
	if v := strings.TrimSpace(q.Get("category")); v != "" {
		add("category = $?", v)
	}
	if v := strings.TrimSpace(q.Get("currency")); v != "" {
		add("currency = $?", v)
	}
	if v := strings.TrimSpace(q.Get("recurrence")); v != "" {
		add("recurrence = $?", v)
	}
	if v := strings.TrimSpace(q.Get("vendor")); v != "" {
		add("vendor ILIKE $?", "%"+v+"%")
	}
	if v := strings.TrimSpace(q.Get("from")); v != "" {
		add("occurred_on >= $?::date", v)
	}
	if v := strings.TrimSpace(q.Get("to")); v != "" {
		add("occurred_on <= $?::date", v)
	}
	args = append(args, limit)
	limitPH := "$" + strconv.Itoa(len(args))

	sql := `
		SELECT id::text, category, COALESCE(vendor,''), amount_cents,
		       currency, occurred_on, recurrence, COALESCE(notes,''),
		       COALESCE(created_by::text,''), created_at, updated_at
		  FROM expenses
		 WHERE ` + strings.Join(conds, " AND ") + `
		 ORDER BY occurred_on DESC, created_at DESC
		 LIMIT ` + limitPH
	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []expenseRow{}
	for rows.Next() {
		var x expenseRow
		var occ, created, updated time.Time
		if err := rows.Scan(&x.ID, &x.Category, &x.Vendor, &x.AmountCents,
			&x.Currency, &occ, &x.Recurrence, &x.Notes,
			&x.CreatedBy, &created, &updated); err != nil {
			continue
		}
		x.OccurredOn = occ.Format("2006-01-02")
		x.CreatedAt = created.UTC().Format(time.RFC3339)
		x.UpdatedAt = updated.UTC().Format(time.RFC3339)
		out = append(out, x)
	}

	// Roll-up summary so the UI can show "X rows · ₹Y · $Z" without
	// re-aggregating client-side.
	type sumRow struct {
		Currency string `json:"currency"`
		Cents    int64  `json:"cents"`
	}
	sums := []sumRow{}
	{
		// Same WHERE, no LIMIT.
		sumSQL := `SELECT currency, COALESCE(SUM(amount_cents),0)::bigint
		             FROM expenses
		            WHERE ` + strings.Join(conds, " AND ") + `
		            GROUP BY currency ORDER BY 2 DESC`
		// args has the limit appended; strip it.
		sumArgs := args[:len(args)-1]
		if rows2, err := h.DB.Query(r.Context(), sumSQL, sumArgs...); err == nil {
			defer rows2.Close()
			for rows2.Next() {
				var s sumRow
				if rows2.Scan(&s.Currency, &s.Cents) == nil {
					sums = append(sums, s)
				}
			}
		}
	}
	writeJSON(w, 200, map[string]any{
		"expenses": out,
		"totals":   sums,
	})
}

type expenseUpsertReq struct {
	Category    string `json:"category"`
	Vendor      string `json:"vendor"`
	AmountCents int64  `json:"amountCents"`
	Currency    string `json:"currency"`
	OccurredOn  string `json:"occurredOn"` // YYYY-MM-DD
	Recurrence  string `json:"recurrence"`
	Notes       string `json:"notes"`
}

// validateUpsert returns ("", row) on success or (slug, _) on failure.
// Centralises every cheap-but-important field check so create and
// update share the same rules.
func validateUpsert(req *expenseUpsertReq) string {
	req.Category = strings.TrimSpace(req.Category)
	req.Vendor = strings.TrimSpace(req.Vendor)
	req.Currency = strings.ToUpper(strings.TrimSpace(req.Currency))
	req.Recurrence = strings.ToLower(strings.TrimSpace(req.Recurrence))
	if req.Recurrence == "" {
		req.Recurrence = "one_time"
	}
	if req.Currency == "" {
		req.Currency = "INR"
	}
	if req.Category == "" {
		return "missing_category"
	}
	if req.AmountCents < 0 {
		return "invalid_amount"
	}
	switch req.Recurrence {
	case "one_time", "monthly", "quarterly", "yearly":
	default:
		return "invalid_recurrence"
	}
	if req.OccurredOn != "" {
		if _, err := time.Parse("2006-01-02", req.OccurredOn); err != nil {
			return "invalid_date"
		}
	}
	return ""
}

// CreateExpense inserts an operator-tracked expense row.
//
// POST /v1/admin/finance/expenses
func (h *Handler) CreateExpense(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req expenseUpsertReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if slug := validateUpsert(&req); slug != "" {
		writeErr(w, 400, slug, slug)
		return
	}
	occurred := time.Now().UTC()
	if req.OccurredOn != "" {
		t, _ := time.Parse("2006-01-02", req.OccurredOn)
		occurred = t
	}
	var creator any
	if c != nil && c.UserID != "" {
		creator = c.UserID
	}
	var id string
	err := h.DB.QueryRow(r.Context(), `
		INSERT INTO expenses (
		  category, vendor, amount_cents, currency,
		  occurred_on, recurrence, notes, created_by
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid)
		RETURNING id::text`,
		req.Category, req.Vendor, req.AmountCents, req.Currency,
		occurred, req.Recurrence, req.Notes, creator,
	).Scan(&id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	audit.LogHTTP(r, h.DB, "super_admin.finance.expense.create", "expense", id,
		map[string]any{
			"category":    req.Category,
			"vendor":      req.Vendor,
			"amountCents": req.AmountCents,
			"currency":    req.Currency,
			"recurrence":  req.Recurrence,
		})
	writeJSON(w, 201, map[string]any{"ok": true, "id": id})
}

// UpdateExpense edits an existing entry. Refuses if the row was
// soft-deleted (the UI should restore it via a separate call).
//
// PATCH /v1/admin/finance/expenses/{id}
func (h *Handler) UpdateExpense(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req expenseUpsertReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if slug := validateUpsert(&req); slug != "" {
		writeErr(w, 400, slug, slug)
		return
	}
	occurred := time.Now().UTC()
	if req.OccurredOn != "" {
		t, _ := time.Parse("2006-01-02", req.OccurredOn)
		occurred = t
	}
	tag, err := h.DB.Exec(r.Context(), `
		UPDATE expenses
		   SET category=$2, vendor=$3, amount_cents=$4, currency=$5,
		       occurred_on=$6, recurrence=$7, notes=$8, updated_at=now()
		 WHERE id=$1::uuid AND deleted_at IS NULL`,
		id, req.Category, req.Vendor, req.AmountCents, req.Currency,
		occurred, req.Recurrence, req.Notes)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "expense not found")
		return
	}
	audit.LogHTTP(r, h.DB, "super_admin.finance.expense.update", "expense", id,
		map[string]any{
			"category":    req.Category,
			"vendor":      req.Vendor,
			"amountCents": req.AmountCents,
			"currency":    req.Currency,
			"recurrence":  req.Recurrence,
		})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// DeleteExpense soft-deletes (sets deleted_at). Hard-delete would
// strand audit_log references; soft-delete preserves the trail.
//
// DELETE /v1/admin/finance/expenses/{id}
func (h *Handler) DeleteExpense(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(),
		`UPDATE expenses SET deleted_at=now() WHERE id=$1::uuid AND deleted_at IS NULL`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "expense not found or already deleted")
		return
	}
	audit.LogHTTP(r, h.DB, "super_admin.finance.expense.delete", "expense", id, nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -----------------------------------------------------------------------
// CSV export
// -----------------------------------------------------------------------

// ExportCSV streams a single P&L line-item file: every paid invoice
// and every active expense in the window, each row carrying a `kind`
// column so the operator can pivot in their spreadsheet of choice.
//
// GET /v1/admin/finance/export.csv?window=30d
func (h *Handler) ExportCSV(w http.ResponseWriter, r *http.Request) {
	days, _ := resolveWindow(r)
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="formly-finance-%dd.csv"`, days))
	cw := csv.NewWriter(w)
	defer cw.Flush()

	_ = cw.Write([]string{
		"kind", "date", "id", "label", "category_or_status",
		"currency", "amount_cents", "vendor_or_org", "notes",
	})

	// Invoices first.
	if rows, err := h.DB.Query(r.Context(), `
		SELECT i.issued_at::date, i.id::text, COALESCE(i.number,''),
		       i.status, i.currency, i.total_cents,
		       COALESCE(o.name,''), ''
		  FROM invoices i
		  LEFT JOIN organizations o ON o.id = i.org_id
		 WHERE i.issued_at > now() - ($1 || ' days')::interval
		 ORDER BY i.issued_at DESC`, days); err == nil {
		defer rows.Close()
		for rows.Next() {
			var dt time.Time
			var id, label, status, currency, vendor, notes string
			var cents int64
			if rows.Scan(&dt, &id, &label, &status, &currency, &cents, &vendor, &notes) != nil {
				continue
			}
			_ = cw.Write([]string{
				"invoice", dt.Format("2006-01-02"), id, label, status,
				currency, strconv.FormatInt(cents, 10), vendor, notes,
			})
		}
	}

	// Then expenses.
	if rows, err := h.DB.Query(r.Context(), `
		SELECT occurred_on, id::text, COALESCE(notes,''),
		       category, currency, amount_cents,
		       COALESCE(vendor,''), recurrence
		  FROM expenses
		 WHERE deleted_at IS NULL
		   AND occurred_on > current_date - ($1 || ' days')::interval
		 ORDER BY occurred_on DESC`, days); err == nil {
		defer rows.Close()
		for rows.Next() {
			var dt time.Time
			var id, notes, category, currency, vendor, recurrence string
			var cents int64
			if rows.Scan(&dt, &id, &notes, &category, &currency, &cents, &vendor, &recurrence) != nil {
				continue
			}
			_ = cw.Write([]string{
				"expense", dt.Format("2006-01-02"), id, notes, category,
				currency, strconv.FormatInt(cents, 10), vendor, recurrence,
			})
		}
	}
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]string{"code": slug, "message": msg},
	})
}

// _ pgx.ErrNoRows is referenced indirectly via QueryRow paths; the
// aliasing keeps the import warning quiet on Go versions that nag
// about "imported and not used" when only the package is referenced.
var _ = pgx.ErrNoRows
var _ = errors.New
