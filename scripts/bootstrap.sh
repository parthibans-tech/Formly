#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Starting infra (Postgres/Redis/MinIO)…"
(cd "$ROOT/infra" && docker compose up -d)

echo "→ Installing Go deps…"
(cd "$ROOT/api" && [ -f .env ] || cp .env.example .env && go mod tidy)

echo "→ Installing web deps…"
(cd "$ROOT/web" && [ -f .env.local ] || cp .env.local.example .env.local && npm install)

cat <<EOF

Bootstrap complete.

Next: open three terminals
  (1) cd api && go run ./cmd/api      # HTTP API on :8080
  (2) cd api && go run ./cmd/worker   # Async job consumer (Redis → Asynq)
  (3) cd web && npm run dev           # http://localhost:3000

Then visit http://localhost:3000
EOF
