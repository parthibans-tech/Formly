#!/usr/bin/env bash
# dev.sh — hybrid local dev.
#
# Brings up ALL backing services (postgres, redis, minio, onlyoffice,
# ollama) in Docker, then prints the commands to run api, worker and
# web natively in separate terminals.
#
# Flags:
#   --no-office  skip ONLYOFFICE (saves ~1.5 GB RAM)
#   --no-ai      skip Ollama (saves ~4 GB RAM + model downloads)
#   --down       stop everything and exit
#   --reset      stop AND wipe volumes (destructive), then exit
#   --logs       tail the compose logs
#
# Run from repo root: ./scripts/dev.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/infra/compose/docker-compose.deps.yml"

# Default to running everything; flags can opt out.
WITH_OFFICE=1
WITH_AI=1
ACTION=up

for arg in "$@"; do
  case "$arg" in
    --no-office) WITH_OFFICE=0 ;;
    --no-ai)     WITH_AI=0 ;;
    --down)      ACTION=down ;;
    --reset)     ACTION=reset ;;
    --logs)      ACTION=logs ;;
    -h|--help)
      sed -n '2,16p' "$0"; exit 0 ;;
    *)
      echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

PROFILES=()
[ "$WITH_OFFICE" = 1 ] && PROFILES+=(--profile office)
[ "$WITH_AI" = 1 ]     && PROFILES+=(--profile ai)

# bash 3.2 (macOS) treats an empty array under `set -u` as unbound; this
# helper expands safely.
expand_profiles() { ((${#PROFILES[@]})) && printf '%s\n' ${PROFILES[@]+"${PROFILES[@]}"}; }

cd "$ROOT"

case "$ACTION" in
  down)
    docker compose -f "$COMPOSE_FILE" --profile office --profile ai down
    exit 0 ;;
  reset)
    read -rp "wipe all dev volumes (postgres, minio, onlyoffice, ollama)? [y/N] " ans
    [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "aborted"; exit 1; }
    docker compose -f "$COMPOSE_FILE" --profile office --profile ai down -v
    exit 0 ;;
  logs)
    docker compose -f "$COMPOSE_FILE" ${PROFILES[@]+"${PROFILES[@]}"} logs -f
    exit 0 ;;
esac

echo "==> bringing up backing services"
docker compose -f "$COMPOSE_FILE" ${PROFILES[@]+"${PROFILES[@]}"} up -d

echo "==> waiting for postgres"
for i in {1..30}; do
  if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U docforge -d docforge >/dev/null 2>&1; then
    echo "    postgres ready"
    break
  fi
  sleep 1
done

[ -f "$ROOT/api/.env" ] || echo "WARN: api/.env missing — api will fall back to defaults"
[ -f "$ROOT/web/.env.local" ] || echo "WARN: web/.env.local missing"

cat <<EOF

================================================================
  Backing services up:
    postgres   localhost:5432   (docforge / docforge)
    redis      localhost:6379
    minio      localhost:9000   console: localhost:9001 (minioadmin / minioadmin)
$([ "$WITH_OFFICE" = 1 ] && echo "    onlyoffice localhost:8090")
$([ "$WITH_AI" = 1 ]     && echo "    ollama     localhost:11434")

  Now run these in three separate terminals:

    cd api && go run ./cmd/api
    cd api && go run ./cmd/worker
    cd web && npm run dev

  Stop services:   ./scripts/dev.sh --down
  Wipe data:       ./scripts/dev.sh --reset
  Tail logs:       ./scripts/dev.sh --logs
================================================================
EOF
