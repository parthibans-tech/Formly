#!/usr/bin/env bash
# bootstrap-vps.sh — one-time setup for a fresh Hostinger KVM VPS
# (Ubuntu 22.04 / 24.04). Run AS ROOT. Idempotent — safe to re-run.
#
# This is the DOCKER-COMPOSE flavour of bootstrap. Everything that
# runs the application is a container managed by
# /opt/formly/docker-compose.yml. This script:
#
#   1. Installs Docker engine + compose plugin.
#   2. Installs git (to fetch infra/compose/ files) and curl.
#   3. Creates a `deploy` user with SSH access and Docker
#      privileges (member of the `docker` group).
#   4. Lays out /opt/formly/ with the compose stack files.
#   5. Generates a starter .env from .env.example, with random
#      passwords pre-filled (you still need to set domain values).
#   6. Sets up UFW for ports 22, 80, 443.
#
# What this script does NOT do:
#   • Pull container images — that happens on first
#     `docker compose up -d` (manual or via CI).
#   • Configure DNS — you do that in Hostinger's panel.
#   • Pull Ollama models — run `setup-ollama-models.sh` later if
#     you turned the `ai` profile on.
#
# RESOURCE WARNING (read before picking a Hostinger plan):
#   On KVM 2 (8 GB RAM), all-services + Ollama is too tight. Pick:
#     • web + api + postgres + redis + minio + onlyoffice  ≈ 5 GB
#     • web + api + postgres + redis + minio + ollama       ≈ 6 GB
#     • all of the above                                     OOM territory
#   For all-of-the-above, get KVM 4 (16 GB).
#
# Usage:
#   sudo bash scripts/deploy/bootstrap-vps.sh
#   # or with overrides:
#   sudo DEPLOY_USER=deploy COMPOSE_DIR=/opt/formly bash bootstrap-vps.sh

set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "must run as root (try: sudo $0)"
  exit 1
fi

DEPLOY_USER="${DEPLOY_USER:-deploy}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/formly}"

echo "==> [1/6] OS packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg lsb-release \
    rsync git ufw \
    openssl

echo "==> [2/6] Docker engine + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
else
  echo "(docker already installed: $(docker --version))"
fi
systemctl enable --now docker

echo "==> [3/6] deploy user"
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
# Add deploy user to the docker group — this lets it run
# `docker compose` without sudo, which is the whole point of the
# one-push-deploy story. NB: `docker` group membership is
# effectively root (anyone in it can mount / into a container).
# That's why this user is reserved for CI; humans should use
# regular sudo.
usermod -aG docker "$DEPLOY_USER"

install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"

echo "==> [4/6] /opt/formly layout"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$COMPOSE_DIR"

# Copy compose stack files. The script lives at
# scripts/deploy/bootstrap-vps.sh; sibling files are at
# infra/compose/*. If the repo isn't checked out (curl|bash usage),
# fall back to fetching from raw.githubusercontent.com.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_SRC="$SCRIPT_DIR/../../infra/compose"
if [ -f "$COMPOSE_SRC/docker-compose.yml" ]; then
  install -m 644 -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
    "$COMPOSE_SRC/docker-compose.yml" "$COMPOSE_DIR/docker-compose.yml"
  install -m 644 -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
    "$COMPOSE_SRC/Caddyfile" "$COMPOSE_DIR/Caddyfile"
  install -m 644 -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
    "$COMPOSE_SRC/postgres-init.sql" "$COMPOSE_DIR/postgres-init.sql"
  install -m 644 -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
    "$COMPOSE_SRC/.env.example" "$COMPOSE_DIR/.env.example"
else
  echo "(repo not present locally — fetching from github)"
  base="https://raw.githubusercontent.com/your-github-username/Formly/main/infra/compose"
  for f in docker-compose.yml Caddyfile postgres-init.sql .env.example; do
    curl -fsSL "$base/$f" -o "$COMPOSE_DIR/$f"
    chown "$DEPLOY_USER:$DEPLOY_USER" "$COMPOSE_DIR/$f"
  done
fi

# Generate .env from .env.example, with random secrets pre-filled.
# Domain values are left blank — operator MUST set them before
# `docker compose up`.
if [ ! -f "$COMPOSE_DIR/.env" ]; then
  cp "$COMPOSE_DIR/.env.example" "$COMPOSE_DIR/.env"
  PG_PASS=$(openssl rand -hex 24)
  JWT=$(openssl rand -hex 32)
  MINIO_USER=$(openssl rand -hex 12)
  MINIO_PASS=$(openssl rand -hex 24)
  ONLY_JWT=$(openssl rand -hex 32)
  sed -i \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PG_PASS|" \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$JWT|" \
    -e "s|^MINIO_ROOT_USER=.*|MINIO_ROOT_USER=$MINIO_USER|" \
    -e "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=$MINIO_PASS|" \
    -e "s|^ONLYOFFICE_JWT_SECRET=.*|ONLYOFFICE_JWT_SECRET=$ONLY_JWT|" \
    "$COMPOSE_DIR/.env"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$COMPOSE_DIR/.env"
  chmod 600 "$COMPOSE_DIR/.env"
  echo "(.env generated with random secrets — edit DOMAIN_* values before deploying)"
fi

echo "==> [5/6] firewall"
ufw allow 22/tcp || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
yes | ufw enable || true

echo "==> [6/6] sanity checks"
docker compose version
docker version --format '{{.Server.Version}}' || true

cat <<EOF

================================================================
  Bootstrap complete.

  NEXT STEPS:

  1. Add your GitHub Actions deploy key to:
       /home/$DEPLOY_USER/.ssh/authorized_keys

  2. Edit $COMPOSE_DIR/.env and set:
       DOMAIN_WEB=drive360.nearbyme.app
       DOMAIN_API=api.drive360.nearbyme.app
       ACME_EMAIL=you@nearbyme.app
     (Random secrets are already pre-filled.)

  3. Point DNS A records at this VPS:
       drive360.nearbyme.app      → \$(public IP)
       api.drive360.nearbyme.app  → \$(public IP)

  4. Add GitHub repository secrets/variables:
       Secrets:
         HOSTINGER_HOST       = <VPS_IP>
         HOSTINGER_USER       = $DEPLOY_USER
         HOSTINGER_SSH_KEY    = <private key for ssh>
         GHCR_TOKEN           = <personal access token with write:packages>
                                (only if your repo is private; else use GITHUB_TOKEN)
       Variables:
         API_DOMAIN  = api.drive360.nearbyme.app
         WEB_DOMAIN  = drive360.nearbyme.app

  5. Push to main (or tag v0.0.1):
       git push origin main
     The pipeline builds images, pushes to ghcr.io, SSHes here,
     and runs \`docker compose pull && up -d\`.

  6. (Optional) Pull Ollama models if you enabled the AI profile:
       docker compose --profile ai run --rm ollama \\
         ollama pull llama3.2:3b
       docker compose --profile ai run --rm ollama \\
         ollama pull nomic-embed-text
       Then set AI_ENABLED=true in .env and \`docker compose up -d api\`.

================================================================
EOF
