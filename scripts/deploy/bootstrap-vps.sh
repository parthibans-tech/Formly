#!/usr/bin/env bash
# bootstrap-vps.sh — one-time setup for a fresh Hostinger KVM VPS
# (Ubuntu 22.04 / 24.04). Run AS ROOT. Idempotent — safe to re-run if
# something fails halfway.
#
# What it does:
#   1. Install OS dependencies (Postgres+pgvector, Redis, Tesseract +
#      Tamil & Hindi packs, ImageMagick, poppler-utils, Node.js LTS,
#      nginx + certbot).
#   2. Install Ollama (the AI provider this codebase defaults to) and
#      register its systemd unit. Models are NOT pulled here — that's
#      a separate `setup-ollama-models.sh` step so reboots / re-runs
#      of the bootstrap don't redownload multi-GB blobs every time.
#      Skip with `WITH_OLLAMA=0` env if you're using a hosted AI
#      provider (Anthropic, OpenAI) or have Ollama on a separate box.
#   3. Create the `formly` runtime user (no shell, no sudo) — what
#      the systemd units run as.
#   4. Create the `deploy` user with restricted sudo (only enough to
#      restart the formly-* @blue / @green units and reload nginx) —
#      what GitHub Actions SSHes in as.
#   5. Lay out /opt/formly/{api,web,incoming} with blue/green slot
#      directories and per-slot env files.
#   6. Install the parameterized systemd unit templates and enable
#      both slots. Only ONE slot starts at boot (the one named in
#      /opt/formly/<svc>/active). The OTHER stays stopped until a
#      deploy lands on it.
#   7. Install the nginx site config + upstream snippets that the
#      install scripts atomically rewrite during deploys.
#   8. Set up Postgres role + pgvector extension.
#
# What this script does NOT do:
#   • Pull Ollama models (run `setup-ollama-models.sh` after this).
#   • Obtain TLS certs — operator runs `certbot --nginx -d ...` after
#     DNS is pointed at the VPS. We provision a self-signed snakeoil
#     cert as placeholder so `nginx -t` passes pre-cert.
#   • Set environment files (/opt/formly/api/env, /opt/formly/web/env).
#     The script creates placeholders; fill them with sudoedit before
#     the first deploy.
#   • Install ONLYOFFICE — optional, follow-up if your deploy needs it.
#
# RESOURCE WARNING (read before picking a Hostinger plan):
#   Ollama on CPU is RAM-bound. Two-slot blue-green ALSO doubles the
#   API + web footprint for the ~30 s of a deploy. Realistic sizing:
#     • KVM 2 (8 GB RAM) — works for light AI use, slow responses
#       (10–30 s per summarize call cold, 3–10 s warm). Deploy peak
#       sits at ~6.5 GB; comfortable but no headroom for big jobs.
#     • KVM 4 (16 GB RAM) — comfortable, can keep both chat + embed
#       models warm in memory.
#     • KVM 1 (4 GB RAM) — DO NOT enable Ollama; the OOM killer will
#       eat Postgres. Use a hosted provider instead, or run AI on a
#       separate box and point AI_BASE_URL at it.
#   Hostinger VPS plans don't include GPUs, so chat latency is
#   inherently CPU-bound. If you need fast AI, host Ollama elsewhere
#   (a GPU box) and set AI_BASE_URL to its public endpoint.
#
# Usage on a fresh box:
#   curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/scripts/deploy/bootstrap-vps.sh \
#     | sudo bash
# or, if cloned:
#   sudo bash scripts/deploy/bootstrap-vps.sh

set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "must run as root (try: sudo $0)"
  exit 1
fi

WITH_OLLAMA="${WITH_OLLAMA:-1}"
DOMAIN="${DOMAIN:-}"   # if set, formly.conf is templated with this
                       # domain in place of __DOMAIN__. Optional.

echo "==> [1/8] OS packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg lsb-release \
    rsync git sudo \
    postgresql-16 postgresql-16-pgvector \
    redis-server \
    tesseract-ocr tesseract-ocr-tam tesseract-ocr-hin \
    imagemagick poppler-utils \
    nginx ufw \
    certbot python3-certbot-nginx \
    ssl-cert

# Node.js 20 LTS via Nodesource (Hostinger's default repos lag).
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  echo "==> Installing Node.js 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# ImageMagick on Ubuntu ships with a draconian default policy that
# blocks PDF reads (CVE-2018-16509 era hardening). The OCR pipeline
# in api/internal/ocr/ goes through pdftoppm directly, so we don't
# rely on convert(1) for PDFs — but loosening the GhostScript path
# avoids surprise breakage if a downstream feature reaches for it.
if [ -f /etc/ImageMagick-6/policy.xml ]; then
  sed -i 's|<policy domain="coder" rights="none" pattern="PDF" />|<!-- pdf coder allowed for formly -->|' \
    /etc/ImageMagick-6/policy.xml || true
fi

echo "==> [2/8] Ollama (AI provider)"
if [ "$WITH_OLLAMA" = "1" ]; then
  if ! command -v ollama >/dev/null 2>&1; then
    # Official installer. Adds an `ollama` system user, drops the
    # binary at /usr/local/bin/ollama, and registers
    # /etc/systemd/system/ollama.service which listens on
    # 127.0.0.1:11434 by default. We don't expose Ollama's port to
    # the public internet — the API talks to it over loopback.
    curl -fsSL https://ollama.com/install.sh | sh
  else
    echo "(ollama already installed: $(ollama --version 2>/dev/null | head -1))"
  fi
  systemctl enable --now ollama
  for i in 1 2 3 4 5; do
    if curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      echo "(ollama responding on 11434)"
      break
    fi
    sleep 2
    [ "$i" = "5" ] && echo "WARN: ollama did not respond on 11434 within 10s — check 'systemctl status ollama'"
  done
else
  echo "(skipped: WITH_OLLAMA=0 — set AI_BASE_URL to your remote provider in /opt/formly/api/env)"
fi

echo "==> [3/8] runtime user 'formly'"
if ! id -u formly >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/formly --create-home \
          --shell /usr/sbin/nologin formly
fi
mkdir -p /var/log/formly /var/lib/formly
chown formly:formly /var/log/formly /var/lib/formly

echo "==> [4/8] deploy user"
if ! id -u deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
fi
# Restricted sudo: deploy can only operate on the formly-* units
# (parameterized — formly-api@blue.service etc.) and reload nginx.
# NEVER grant blanket sudo — the SSH key going to GitHub Actions
# becomes a root key the moment you do.
#
# We use the `formly-*@*.service` glob (Cmnd_Alias-style by command
# match) to cover both blue and green without listing each instance.
cat >/etc/sudoers.d/formly-deploy <<'SUDOERS'
deploy ALL=(root) NOPASSWD: /bin/systemctl daemon-reload
deploy ALL=(root) NOPASSWD: /bin/systemctl restart formly-api@blue.service, /bin/systemctl restart formly-api@green.service
deploy ALL=(root) NOPASSWD: /bin/systemctl restart formly-web@blue.service, /bin/systemctl restart formly-web@green.service
deploy ALL=(root) NOPASSWD: /bin/systemctl stop formly-api@blue.service, /bin/systemctl stop formly-api@green.service
deploy ALL=(root) NOPASSWD: /bin/systemctl stop formly-web@blue.service, /bin/systemctl stop formly-web@green.service
deploy ALL=(root) NOPASSWD: /bin/systemctl start formly-api@blue.service, /bin/systemctl start formly-api@green.service
deploy ALL=(root) NOPASSWD: /bin/systemctl start formly-web@blue.service, /bin/systemctl start formly-web@green.service
deploy ALL=(root) NOPASSWD: /bin/systemctl status formly-api@blue.service, /bin/systemctl status formly-api@green.service
deploy ALL=(root) NOPASSWD: /bin/systemctl status formly-web@blue.service, /bin/systemctl status formly-web@green.service
# nginx — needed by install-{api,web}.sh to swap the upstream snippet
# and validate / reload the config. We don't allow `nginx` arbitrary
# args (e.g. -c custom.conf) — explicit subcommands only.
deploy ALL=(root) NOPASSWD: /usr/sbin/nginx -t -c /etc/nginx/nginx.conf
deploy ALL=(root) NOPASSWD: /usr/sbin/nginx -s reload
# Atomic upstream-snippet swap. install-{api,web}.sh writes a temp
# file in /tmp, `sudo cp`s it next to the live snippet (.new), runs
# `nginx -t`, then `sudo mv`s it into place. Path globbing in
# sudoers uses `*` = any chars except `/`, so the cp source is
# constrained to direct children of /tmp (mktemp output).
deploy ALL=(root) NOPASSWD: /bin/cp /tmp/formly-api-upstream.* /etc/nginx/snippets/formly-api-upstream.conf.new
deploy ALL=(root) NOPASSWD: /bin/cp /tmp/formly-web-upstream.* /etc/nginx/snippets/formly-web-upstream.conf.new
deploy ALL=(root) NOPASSWD: /bin/mv /etc/nginx/snippets/formly-api-upstream.conf.new /etc/nginx/snippets/formly-api-upstream.conf
deploy ALL=(root) NOPASSWD: /bin/mv /etc/nginx/snippets/formly-web-upstream.conf.new /etc/nginx/snippets/formly-web-upstream.conf
# Cleanup if the swap aborts after writing .new but before mv.
deploy ALL=(root) NOPASSWD: /bin/rm -f /etc/nginx/snippets/formly-api-upstream.conf.new
deploy ALL=(root) NOPASSWD: /bin/rm -f /etc/nginx/snippets/formly-web-upstream.conf.new
SUDOERS
chmod 440 /etc/sudoers.d/formly-deploy

# SSH key for GitHub Actions. We generate one if missing; the
# operator copies the public half into the deploy user's
# authorized_keys (or, more commonly, copies an existing CI key in
# from elsewhere).
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

echo "==> [5/8] /opt/formly layout (blue-green slots)"
# /opt/formly/<svc>/
#   env                       shared, root:formly 640
#   env.blue / env.green      per-slot, root:formly 640
#   active                    "blue" or "green", root:deploy 664
#   incoming/                 rsync drop, deploy:deploy 755
#   releases/<VERSION>/       deploy:deploy 755
#   slots/{blue,green}/       symlinks to releases/<VERSION>
install -d -o deploy -g deploy /opt/formly
install -d -o deploy -g deploy /opt/formly/incoming
install -d -o deploy -g deploy /opt/formly/incoming/api
install -d -o deploy -g deploy /opt/formly/incoming/web
for svc in api web; do
  install -d -o deploy -g deploy "/opt/formly/$svc"
  install -d -o deploy -g deploy "/opt/formly/$svc/releases"
  install -d -o deploy -g deploy "/opt/formly/$svc/slots"
done

# Initial active marker — both services start with `blue` as live.
# The first deploy will land on green, then flip active to green.
for svc in api web; do
  if [ ! -f "/opt/formly/$svc/active" ]; then
    echo blue > "/opt/formly/$svc/active"
    chown root:deploy "/opt/formly/$svc/active"
    chmod 664 "/opt/formly/$svc/active"
  fi
done

# Shared env file — placeholder. Operator MUST fill in real values
# before first deploy or services crash on missing DATABASE_URL etc.
if [ ! -f /opt/formly/api/env ]; then
  install -o root -g formly -m 640 /dev/null /opt/formly/api/env
  cat >/opt/formly/api/env <<'API_ENV'
# ---- core ----
DATABASE_URL=postgres://formly:CHANGE_ME_BEFORE_FIRST_DEPLOY@127.0.0.1:5432/formly?sslmode=disable
REDIS_URL=redis://127.0.0.1:6379/0
JWT_SECRET=REPLACE_WITH_openssl_rand_-hex_32

# ---- object storage ----
S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=

# ---- AI (Ollama on loopback) ----
AI_ENABLED=false
AI_PROVIDER=ollama
AI_BASE_URL=http://127.0.0.1:11434
AI_CHAT_MODEL=llama3.2:3b
AI_EMBED_MODEL=nomic-embed-text
AI_VISION_MODEL=
AI_TIMEOUT_SEC=180

# ---- doc chat ----
DOCCHAT_TIMEOUT_SEC=180

# ---- ONLYOFFICE (optional) ----
# ONLYOFFICE_URL=http://127.0.0.1:8090
# ONLYOFFICE_JWT_SECRET=

# NOTE: LISTEN_ADDR is NOT set here — it's pinned per slot in
# env.blue / env.green so each instance binds its own loopback port.
API_ENV
fi

# Per-slot env files — pin LISTEN_ADDR. systemd loads the shared env
# first then overlays the slot-specific one (later wins).
if [ ! -f /opt/formly/api/env.blue ]; then
  install -o root -g formly -m 640 /dev/null /opt/formly/api/env.blue
  echo "LISTEN_ADDR=127.0.0.1:8080" > /opt/formly/api/env.blue
fi
if [ ! -f /opt/formly/api/env.green ]; then
  install -o root -g formly -m 640 /dev/null /opt/formly/api/env.green
  echo "LISTEN_ADDR=127.0.0.1:8081" > /opt/formly/api/env.green
fi

if [ ! -f /opt/formly/web/env ]; then
  install -o root -g formly -m 640 /dev/null /opt/formly/web/env
  cat >/opt/formly/web/env <<'WEB_ENV'
# Shared web env. PORT and HOSTNAME are pinned per slot in
# env.blue / env.green.
HOSTNAME=127.0.0.1

# Public API URL. NEXT_PUBLIC_* is baked into the client bundle at
# build time — change this and `next build` must re-run (the deploy
# pipeline does that on every web deploy).
NEXT_PUBLIC_API_URL=https://api.your-domain.example
WEB_ENV
fi
if [ ! -f /opt/formly/web/env.blue ]; then
  install -o root -g formly -m 640 /dev/null /opt/formly/web/env.blue
  cat >/opt/formly/web/env.blue <<'EOF'
PORT=3000
HOSTNAME=127.0.0.1
EOF
fi
if [ ! -f /opt/formly/web/env.green ]; then
  install -o root -g formly -m 640 /dev/null /opt/formly/web/env.green
  cat >/opt/formly/web/env.green <<'EOF'
PORT=3001
HOSTNAME=127.0.0.1
EOF
fi

echo "==> [6/8] systemd units (parameterized templates)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="$SCRIPT_DIR/../../infra/systemd"
if [ ! -f "$UNIT_SRC/formly-api@.service" ]; then
  echo "(repo not present locally — falling back to github raw)"
  base="https://raw.githubusercontent.com/your-org/formly/main/infra/systemd"
  curl -fsSL "$base/formly-api@.service" -o '/etc/systemd/system/formly-api@.service'
  curl -fsSL "$base/formly-web@.service" -o '/etc/systemd/system/formly-web@.service'
else
  install -m 644 "$UNIT_SRC/formly-api@.service" '/etc/systemd/system/formly-api@.service'
  install -m 644 "$UNIT_SRC/formly-web@.service" '/etc/systemd/system/formly-web@.service'
fi
systemctl daemon-reload

# Enable BOTH instances of each template. Enabling makes them start
# at boot — but we only enable the slot named in /opt/formly/<svc>/
# active. The OTHER slot stays disabled-at-boot; it only runs during
# a deploy (install-*.sh starts it explicitly via `systemctl restart`).
#
# Why not enable both: at boot we'd race two API servers fighting for
# port 8080/8081 — fine, ports differ — BUT we also don't want an
# idle slot booting after a kernel update and serving stale code
# behind the active nginx upstream once it gets swapped in.
ACTIVE_API=$(cat /opt/formly/api/active 2>/dev/null || echo blue)
ACTIVE_WEB=$(cat /opt/formly/web/active 2>/dev/null || echo blue)
systemctl enable "formly-api@${ACTIVE_API}.service" "formly-web@${ACTIVE_WEB}.service"
# Note: don't `--now` — the units will fail until the first deploy
# populates /opt/formly/<svc>/slots/<slot>. Enabling sets them to
# start automatically on boot AFTER the first deploy.

echo "==> [7/8] nginx (site config + upstream snippets)"
NGINX_SRC="$SCRIPT_DIR/../../infra/nginx"
install -d /etc/nginx/snippets
if [ -d "$NGINX_SRC" ]; then
  install -m 644 "$NGINX_SRC/snippets/formly-api-upstream.conf" /etc/nginx/snippets/formly-api-upstream.conf
  install -m 644 "$NGINX_SRC/snippets/formly-web-upstream.conf" /etc/nginx/snippets/formly-web-upstream.conf
  install -m 644 "$NGINX_SRC/formly.conf" /etc/nginx/sites-available/formly.conf
else
  base="https://raw.githubusercontent.com/your-org/formly/main/infra/nginx"
  curl -fsSL "$base/snippets/formly-api-upstream.conf" -o /etc/nginx/snippets/formly-api-upstream.conf
  curl -fsSL "$base/snippets/formly-web-upstream.conf" -o /etc/nginx/snippets/formly-web-upstream.conf
  curl -fsSL "$base/formly.conf" -o /etc/nginx/sites-available/formly.conf
fi

# Domain templating. If $DOMAIN is set, sed it in. Otherwise leave
# the placeholder and the operator does it later.
if [ -n "$DOMAIN" ]; then
  sed -i "s|__DOMAIN__|$DOMAIN|g" /etc/nginx/sites-available/formly.conf
fi

# Enable site + remove default. (default exposes a "Welcome to nginx"
# page on :80 which can confuse certbot if our config doesn't match.)
ln -sfn /etc/nginx/sites-available/formly.conf /etc/nginx/sites-enabled/formly.conf
rm -f /etc/nginx/sites-enabled/default

# Snakeoil cert so nginx -t succeeds before certbot runs. Ubuntu's
# ssl-cert package ships /etc/ssl/certs/ssl-cert-snakeoil.pem +
# /etc/ssl/private/ssl-cert-snakeoil.key. We splice them into the
# placeholder paths in formly.conf so the config parses; certbot
# will rewrite those lines on first run.
if [ -n "$DOMAIN" ]; then
  install -d "/etc/letsencrypt/live/$DOMAIN"
  if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    cp /etc/ssl/certs/ssl-cert-snakeoil.pem "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
    cp /etc/ssl/private/ssl-cert-snakeoil.key "/etc/letsencrypt/live/$DOMAIN/privkey.pem"
  fi
fi

# webroot for HTTP-01 challenges (formly.conf serves
# /.well-known/acme-challenge from /var/www/html).
install -d -o root -g root /var/www/html

if nginx -t 2>&1; then
  systemctl enable --now nginx
  systemctl reload nginx || true
else
  echo "WARN: nginx -t failed — fix /etc/nginx/sites-available/formly.conf"
  echo "      (likely missing __DOMAIN__ substitution). Then: systemctl reload nginx"
fi

# Open the firewall — just 22 (SSH), 80 (HTTP for ACME + redirect),
# and 443 (HTTPS). Everything else binds to 127.0.0.1 anyway.
ufw allow 22/tcp || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
yes | ufw enable || true

echo "==> [8/8] postgres"
sudo -u postgres psql <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='formly') THEN
    CREATE ROLE formly LOGIN PASSWORD 'CHANGE_ME_BEFORE_FIRST_DEPLOY';
  END IF;
END \$\$;
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='formly'" \
  | grep -q 1 || sudo -u postgres createdb -O formly formly
sudo -u postgres psql -d formly -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null

echo
echo "================================================================"
echo "  Bootstrap complete."
echo
echo "  NEXT STEPS:"
echo "    1. Add your GitHub Actions deploy key to:"
echo "         /home/deploy/.ssh/authorized_keys"
echo
echo "    2. Edit /opt/formly/api/env and /opt/formly/web/env."
echo "       At minimum:"
echo "         API:  DATABASE_URL password, JWT_SECRET, S3_*"
echo "         WEB:  NEXT_PUBLIC_API_URL"
echo "       (env.blue / env.green are pre-pinned to the right ports;"
echo "        do not edit unless you change the port scheme.)"
echo
echo "    3. Change the postgres password and update DATABASE_URL."
if [ "$WITH_OLLAMA" = "1" ]; then
echo
echo "    4. Pull Ollama models:"
echo "         sudo bash scripts/deploy/setup-ollama-models.sh"
echo "       Then flip AI_ENABLED=true in /opt/formly/api/env."
fi
n=$([ "$WITH_OLLAMA" = "1" ] && echo 5 || echo 4)
echo
echo "    $n. Point DNS A records at this VPS:"
echo "         <your-domain>      → \$(public IP)"
echo "         api.<your-domain>  → \$(public IP)"
echo "       Then provision certs (overwrites the snakeoil placeholders):"
echo "         sudo certbot --nginx -d <your-domain> -d www.<your-domain> -d api.<your-domain>"
if [ -z "$DOMAIN" ]; then
echo "       Also: replace __DOMAIN__ in /etc/nginx/sites-available/formly.conf"
echo "         sudo sed -i 's/__DOMAIN__/<your-domain>/g' /etc/nginx/sites-available/formly.conf"
echo "         sudo nginx -t && sudo systemctl reload nginx"
fi
n=$((n + 1))
echo
echo "    $n. Push a 'release-v0.0.1' tag to trigger the first deploy."
echo "       The deploy will land on the IDLE slot (green) first; once"
echo "       it's healthy, nginx swaps and the active slot becomes green."
echo "================================================================"
