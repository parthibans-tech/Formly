package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type ctxKey string

const UserCtxKey ctxKey = "user"

type Claims struct {
	UserID string `json:"uid"`
	OrgID  string `json:"oid"`
	Email  string `json:"email"`
	jwt.RegisteredClaims
}

type Handler struct {
	DB     *pgxpool.Pool
	Secret []byte
}

func New(db *pgxpool.Pool) *Handler {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = "dev-secret-change-me"
	}
	return &Handler{DB: db, Secret: []byte(secret)}
}

type registerReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
	OrgName  string `json:"orgName"`
}

type authResp struct {
	Token string `json:"token"`
	User  user   `json:"user"`
}

type user struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	OrgID string `json:"orgId"`
}

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	var req registerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Email == "" || req.Password == "" || req.Name == "" {
		writeErr(w, 400, "missing_fields", "email, password, name required")
		return
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(req.Password), 12)

	ctx := r.Context()
	tx, err := h.DB.Begin(ctx)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	orgName := req.OrgName
	if orgName == "" {
		orgName = req.Name + "'s Org"
	}
	var orgID string
	if err := tx.QueryRow(ctx, `INSERT INTO organizations (name) VALUES ($1) RETURNING id`, orgName).Scan(&orgID); err != nil {
		writeErr(w, 500, "org_create", err.Error())
		return
	}
	var userID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO users (org_id, email, password_hash, name) VALUES ($1,$2,$3,$4) RETURNING id`,
		orgID, req.Email, string(hash), req.Name,
	).Scan(&userID); err != nil {
		writeErr(w, 400, "user_create", err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, 500, "commit", err.Error())
		return
	}
	token, _ := h.issueToken(userID, orgID, req.Email)
	writeJSON(w, 200, authResp{Token: token, User: user{ID: userID, Email: req.Email, Name: req.Name, OrgID: orgID}})
}

type loginReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	var (
		id, orgID, name, hash string
	)
	err := h.DB.QueryRow(r.Context(),
		`SELECT id, org_id, name, password_hash FROM users WHERE email=$1`, req.Email,
	).Scan(&id, &orgID, &name, &hash)
	if err != nil {
		writeErr(w, 401, "invalid_credentials", "bad email or password")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		writeErr(w, 401, "invalid_credentials", "bad email or password")
		return
	}
	token, _ := h.issueToken(id, orgID, req.Email)
	writeJSON(w, 200, authResp{Token: token, User: user{ID: id, Email: req.Email, Name: name, OrgID: orgID}})
}

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(UserCtxKey).(*Claims)
	writeJSON(w, 200, user{ID: c.UserID, Email: c.Email, OrgID: c.OrgID})
}

func (h *Handler) issueToken(uid, oid, email string) (string, error) {
	c := Claims{
		UserID: uid, OrgID: oid, Email: email,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
	return t.SignedString(h.Secret)
}

func (h *Handler) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authz := r.Header.Get("Authorization")
		if !strings.HasPrefix(authz, "Bearer ") {
			writeErr(w, 401, "no_token", "missing bearer token")
			return
		}
		raw := strings.TrimPrefix(authz, "Bearer ")
		claims := &Claims{}
		_, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, errors.New("bad signing method")
			}
			return h.Secret, nil
		})
		if err != nil {
			writeErr(w, 401, "invalid_token", err.Error())
			return
		}
		ctx := context.WithValue(r.Context(), UserCtxKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
