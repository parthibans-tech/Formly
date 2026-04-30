// Package webhooks subscribes to the internal events bus, persists outbound
// HTTP deliveries, and signs request bodies with the subscription's secret.
package webhooks

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/billing"
	"github.com/docforge/api/internal/events"
	"github.com/docforge/api/internal/queue"
	"github.com/go-chi/chi/v5"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MetricsObserver is fired once per delivery attempt with the
// resolved (result, status_code, duration) tuple. main.go wires this
// to the prometheus webhook vectors so this package stays free of
// any prometheus import. result is the bucket label used by the
// counter ("2xx" / "3xx" / "4xx" / "5xx" / "error"), code is the
// raw HTTP status (0 when the request never got a response).
type MetricsObserver func(result string, code int, dur time.Duration)

type Handler struct {
	DB    *pgxpool.Pool
	Queue *asynq.Client

	// observer fires after every ProcessDelivery attempt; nil when
	// metrics aren't wired (tests, dev).
	observer MetricsObserver
}

func New(db *pgxpool.Pool, q *asynq.Client) *Handler {
	return &Handler{DB: db, Queue: q}
}

// SetMetricsObserver attaches a metrics observer. Boot-time only —
// not safe to swap concurrently with in-flight ProcessDelivery calls.
func (h *Handler) SetMetricsObserver(o MetricsObserver) {
	if h == nil {
		return
	}
	h.observer = o
}

// WireEventBus subscribes a fan-out handler to the default events bus. When an
// event fires it looks up every active webhook in the org that subscribes to
// the event's name and enqueues a delivery task per subscription. Lookup runs
// on a short timeout so a slow query can't stall unrelated requests.
func (h *Handler) WireEventBus() {
	events.Subscribe(func(_ context.Context, e events.Event) {
		if h.Queue == nil || h.DB == nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		rows, err := h.DB.Query(ctx, `
			SELECT id FROM webhooks
			 WHERE org_id=$1 AND active=true AND $2 = ANY(events)
		`, e.OrgID, e.Name)
		if err != nil {
			return
		}
		defer rows.Close()
		body, _ := json.Marshal(e)
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				continue
			}
			task, err := queue.NewWebhookDeliver(queue.WebhookDeliverPayload{
				WebhookID: id,
				Event:     e.Name,
				Body:      body,
			})
			if err != nil {
				continue
			}
			_, _ = h.Queue.Enqueue(task, asynq.Queue("default"))
		}
	})
}

// -- HTTP handlers ---------------------------------------------------------

type webhookDTO struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	URL       string   `json:"url"`
	Events    []string `json:"events"`
	Active    bool     `json:"active"`
	CreatedAt string   `json:"createdAt"`
	UpdatedAt string   `json:"updatedAt"`
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, name, url, events, active, created_at, updated_at
		  FROM webhooks WHERE org_id=$1 ORDER BY created_at DESC`, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []webhookDTO{}
	for rows.Next() {
		var (
			id, name, url               string
			evts                        []string
			active                      bool
			createdAt, updatedAt        time.Time
		)
		if err := rows.Scan(&id, &name, &url, &evts, &active, &createdAt, &updatedAt); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		out = append(out, webhookDTO{
			ID:        id,
			Name:      name,
			URL:       url,
			Events:    evts,
			Active:    active,
			CreatedAt: createdAt.Format(time.RFC3339),
			UpdatedAt: updatedAt.Format(time.RFC3339),
		})
	}
	writeJSON(w, 200, map[string]any{"webhooks": out})
}

type createReq struct {
	Name   string   `json:"name"`
	URL    string   `json:"url"`
	Events []string `json:"events"`
	Active *bool    `json:"active"`
}

type createResp struct {
	webhookDTO
	Secret string `json:"secret"` // shown once
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if err := billing.RequireFeature(r.Context(), h.DB, c.OrgID, "webhooks"); err != nil {
		if le, ok := billing.IsLimitError(err); ok {
			writeErr(w, le.Status, le.Code, le.Message)
			return
		}
	}
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.URL = strings.TrimSpace(req.URL)
	if req.Name == "" {
		req.Name = "Untitled webhook"
	}
	if !strings.HasPrefix(strings.ToLower(req.URL), "http://") &&
		!strings.HasPrefix(strings.ToLower(req.URL), "https://") {
		writeErr(w, 400, "bad_url", "url must start with http:// or https://")
		return
	}
	req.Events = validateEvents(req.Events)
	if len(req.Events) == 0 {
		writeErr(w, 400, "no_events", "pick at least one event")
		return
	}
	active := true
	if req.Active != nil {
		active = *req.Active
	}

	secret, err := randomSecret()
	if err != nil {
		writeErr(w, 500, "rand", err.Error())
		return
	}

	var (
		id                   string
		createdAt, updatedAt time.Time
	)
	err = h.DB.QueryRow(r.Context(), `
		INSERT INTO webhooks (org_id, user_id, name, url, secret, events, active)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING id, created_at, updated_at
	`, c.OrgID, c.UserID, req.Name, req.URL, secret, req.Events, active).
		Scan(&id, &createdAt, &updatedAt)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	writeJSON(w, 200, createResp{
		webhookDTO: webhookDTO{
			ID:        id,
			Name:      req.Name,
			URL:       req.URL,
			Events:    req.Events,
			Active:    active,
			CreatedAt: createdAt.Format(time.RFC3339),
			UpdatedAt: updatedAt.Format(time.RFC3339),
		},
		Secret: secret,
	})
}

type updateReq struct {
	Name   *string   `json:"name,omitempty"`
	URL    *string   `json:"url,omitempty"`
	Events *[]string `json:"events,omitempty"`
	Active *bool     `json:"active,omitempty"`
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var req updateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	sets := []string{"updated_at = now()"}
	args := []any{id, c.OrgID}
	n := 3
	if req.Name != nil {
		sets = append(sets, fmt.Sprintf("name=$%d", n))
		args = append(args, *req.Name)
		n++
	}
	if req.URL != nil {
		sets = append(sets, fmt.Sprintf("url=$%d", n))
		args = append(args, *req.URL)
		n++
	}
	if req.Events != nil {
		sets = append(sets, fmt.Sprintf("events=$%d", n))
		args = append(args, validateEvents(*req.Events))
		n++
	}
	if req.Active != nil {
		sets = append(sets, fmt.Sprintf("active=$%d", n))
		args = append(args, *req.Active)
		n++
	}
	sql := fmt.Sprintf(`UPDATE webhooks SET %s WHERE id=$1 AND org_id=$2`, strings.Join(sets, ", "))
	if _, err := h.DB.Exec(r.Context(), sql, args...); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM webhooks WHERE id=$1 AND org_id=$2`, id, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "webhook not found")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// Deliveries returns the recent delivery log for a webhook (most recent first).
func (h *Handler) Deliveries(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	// ownership check
	var ownerOrg string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT org_id FROM webhooks WHERE id=$1`, id).Scan(&ownerOrg); err != nil {
		writeErr(w, 404, "not_found", "webhook not found")
		return
	}
	if ownerOrg != c.OrgID {
		writeErr(w, 404, "not_found", "webhook not found")
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, event, status, attempt, response_code, response_body, error, duration_ms, created_at
		  FROM webhook_deliveries WHERE webhook_id=$1
		 ORDER BY created_at DESC LIMIT 50`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			dID, event, status         string
			attempt                    int
			respCode                   *int
			respBody, errStr           *string
			duration                   *int
			createdAt                  time.Time
		)
		if err := rows.Scan(&dID, &event, &status, &attempt, &respCode, &respBody, &errStr, &duration, &createdAt); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id":           dID,
			"event":        event,
			"status":       status,
			"attempt":      attempt,
			"responseCode": respCode,
			"responseBody": respBody,
			"error":        errStr,
			"durationMs":   duration,
			"createdAt":    createdAt.Format(time.RFC3339),
		})
	}
	writeJSON(w, 200, map[string]any{"deliveries": out})
}

// Test fires a synthetic `webhook.test` event to verify the endpoint is live.
func (h *Handler) Test(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var wh webhook
	if err := h.load(r.Context(), id, c.OrgID, &wh); err != nil {
		writeErr(w, 404, "not_found", "webhook not found")
		return
	}
	payload := events.Event{
		Name:      "webhook.test",
		OrgID:     c.OrgID,
		Timestamp: time.Now(),
		Payload: map[string]interface{}{
			"message": "Hello from Drive360 — your webhook is reachable.",
		},
	}
	body, _ := json.Marshal(payload)
	task, err := queue.NewWebhookDeliver(queue.WebhookDeliverPayload{
		WebhookID: wh.ID,
		Event:     payload.Name,
		Body:      body,
	})
	if err != nil {
		writeErr(w, 500, "rand", err.Error())
		return
	}
	if _, err := h.Queue.Enqueue(task); err != nil {
		writeErr(w, 500, "enqueue", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"queued": true})
}

// Redeliver re-enqueues a specific past delivery using its stored payload.
// Handy from the dashboard when an endpoint was briefly down and the user
// wants to replay the missed event without re-triggering the business
// action that produced it.
func (h *Handler) Redeliver(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	webhookID := chi.URLParam(r, "id")
	deliveryID := chi.URLParam(r, "deliveryId")

	// Ownership: confirm delivery belongs to a webhook in this org.
	var (
		ownerOrg string
		event    string
		body     []byte
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT w.org_id, d.event, d.request_body::text
		  FROM webhook_deliveries d
		  JOIN webhooks w ON w.id = d.webhook_id
		 WHERE d.id=$1 AND d.webhook_id=$2`, deliveryID, webhookID,
	).Scan(&ownerOrg, &event, &body)
	if err != nil {
		writeErr(w, 404, "not_found", "delivery not found")
		return
	}
	if ownerOrg != c.OrgID {
		writeErr(w, 404, "not_found", "delivery not found")
		return
	}

	task, err := queue.NewWebhookDeliver(queue.WebhookDeliverPayload{
		WebhookID: webhookID,
		Event:     event,
		Body:      body,
	})
	if err != nil {
		writeErr(w, 500, "enqueue", err.Error())
		return
	}
	if _, err := h.Queue.Enqueue(task); err != nil {
		writeErr(w, 500, "enqueue", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"queued": true})
}

// -- task handler (called by the asynq worker process) --------------------

type webhook struct {
	ID     string
	URL    string
	Secret string
}

func (h *Handler) load(ctx context.Context, id, orgID string, out *webhook) error {
	return h.DB.QueryRow(ctx,
		`SELECT id, url, secret FROM webhooks WHERE id=$1 AND org_id=$2 AND active=true`,
		id, orgID,
	).Scan(&out.ID, &out.URL, &out.Secret)
}

// ProcessDelivery is registered with the asynq mux in cmd/worker. Returning an
// error triggers asynq's retry with exponential backoff.
func (h *Handler) ProcessDelivery(ctx context.Context, t *asynq.Task) error {
	var p queue.WebhookDeliverPayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("unmarshal: %w", err)
	}

	// Load (even if inactive — attempts during the grace period are fine).
	var wh webhook
	if err := h.DB.QueryRow(ctx,
		`SELECT id, url, secret FROM webhooks WHERE id=$1`, p.WebhookID,
	).Scan(&wh.ID, &wh.URL, &wh.Secret); err != nil {
		if err == pgx.ErrNoRows {
			return nil // webhook deleted — don't retry
		}
		return err
	}

	// Determine attempt number from asynq's built-in counter.
	attempt := 1
	if n, ok := asynq.GetRetryCount(ctx); ok {
		attempt = n + 1
	}

	// Sign + deliver.
	status, code, respBody, deliverErr, dur := deliver(ctx, wh.URL, wh.Secret, p.Body)

	// Record delivery — best-effort; failure to log shouldn't break retries.
	_, _ = h.DB.Exec(ctx, `
		INSERT INTO webhook_deliveries
		  (webhook_id, event, status, attempt, request_body, response_code, response_body, error, duration_ms)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
	`, p.WebhookID, p.Event, status, attempt, p.Body, code, respBody, errString(deliverErr), int(dur.Milliseconds()))

	// Metrics observer — bucket on the HTTP status class, or "error"
	// when there was no response at all. Fired after the audit row
	// lands so a metric uptick always corresponds to a webhook_deliveries row.
	if h.observer != nil {
		h.observer(deliveryResultBucket(code, deliverErr), code, dur)
	}

	// Returning a non-nil error tells asynq to retry.
	if status != "success" {
		if deliverErr != nil {
			return deliverErr
		}
		return fmt.Errorf("non-2xx response: %d", code)
	}
	return nil
}

// deliveryResultBucket maps a (code, err) pair to the same status-class
// labels the chi HTTP middleware uses, plus "error" for transport-level
// failures (DNS, timeout, TLS, connection refused) where we never got
// an HTTP status. Bucketing keeps cardinality at five.
func deliveryResultBucket(code int, err error) string {
	if err != nil && code == 0 {
		return "error"
	}
	switch {
	case code >= 500:
		return "5xx"
	case code >= 400:
		return "4xx"
	case code >= 300:
		return "3xx"
	case code >= 200:
		return "2xx"
	default:
		return "error"
	}
}

func deliver(ctx context.Context, url, secret string, body []byte) (status string, code int, respBody string, err error, dur time.Duration) {
	start := time.Now()
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	signature := sign(timestamp, body, secret)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		return "failed", 0, "", err, time.Since(start)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Drive360-Webhook/1.0")
	req.Header.Set("Drive360-Signature", "t="+timestamp+",v1="+signature)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	dur = time.Since(start)
	if err != nil {
		return "failed", 0, "", err, dur
	}
	defer resp.Body.Close()
	bb, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	respBody = string(bb)
	code = resp.StatusCode
	if code >= 200 && code < 300 {
		return "success", code, respBody, nil, dur
	}
	return "failed", code, respBody, nil, dur
}

// sign returns hex(HMAC_SHA256(secret, "<timestamp>.<body>")). Receivers verify
// by reconstructing the same input with the shared secret.
func sign(timestamp string, body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// -- helpers --------------------------------------------------------------

func randomSecret() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "whsec_" + base64.RawURLEncoding.EncodeToString(b[:]), nil
}

func validateEvents(ev []string) []string {
	allowed := map[string]bool{}
	for _, e := range events.AllEvents {
		allowed[e] = true
	}
	out := []string{}
	seen := map[string]bool{}
	for _, e := range ev {
		e = strings.TrimSpace(e)
		if !allowed[e] || seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	return out
}

func errString(err error) *string {
	if err == nil {
		return nil
	}
	s := err.Error()
	return &s
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
