// Package aisearch is the HTTP surface for AI-backed semantic file
// search. It owns one endpoint:
//
//	GET /v1/files/search?q=<query>&limit=<n>
//
// The handler embeds the query into a vector via the AI client, runs
// a cosine-distance ANN scan against `file_chunks`, joins to `files`
// for ACL + metadata, and returns the top N matching files with a
// snippet from the chunk that scored best.
//
// # Why a separate package and not part of `files`
//
//   - The AI dependency. `files.Handler` is the everyday upload /
//     download / list path and we don't want it to grow a hard
//     dependency on `ai.Client` and the embedder.
//   - 503-on-disabled. When AI is off, every other endpoint in the
//     `files` package still works. Smart search is the only one that
//     stops being a feature; isolating it makes the disabled path
//     obvious.
//   - Future siblings. Auto-tagging, summarize, PII scan are coming —
//     they all want the same shape (handler + ai.Client + DB) but
//     different SQL. One package per AI feature keeps each blast-
//     radius small.
//
// # ACL model
//
// The query joins file_chunks to files via file_id and then re-runs
// the standard FileVisibilityClause from the sharing package. Two
// reasons we re-check rather than trusting the chunk row's org_id:
//
//   1. file_chunks.org_id is a denormalised cache for the partition
//      filter. The source of truth for "can this user see this file"
//      lives in `files` + `resource_shares`, and we don't want to
//      reimplement the visibility logic here.
//   2. A folder share that was rescinded after embedding should
//      immediately drop the file from the user's search results — the
//      ACL clause picks that up; a denormalised flag wouldn't.
//
// # Scoring
//
// Pgvector's `<=>` operator returns cosine distance (lower is closer).
// We expose `score = 1 - distance` to the API so a UI sorting "best
// first" sorts descending. Distances above 0.6 are typically noise for
// nomic-embed-text — we still return them but order them last; the
// caller decides whether to render anything below a threshold.
package aisearch

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/docforge/api/internal/ai"
	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/embeddings"
	"github.com/docforge/api/internal/sharing"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Default and ceiling on the number of results per query. The default
// matches the typical "compact list" UX; the ceiling prevents an
// adversarial caller from sweeping the whole index in one request.
const (
	DefaultLimit = 10
	MaxLimit     = 50
	// MaxQueryLen caps the input string so a 1MB POST body can't pin a
	// worker on tokenization. Embeddings work best with concise queries
	// anyway — the user types a sentence, not a novel.
	MaxQueryLen = 1024
	// SnippetMaxChars is how much chunk text we include in each result.
	// Enough to give the user a "yes that's the file I meant" cue
	// without shipping the entire chunk over the wire.
	SnippetMaxChars = 320
)

// Handler is the HTTP entry point. Constructed once in main.go with
// the same ai.Client instance that drives /v1/ai/config so capability
// reporting and actual behaviour can't drift.
type Handler struct {
	DB       *pgxpool.Pool
	Embedder *embeddings.Embedder
	AI       ai.Client
}

func New(db *pgxpool.Pool, e *embeddings.Embedder, c ai.Client) *Handler {
	return &Handler{DB: db, Embedder: e, AI: c}
}

// Mount wires the route onto the parent (already-authenticated)
// router. Caller is responsible for auth middleware.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/v1/files/search", h.Search)
}

type searchHit struct {
	FileID    string    `json:"fileId"`
	Name      string    `json:"name"`
	MIME      string    `json:"mime"`
	Snippet   string    `json:"snippet"`
	Score     float64   `json:"score"`     // 1 - cosine distance, in [-1, 1]; closer to 1 == better
	ChunkIdx  int       `json:"chunkIdx"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type searchResponse struct {
	Query   string      `json:"query"`
	Results []searchHit `json:"results"`
}

// Search runs one semantic-search query.
//
// Failure modes the caller should handle:
//
//   - 503 ai_disabled — AI is off, or the active provider can't embed.
//     The frontend's `<AIFeature feature="smartSearch">` gate already
//     hides this UI in that state, but we keep the runtime check so a
//     direct API call still gets a clear "feature unavailable" rather
//     than a misleading 500.
//   - 400 bad_query — q is empty or too long.
//   - 502 embed_failed — the model call itself errored. Retriable.
func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "missing claims")
		return
	}
	if h.AI == nil || !h.AI.Enabled() || !h.AI.Capabilities().Embed {
		writeErr(w, http.StatusServiceUnavailable, "ai_disabled",
			"AI smart search is disabled on this deployment")
		return
	}

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeErr(w, http.StatusBadRequest, "bad_query", "missing q parameter")
		return
	}
	if len(q) > MaxQueryLen {
		writeErr(w, http.StatusBadRequest, "bad_query",
			"query too long (max "+strconv.Itoa(MaxQueryLen)+" chars)")
		return
	}

	limit := DefaultLimit
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n > MaxLimit {
				n = MaxLimit
			}
			limit = n
		}
	}

	vec, err := h.Embedder.EmbedQuery(r.Context(), q)
	if err != nil {
		// Disabled / unsupported should never reach here (we checked
		// above) but if the provider regressed mid-flight we degrade
		// gracefully.
		if errors.Is(err, ai.ErrDisabled) || errors.Is(err, ai.ErrUnsupported) {
			writeErr(w, http.StatusServiceUnavailable, "ai_disabled", err.Error())
			return
		}
		writeErr(w, http.StatusBadGateway, "embed_failed", err.Error())
		return
	}

	hits, err := h.runQuery(r.Context(), c, vec, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, searchResponse{Query: q, Results: hits})
}

// runQuery executes the actual SQL: ANN over file_chunks, joined to
// files, with the standard visibility clause re-applied. We pull a few
// extra rows (limit*4) before deduping per file so a long document
// whose top-3 chunks all match doesn't hog all the slots.
func (h *Handler) runQuery(ctx context.Context, c *auth.Claims, vec []float32, limit int) ([]searchHit, error) {
	vecLit := vectorLiteral(vec)

	// Build the visibility clause. Admins bypass the share lookup —
	// they can see every file in their org, and forcing the recursive
	// CTE through for them just burns CPU.
	var clause string
	args := []any{vecLit, c.OrgID, limit * 4}
	if c.IsAdmin() {
		clause = "TRUE"
	} else {
		// FileVisibilityClause numbers placeholders starting at 4
		// because $1=vec, $2=orgID, $3=oversample, $4=userID.
		var vargs []any
		clause, vargs = sharing.FileVisibilityClause("f", c.UserID, 4)
		args = append(args, vargs...)
	}

	// Window function picks the closest chunk per file so the result
	// list is "best file" not "best chunk in some file".
	q := `
		WITH ranked AS (
			SELECT
				fc.file_id,
				fc.chunk_index,
				fc.content,
				fc.embedding <=> $1::vector AS distance,
				ROW_NUMBER() OVER (
					PARTITION BY fc.file_id
					ORDER BY fc.embedding <=> $1::vector
				) AS rn
			FROM file_chunks fc
			WHERE fc.org_id = $2
		)
		SELECT
			f.id,
			f.name,
			f.mime,
			r.content,
			r.distance,
			r.chunk_index,
			f.updated_at
		  FROM ranked r
		  JOIN files f ON f.id = r.file_id
		 WHERE r.rn = 1
		   AND f.org_id = $2
		   AND f.status = 'active'
		   AND ` + clause + `
		 ORDER BY r.distance ASC
		 LIMIT $3`

	rows, err := h.DB.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]searchHit, 0, limit)
	for rows.Next() {
		var (
			id, name, mime, content string
			distance                float64
			chunkIdx                int
			updatedAt               time.Time
		)
		if err := rows.Scan(&id, &name, &mime, &content, &distance, &chunkIdx, &updatedAt); err != nil {
			return nil, err
		}
		out = append(out, searchHit{
			FileID:    id,
			Name:      name,
			MIME:      mime,
			Snippet:   trimSnippet(content),
			Score:     1.0 - distance,
			ChunkIdx:  chunkIdx,
			UpdatedAt: updatedAt,
		})
		if len(out) >= limit {
			break
		}
	}
	return out, rows.Err()
}

// trimSnippet collapses runs of whitespace and clips to the snippet
// budget. We don't try to find a sentence boundary — the chunker
// already aligned chunks on sentence-ish breaks where it could, and
// the UI only uses this as a hover preview.
func trimSnippet(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	// Collapse internal whitespace so the snippet doesn't show as
	// `\n\n\n` blocks in the result list.
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if r == '\n' || r == '\r' || r == '\t' {
			r = ' '
		}
		if r == ' ' {
			if prevSpace {
				continue
			}
			prevSpace = true
		} else {
			prevSpace = false
		}
		b.WriteRune(r)
	}
	out := b.String()
	if len(out) > SnippetMaxChars {
		// Trim on rune boundary to avoid a half-encoded last char.
		runes := []rune(out)
		if len(runes) > SnippetMaxChars {
			runes = runes[:SnippetMaxChars]
		}
		out = string(runes) + "…"
	}
	return out
}

// vectorLiteral mirrors the embeddings package helper. We duplicate it
// here rather than exporting from `embeddings` because passing a
// []float32 to pgx via the text representation is the only thing both
// packages share — and adding an exported helper to `embeddings` would
// imply more API stability than is warranted.
func vectorLiteral(v []float32) string {
	if len(v) == 0 {
		return "[]"
	}
	var b strings.Builder
	b.Grow(len(v) * 12)
	b.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		// FormatFloat with -1 precision is the shortest accurate
		// representation; matches the embeddings package's vectorLiteral
		// without pulling fmt.Sprintf into a hot path.
		b.WriteString(strconv.FormatFloat(float64(f), 'g', -1, 32))
	}
	b.WriteByte(']')
	return b.String()
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, kind, msg string) {
	writeJSON(w, code, map[string]any{"error": kind, "message": msg})
}
