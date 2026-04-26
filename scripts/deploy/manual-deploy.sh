#!/usr/bin/env bash
# manual-deploy.sh — proper CI-style deploy, run from laptop.
#
# Flow:
#   laptop                ghcr.io                 VPS
#   ──────                ───────                 ───
#   docker build  ──push──▶ [image] ──pull──▶ docker compose up
#
# No source code is uploaded to the VPS. Only the built image
# travels through ghcr.io. This mirrors what CI will do once the
# SSH-from-runner issue is solved.
#
# Prereqs (one-time):
#   1. bootstrap-vps.sh has been run on the VPS.
#   2. Your laptop can SSH to the VPS as `deploy` without a password.
#   3. The VPS deploy user is in the `docker` group:
#        ssh deploy@vps 'docker ps'   # should NOT say permission denied
#   4. You have a GitHub Personal Access Token (classic) with scopes:
#        - write:packages   (for laptop to push)
#        - read:packages    (for VPS to pull, if package is private)
#      Create at: https://github.com/settings/tokens
#      Export it before running:
#        export GHCR_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxx
#        export GHCR_USER=your-github-username
#
# Usage:
#   export GHCR_TOKEN=ghp_...
#   export GHCR_USER=parthisri
#   ./scripts/deploy/manual-deploy.sh
#
# Optional environment overrides:
#   GHCR_REPO     — owner/repo path on ghcr.io  (default $GHCR_USER/formly)
#   VPS_HOST      — VPS IP / hostname           (default 72.62.243.151)
#   VPS_USER      — SSH user                    (default deploy)
#   VPS_PORT      — SSH port                    (default 22)
#   SSH_KEY       — path to private key         (default ~/.ssh/formly_deploy)
#   IMAGE_TAG     — image tag                   (default git short SHA)
#   ONLY          — api / web / both            (default both)
#   PLATFORM      — target arch                 (default linux/amd64)
#                   — buildx cross-compiles from ARM Macs to amd64

set -euo pipefail

# ─── config ─────────────────────────────────────────────────────
: "${GHCR_TOKEN:?GHCR_TOKEN env var required (PAT with write:packages scope)}"
: "${GHCR_USER:?GHCR_USER env var required (your GitHub username)}"

# Lowercase the user — ghcr requires lowercase image paths.
GHCR_USER_LOWER="$(echo "$GHCR_USER" | tr '[:upper:]' '[:lower:]')"
GHCR_REPO="${GHCR_REPO:-${GHCR_USER_LOWER}/formly}"
GHCR_REPO="$(echo "$GHCR_REPO" | tr '[:upper:]' '[:lower:]')"

VPS_HOST="${VPS_HOST:-72.62.243.151}"
VPS_USER="${VPS_USER:-deploy}"
VPS_PORT="${VPS_PORT:-22}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/formly_deploy}"
ONLY="${ONLY:-both}"
PLATFORM="${PLATFORM:-linux/amd64}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Tag = git short SHA, with -dirty if working tree is uncommitted.
SHA="$(cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo nogit)"
if [ -n "$(cd "$REPO_ROOT" && git status --porcelain 2>/dev/null)" ]; then
  SHA="${SHA}-dirty"
fi
IMAGE_TAG="${IMAGE_TAG:-$SHA}"

# Final image refs — what we push, and what compose pulls.
API_IMAGE="ghcr.io/${GHCR_REPO}-api:${IMAGE_TAG}"
WEB_IMAGE="ghcr.io/${GHCR_REPO}-web:${IMAGE_TAG}"

# ─── pre-flight ─────────────────────────────────────────────────
echo "==> Repo root:    $REPO_ROOT"
echo "==> Target VPS:   $VPS_USER@$VPS_HOST:$VPS_PORT"
echo "==> SSH key:      $SSH_KEY"
echo "==> GHCR repo:    ghcr.io/${GHCR_REPO}-{api,web}"
echo "==> Image tag:    $IMAGE_TAG"
echo "==> Platform:     $PLATFORM"
echo "==> Deploying:    $ONLY"
echo

if [ ! -f "$SSH_KEY" ]; then
  echo "❌ SSH key not found: $SSH_KEY" >&2
  exit 1
fi

ssh_run() {
  ssh -i "$SSH_KEY" -p "$VPS_PORT" \
      -o StrictHostKeyChecking=accept-new \
      "$VPS_USER@$VPS_HOST" "$@"
}

# Sanity-check SSH first — no point uploading if it fails.
echo "==> [1/6] Testing SSH"
ssh_run 'echo connection-ok' >/dev/null
echo "    ok"

# Sanity-check VPS can talk to docker.
echo "==> [2/6] Testing docker access on VPS"
if ! ssh_run 'docker ps' >/dev/null 2>&1; then
  echo "❌ deploy user can't talk to docker on VPS." >&2
  echo "   Fix on the VPS as root:" >&2
  echo "     usermod -aG docker deploy" >&2
  echo "     pkill -KILL -u deploy" >&2
  exit 1
fi
echo "    ok"

# ─── login to ghcr.io (laptop side) ─────────────────────────────
echo "==> [3/6] Logging into ghcr.io (laptop)"
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
echo "    ok"

# ─── build + push images ────────────────────────────────────────
# Use buildx so we can cross-compile to linux/amd64 even when this
# script runs on an Apple Silicon Mac. Buildx + --push streams the
# image straight to ghcr.io without a local intermediate copy.
echo "==> [4/6] Building + pushing image(s) — this is the slow step"
docker buildx inspect formly-builder >/dev/null 2>&1 \
  || docker buildx create --name formly-builder --use >/dev/null

build_and_push() {
  local context="$1"
  local image="$2"
  local extra_args=("${@:3}")

  echo "  → $image"
  docker buildx build \
    --platform "$PLATFORM" \
    --push \
    -t "$image" \
    -f "$context/Dockerfile" \
    "${extra_args[@]}" \
    "$context"
}

case "$ONLY" in
  api|both)
    build_and_push "$REPO_ROOT/api" "$API_IMAGE" \
      --build-arg "VERSION=$IMAGE_TAG"
    ;;
esac

case "$ONLY" in
  web|both)
    # NEXT_PUBLIC_API_URL is baked into the JS bundle at build time.
    # Pull it from /opt/formly/.env on the VPS so we use whatever
    # DOMAIN_API the operator set.
    API_DOMAIN="$(ssh_run "grep '^DOMAIN_API=' /opt/formly/.env | cut -d= -f2-")"
    if [ -z "$API_DOMAIN" ]; then
      echo "❌ DOMAIN_API not set in /opt/formly/.env on the VPS" >&2
      exit 1
    fi
    build_and_push "$REPO_ROOT/web" "$WEB_IMAGE" \
      --build-arg "NEXT_PUBLIC_API_URL=https://$API_DOMAIN"
    ;;
esac
echo "    ok"

# ─── VPS: pull + bring up ───────────────────────────────────────
echo "==> [5/6] Pulling image(s) on VPS"
# VPS needs to log into ghcr.io as well, so it can pull (whether the
# package is public or private). Use the same PAT.
ssh -i "$SSH_KEY" -p "$VPS_PORT" \
    -o StrictHostKeyChecking=accept-new \
    "$VPS_USER@$VPS_HOST" \
    "GHCR_TOKEN='$GHCR_TOKEN' GHCR_USER='$GHCR_USER' \
     API_IMAGE='$API_IMAGE' WEB_IMAGE='$WEB_IMAGE' \
     IMAGE_TAG='$IMAGE_TAG' ONLY='$ONLY' bash -se" <<'REMOTE'
set -euo pipefail

cd /opt/formly

echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

case "$ONLY" in
  api|both)
    docker pull "$API_IMAGE"
    sed -i "s|^API_IMAGE=.*|API_IMAGE=$API_IMAGE|" .env
    ;;
esac
case "$ONLY" in
  web|both)
    docker pull "$WEB_IMAGE"
    sed -i "s|^WEB_IMAGE=.*|WEB_IMAGE=$WEB_IMAGE|" .env
    ;;
esac
sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=$IMAGE_TAG|" .env
echo "---"
grep -E '^(API_IMAGE|WEB_IMAGE|IMAGE_TAG)=' .env
REMOTE
echo "    ok"

echo "==> [6/6] Bringing up compose stack"
case "$ONLY" in
  api)  SERVICES=api ;;
  web)  SERVICES=web ;;
  both) SERVICES="api web" ;;
esac

ssh -i "$SSH_KEY" -p "$VPS_PORT" \
    -o StrictHostKeyChecking=accept-new \
    "$VPS_USER@$VPS_HOST" \
    "SERVICES='$SERVICES' bash -se" <<'REMOTE'
set -euo pipefail
cd /opt/formly
# First time? Bring up the world. After that, only recreate changed services.
if ! docker compose ps --quiet | grep -q .; then
  echo "(first run — starting full stack)"
  docker compose up -d
else
  echo "(incremental — recreating: $SERVICES)"
  docker compose up -d --no-deps $SERVICES
fi
echo
docker compose ps
REMOTE
echo "    ok"

cat <<EOF

================================================================
  Deploy complete.

  Image tag:   $IMAGE_TAG
  API image:   $API_IMAGE
  Web image:   $WEB_IMAGE

  Smoke tests (run from anywhere):
    curl -fsS  https://api.drive360.nearbyme.app/healthz
    curl -fsSI https://drive360.nearbyme.app/

  Logs:
    ssh $VPS_USER@$VPS_HOST 'cd /opt/formly && docker compose logs -f api web'

  Rollback to a previous tag (run on VPS):
    cd /opt/formly
    sed -i 's|^API_IMAGE=.*|API_IMAGE=ghcr.io/${GHCR_REPO}-api:<old-tag>|' .env
    sed -i 's|^WEB_IMAGE=.*|WEB_IMAGE=ghcr.io/${GHCR_REPO}-web:<old-tag>|' .env
    docker compose up -d --no-deps api web

================================================================
EOF
