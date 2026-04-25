// Package onlyoffice integrates the drive with an ONLYOFFICE Document
// Server (Community Edition, AGPL) running alongside the API.
//
// What lives in this package
//
//   - Config endpoint: returns a signed editor config the browser hands
//     to ONLYOFFICE's `DocsAPI.DocEditor` constructor. The browser
//     itself never edits this config — it's signed with our shared HMAC
//     secret and ONLYOFFICE refuses anything unsigned in production.
//
//   - Content endpoint: ONLYOFFICE fetches the document bytes here. We
//     don't trust the user JWT for this — ONLYOFFICE talks to us
//     server-to-server, no Authorization header. Instead the config we
//     hand it carries a short-lived, file-scoped HMAC token in the URL.
//
//   - Callback endpoint: ONLYOFFICE POSTs lifecycle events here
//     (editing started, ready to save, force-save, etc.). When status
//     is 2 or 6 we download the new bytes from the URL the callback
//     supplies and overwrite the file in storage. The body itself is
//     wrapped in the same shared JWT so random POSTs can't trigger
//     overwrites.
//
// Why three endpoints and not one
//
// The three flows have different trust boundaries. Config is called by
// the browser on behalf of an authenticated user — full ACL enforcement
// runs there. Content is called by ONLYOFFICE on behalf of nobody — only
// the file-scoped HMAC token gates it, and the token is keyed to the
// file ID so a leaked token from one document can't read another.
// Callback is also called by ONLYOFFICE; the JWT-in-body verifies the
// payload and the file ID is path-scoped.
package onlyoffice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/sharing"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Handler bundles the deps for the three onlyoffice endpoints.
//
// PublicURL is the URL ONLYOFFICE renders into the iframe — i.e. how the
// *browser* reaches the document server (e.g. http://localhost:8090).
// InternalAPIURL is how the *document server* reaches our API for
// content + callback (e.g. http://host.docker.internal:8080). These can
// differ in dev and almost always differ in production behind a reverse
// proxy. Both come from env at construction time.
type Handler struct {
	DB             *pgxpool.Pool
	Storage        *storage.Client
	JWTSecret      string
	PublicURL      string // browser-facing onlyoffice URL (informational only; not used server-side)
	InternalAPIURL string // url ONLYOFFICE uses to reach back to our API
}

// New constructs a Handler from env. Returns nil + error if any required
// piece is missing — the caller decides whether to treat that as fatal
// or just skip wiring the routes (e.g. for deployments that don't run
// ONLYOFFICE at all).
func New(db *pgxpool.Pool, store *storage.Client) (*Handler, error) {
	secret := strings.TrimSpace(os.Getenv("ONLYOFFICE_JWT_SECRET"))
	if secret == "" {
		return nil, errors.New("ONLYOFFICE_JWT_SECRET is required")
	}
	pub := strings.TrimSpace(os.Getenv("ONLYOFFICE_PUBLIC_URL"))
	if pub == "" {
		pub = "http://localhost:8090"
	}
	internal := strings.TrimSpace(os.Getenv("ONLYOFFICE_INTERNAL_API_URL"))
	if internal == "" {
		// Default for Docker Desktop on macOS / Windows. Linux hosts
		// must set this explicitly (or rely on the extra_hosts shim).
		internal = "http://host.docker.internal:8080"
	}
	return &Handler{
		DB:             db,
		Storage:        store,
		JWTSecret:      secret,
		PublicURL:      pub,
		InternalAPIURL: internal,
	}, nil
}

// IsEditableByOnlyOffice reports whether the file's mime/extension is
// one we route through ONLYOFFICE. Covers the three editors document
// server ships: word (docx/rtf/odt/txt), cell (xlsx/ods/csv), and
// slide (pptx/odp). Callers in other packages can use this to gate
// menu items and click handlers; documentTypeFor() picks the editor.
func IsEditableByOnlyOffice(mime, name string) bool {
	return documentTypeFor(name, mime) != ""
}

// documentTypeFor returns the ONLYOFFICE `documentType` value for a
// given file ("word" | "cell" | "slide"), or "" if we don't route the
// file through ONLYOFFICE at all. Extension wins because browsers ship
// inconsistent MIME for older Office formats and ONLYOFFICE itself keys
// editor selection off the extension.
func documentTypeFor(name, mime string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	switch ext {
	case "docx", "doc", "docm", "dotx", "dot", "dotm",
		"odt", "ott",
		"rtf", "txt":
		return "word"
	case "xlsx", "xls", "xlsm", "xltx", "xlt", "xltm",
		"ods", "ots",
		"csv":
		return "cell"
	case "pptx", "ppt", "pptm", "potx", "pot", "potm", "ppsx", "pps", "ppsm",
		"odp", "otp":
		return "slide"
	}
	switch strings.ToLower(mime) {
	case "application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.template",
		"application/vnd.ms-word.document.macroenabled.12",
		"application/vnd.ms-word.template.macroenabled.12",
		"application/rtf", "text/rtf",
		"application/vnd.oasis.opendocument.text",
		"text/plain":
		return "word"
	case "application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.template",
		"application/vnd.ms-excel.sheet.macroenabled.12",
		"application/vnd.ms-excel.template.macroenabled.12",
		"application/vnd.oasis.opendocument.spreadsheet",
		"text/csv":
		return "cell"
	case "application/vnd.ms-powerpoint",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"application/vnd.openxmlformats-officedocument.presentationml.template",
		"application/vnd.openxmlformats-officedocument.presentationml.slideshow",
		"application/vnd.ms-powerpoint.presentation.macroenabled.12",
		"application/vnd.ms-powerpoint.template.macroenabled.12",
		"application/vnd.ms-powerpoint.slideshow.macroenabled.12",
		"application/vnd.oasis.opendocument.presentation":
		return "slide"
	}
	return ""
}

// fileTypeFor returns the lowercase extension ONLYOFFICE expects in the
// `document.fileType` field. ONLYOFFICE keys editor selection off this
// string, not the MIME type, so we always feed it the extension and
// fall back to a sensible default per editor for typeless cases.
func fileTypeFor(name, mime string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	if ext != "" {
		return ext
	}
	switch documentTypeFor(name, mime) {
	case "cell":
		return "xlsx"
	case "slide":
		return "pptx"
	default:
		return "docx"
	}
}

// Config is GET /v1/files/{id}/onlyoffice/config. Returns a JSON blob
// the browser feeds straight into `new DocsAPI.DocEditor(...)`. The
// `token` field is a JWT covering the rest of the config so ONLYOFFICE
// can verify the browser didn't tamper with the URL or the user info.
//
// Permission model: viewers get mode="view"; editors get mode="edit".
// Anyone without read access gets a 404, matching how the rest of the
// drive's read endpoints behave.
func (h *Handler) Config(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	id := chi.URLParam(r, "id")

	canRead, err := sharing.CanAccessFile(r.Context(), h.DB, c, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !canRead {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	canEdit, err := sharing.CanEditFile(r.Context(), h.DB, c, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	var (
		name      string
		mime      string
		updatedAt time.Time
	)
	if err := h.DB.QueryRow(r.Context(),
		`SELECT name, mime, updated_at
		   FROM files
		  WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`,
		id, c.OrgID,
	).Scan(&name, &mime, &updatedAt); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}

	docType := documentTypeFor(name, mime)
	if docType == "" {
		writeErr(w, 400, "unsupported_type",
			"this file type is not editable in the document editor")
		return
	}

	mode := "edit"
	if !canEdit {
		mode = "view"
	}

	// document.key tells ONLYOFFICE which session to coalesce on. Two
	// browsers opening the same key share an editing session (real
	// collaboration). Tying it to updated_at means an external write
	// (e.g. a fresh upload via the drive's replace flow) bumps the key
	// and ONLYOFFICE re-fetches instead of serving stale cache.
	docKey := fmt.Sprintf("%s_%d", id, updatedAt.UnixNano())

	// Short-lived token scoping the content fetch to this file ID. We
	// use the same HMAC secret + a tight TTL; the token-protected
	// endpoint enforces both `sub == fileID` and `exp` before
	// streaming bytes.
	contentToken, err := h.signContentToken(id, 30*time.Minute)
	if err != nil {
		writeErr(w, 500, "sign_error", err.Error())
		return
	}

	contentURL := fmt.Sprintf("%s/v1/files/%s/onlyoffice/content?token=%s",
		strings.TrimRight(h.InternalAPIURL, "/"), id, contentToken)
	callbackURL := fmt.Sprintf("%s/v1/files/%s/onlyoffice/callback?token=%s",
		strings.TrimRight(h.InternalAPIURL, "/"), id, contentToken)

	cfg := map[string]any{
		"document": map[string]any{
			"fileType":   fileTypeFor(name, mime),
			"key":        docKey,
			"title":      name,
			"url":        contentURL,
			"permissions": map[string]any{
				"edit":     canEdit,
				"download": true,
				"print":    true,
			},
		},
		"documentType": docType,
		"editorConfig": map[string]any{
			"mode":        mode,
			"callbackUrl": callbackURL,
			"user": map[string]any{
				"id":   c.UserID,
				"name": userDisplay(c),
			},
			"customization": map[string]any{
				"autosave":    true,
				"forcesave":   true,
				"compactHeader": true,
			},
			"lang": "en",
		},
		"type":   "desktop",
		"width":  "100%",
		"height": "100%",
	}

	// ONLYOFFICE accepts the entire config wrapped as a single JWT in
	// `token`. That's the modern, recommended path — it covers every
	// field, not just a subset, so a tampered URL or mode flip is
	// rejected.
	signed, err := h.signConfig(cfg)
	if err != nil {
		writeErr(w, 500, "sign_error", err.Error())
		return
	}
	cfg["token"] = signed

	writeJSON(w, 200, map[string]any{
		"config":    cfg,
		"publicUrl": h.PublicURL, // browser uses this to load api.js
	})
}

// Content is GET /v1/files/{id}/onlyoffice/content?token=...
//
// Called server-to-server by ONLYOFFICE Document Server. There's no
// user JWT; auth is the file-scoped HMAC token we minted in Config.
// We re-validate `sub == fileID` and `exp` before streaming.
func (h *Handler) Content(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	token := r.URL.Query().Get("token")
	if !h.verifyContentToken(token, id) {
		writeErr(w, 401, "unauthorized", "invalid or expired token")
		return
	}

	var (
		name string
		mime string
		key  string
	)
	if err := h.DB.QueryRow(r.Context(),
		`SELECT name, mime, storage_key
		   FROM files
		  WHERE id=$1 AND trashed_at IS NULL`,
		id,
	).Scan(&name, &mime, &key); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}

	data, err := h.Storage.GetBytes(r.Context(), key)
	if err != nil {
		writeErr(w, 502, "storage_error", err.Error())
		return
	}
	if mime != "" {
		w.Header().Set("Content-Type", mime)
	}
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`inline; filename="%s"`, name))
	_, _ = w.Write(data)
}

// callbackPayload is the documented shape ONLYOFFICE sends. We don't
// model the full v6 envelope — just the fields we act on. Unknown
// fields are tolerated by JSON unmarshal default semantics.
type callbackPayload struct {
	// Status codes:
	//   0 — no document with the key exists (we should never see this)
	//   1 — document is being edited
	//   2 — document is ready for saving
	//   3 — document saving error has occurred
	//   4 — document is closed with no changes
	//   6 — document is being edited, but the current document state is saved (forcesave)
	//   7 — error has occurred while force saving the document
	Status int    `json:"status"`
	Key    string `json:"key"`
	URL    string `json:"url"` // populated when status is 2 or 6
	// Token is the JWT ONLYOFFICE attaches to verify the body — checked
	// separately via `Authorization` header or in-body, depending on
	// the doc server's JWT_IN_BODY config.
	Token string `json:"token,omitempty"`
}

// Callback is POST /v1/files/{id}/onlyoffice/callback?token=...
//
// ONLYOFFICE invokes this for every document lifecycle event. We:
//   - verify the same content-token (path-scoped to the file ID),
//   - verify the JWT in the body (or Authorization header),
//   - on status 2 or 6, download the bytes from the URL ONLYOFFICE
//     supplies and overwrite the file row's storage object,
//   - always return `{"error":0}` on success — anything else and
//     ONLYOFFICE retries, which is fine for our idempotent storage write
//     but can spam logs if we get the response shape wrong.
func (h *Handler) Callback(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	token := r.URL.Query().Get("token")
	if !h.verifyContentToken(token, id) {
		writeErr(w, 401, "unauthorized", "invalid or expired token")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}
	defer r.Body.Close()

	var p callbackPayload
	if err := json.Unmarshal(body, &p); err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}

	// JWT verification. ONLYOFFICE sends the JWT either in the body
	// (`token` field, when JWT_IN_BODY=true) or in the Authorization
	// header. We accept either.
	jwtRaw := p.Token
	if jwtRaw == "" {
		auth := r.Header.Get("Authorization")
		if strings.HasPrefix(auth, "Bearer ") {
			jwtRaw = strings.TrimPrefix(auth, "Bearer ")
		}
	}
	if jwtRaw == "" || !h.verifyOnlyOfficeJWT(jwtRaw) {
		writeErr(w, 401, "unauthorized", "missing or invalid onlyoffice token")
		return
	}

	switch p.Status {
	case 2, 6:
		// Save event. p.URL is the URL ONLYOFFICE serves the new bytes
		// at; we fetch and persist. Anything else is a no-op (status 1
		// is informational; status 4 means user closed without changes;
		// 3 and 7 are document-server-side errors we just log).
		if err := h.persistFromURL(r.Context(), id, p.URL); err != nil {
			// Returning a non-zero error lets ONLYOFFICE retry the save
			// — that's the documented pattern.
			writeJSON(w, 200, map[string]any{"error": 1, "message": err.Error()})
			return
		}
	case 3, 7:
		// Document server reported a save error. Nothing to persist;
		// surface the failure in logs but ack so it doesn't retry into
		// oblivion.
	}

	writeJSON(w, 200, map[string]any{"error": 0})
}

// persistFromURL fetches the new document bytes from the document
// server and writes them to the file's existing storage key. We keep
// the storage key stable so existing share/download/preview links
// continue to point at the latest version automatically.
func (h *Handler) persistFromURL(ctx context.Context, fileID, url string) error {
	if url == "" {
		return errors.New("callback missing download url")
	}
	var (
		key  string
		mime string
	)
	if err := h.DB.QueryRow(ctx,
		`SELECT storage_key, mime FROM files WHERE id=$1`,
		fileID,
	).Scan(&key, &mime); err != nil {
		return fmt.Errorf("lookup file: %w", err)
	}

	httpc := &http.Client{Timeout: 60 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := httpc.Do(req)
	if err != nil {
		return fmt.Errorf("fetch saved doc: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("fetch saved doc: status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	if err := h.Storage.PutBytes(ctx, key, mime, data); err != nil {
		return fmt.Errorf("write storage: %w", err)
	}
	if _, err := h.DB.Exec(ctx,
		`UPDATE files SET size=$1, updated_at=now() WHERE id=$2`,
		len(data), fileID,
	); err != nil {
		return fmt.Errorf("update file row: %w", err)
	}
	return nil
}

// signConfig wraps the entire editor config in a JWT. ONLYOFFICE
// checks every claim against the actual `document` / `editorConfig`
// the browser passes to `new DocEditor(...)` — drift means the doc
// server refuses to load the editor.
func (h *Handler) signConfig(cfg map[string]any) (string, error) {
	claims := jwt.MapClaims{}
	for k, v := range cfg {
		claims[k] = v
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString([]byte(h.JWTSecret))
}

// verifyOnlyOfficeJWT validates a token minted by ONLYOFFICE itself
// (used in callback bodies). Same shared secret, no claim checks
// beyond signature validity — ONLYOFFICE's token doesn't carry our
// scope, just proves the document server signed the body.
func (h *Handler) verifyOnlyOfficeJWT(raw string) bool {
	_, err := jwt.Parse(raw, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(h.JWTSecret), nil
	})
	return err == nil
}

// signContentToken mints a short-lived, file-scoped HMAC token. The
// `sub` claim is the file ID; the verifier checks both signature and
// `sub` to prevent a token leaked from one document being used to fetch
// another.
func (h *Handler) signContentToken(fileID string, ttl time.Duration) (string, error) {
	claims := jwt.RegisteredClaims{
		Subject:   fileID,
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString([]byte(h.JWTSecret))
}

func (h *Handler) verifyContentToken(raw, fileID string) bool {
	if raw == "" || fileID == "" {
		return false
	}
	claims := &jwt.RegisteredClaims{}
	_, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(h.JWTSecret), nil
	})
	if err != nil {
		return false
	}
	return claims.Subject == fileID
}

func userDisplay(c *auth.Claims) string {
	if c == nil {
		return ""
	}
	if c.Email != "" {
		return c.Email
	}
	return c.UserID
}

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
