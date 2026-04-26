#!/usr/bin/env bash
# install-web.sh — runs ON THE VPS, invoked by deploy.yml's
# `deploy-web` job after rsyncing source into /opt/formly/incoming/web/.
#
# Same blue-green pattern as install-api.sh: build into the IDLE
# slot, restart that slot, health-check on its loopback port, swap
# nginx, drain, stop old slot.
#
# We BUILD ON THE BOX (not on the runner) for three reasons:
#   • next-swc + sharp ship native binaries that must match the
#     server's libc; runner != VPS = subtle ABI mismatches.
#   • node_modules is huge; rsyncing source + lockfile and letting
#     the box `npm ci` is faster than transferring node_modules.
#   • .next/cache reuse between deploys (warm builds) only works
#     when the build runs where the cache lives.
#
# Layout:
#   /opt/formly/web/
#     env                          (shared, root:600)
#     env.blue                     PORT=3000 HOSTNAME=127.0.0.1
#     env.green                    PORT=3001 HOSTNAME=127.0.0.1
#     active                       "blue" or "green"
#     releases/<VERSION>/web/      built source
#     slots/blue,green/            → releases/<VERSION>/web

set -euo pipefail

VERSION="${VERSION:?VERSION env required (set by deploy.yml)}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
GRACE_SECONDS="${GRACE_SECONDS:-20}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"

INCOMING=/opt/formly/incoming/web
APP_ROOT=/opt/formly/web
RELEASES="$APP_ROOT/releases"
SLOTS="$APP_ROOT/slots"
TARGET="$RELEASES/$VERSION"
ACTIVE_FILE="$APP_ROOT/active"
UPSTREAM_CONF=/etc/nginx/snippets/formly-web-upstream.conf

declare -A PORT=( [blue]=3000 [green]=3001 )

echo "[install-web] version=$VERSION"

# --- 1. Pick idle slot --------------------------------------------
if [ -f "$ACTIVE_FILE" ]; then
  LIVE=$(cat "$ACTIVE_FILE")
else
  echo "[install-web] no active file — first deploy, treating blue as initial"
  LIVE=blue
  echo blue > "$ACTIVE_FILE"
fi
case "$LIVE" in
  blue)  IDLE=green ;;
  green) IDLE=blue ;;
  *) echo "[install-web] invalid active slot '$LIVE'"; exit 2 ;;
esac
LIVE_PORT=${PORT[$LIVE]}
IDLE_PORT=${PORT[$IDLE]}
echo "[install-web] live=$LIVE:$LIVE_PORT  idle=$IDLE:$IDLE_PORT"

# --- 2. Sanity-check incoming -------------------------------------
test -d "$INCOMING/web" || { echo "missing web/ in $INCOMING"; exit 2; }
test -f "$INCOMING/web/package.json" || { echo "missing package.json"; exit 2; }
test -f "$INCOMING/web/package-lock.json" || { echo "missing package-lock.json"; exit 2; }

# --- 3. Stage versioned release dir --------------------------------
mkdir -p "$RELEASES" "$SLOTS"
rm -rf "$TARGET/web"
mkdir -p "$TARGET"
cp -R "$INCOMING/web" "$TARGET/web"
[ -f "$INCOMING/RELEASE" ] && cp "$INCOMING/RELEASE" "$TARGET/RELEASE" || true

# Warm-cache trick: pull the previous release's .next/cache into the
# new release dir so `next build` can do an incremental compile.
# Build cache is content-addressed → safe to copy stale; Next just
# rebuilds the chunks it needs.
prev_target=$(readlink -f "$SLOTS/$LIVE" 2>/dev/null || true)
if [ -n "$prev_target" ] && [ -d "$prev_target/.next/cache" ]; then
  echo "[install-web] reusing previous .next/cache for warm build"
  mkdir -p "$TARGET/web/.next"
  cp -R "$prev_target/.next/cache" "$TARGET/web/.next/cache" || true
fi

# --- 4. Install + build inside the staged release dir --------------
cd "$TARGET/web"

echo "[install-web] npm ci…"
# Quiet npm — its progress bar fills CI logs with cursor sequences.
# --no-audit / --no-fund cut another ~5s off cold installs.
npm ci --no-audit --no-fund --loglevel=error

echo "[install-web] next build…"
# NEXT_PUBLIC_* env is baked into the bundle at build time. Source
# the shared env file so values are present during `next build`.
if [ -r /opt/formly/web/env ]; then
  set -a
  # shellcheck disable=SC1091
  . /opt/formly/web/env
  set +a
fi
npm run build

# --- 5. Repoint idle slot's symlink --------------------------------
ln -sfn "$TARGET/web" "$SLOTS/$IDLE"

# --- 6. Restart idle systemd instance ------------------------------
sudo systemctl daemon-reload
echo "[install-web] restarting formly-web@$IDLE …"
sudo systemctl restart "formly-web@$IDLE"

for i in $(seq 1 30); do
  state=$(systemctl is-active "formly-web@$IDLE" || true)
  if [ "$state" = "active" ]; then break; fi
  if [ "$state" = "failed" ]; then
    echo "[install-web] formly-web@$IDLE failed:"
    journalctl -u "formly-web@$IDLE" -n 80 --no-pager || true
    exit 1
  fi
  sleep 1
done

# --- 7. HTTP health check on idle's loopback port ------------------
# Next.js takes longer to be HTTP-ready than the Go API — JIT
# compile of the first route tree, etc. Hence the 60s default
# HEALTH_TIMEOUT (vs 30s for the API).
echo "[install-web] health-check 127.0.0.1:$IDLE_PORT/ …"
ok=0
for i in $(seq 1 "$HEALTH_TIMEOUT"); do
  # Any 2xx/3xx response means Next is serving. We deliberately
  # don't hit a specific app route — root '/' is enough to prove
  # the runtime is up. -o /dev/null discards the body.
  if curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:$IDLE_PORT/"; then
    ok=1
    echo "[install-web] healthy after ${i}s"
    break
  fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  echo "[install-web] idle slot $IDLE failed health check; aborting (live $LIVE still serving)"
  journalctl -u "formly-web@$IDLE" -n 80 --no-pager || true
  exit 1
fi

# --- 8. Atomically swap nginx upstream -----------------------------
# Build the new file in /tmp (deploy-user-writable), `sudo cp` next
# to the live file, then `sudo mv` (atomic same-fs rename).
TMP_CONF=$(mktemp /tmp/formly-web-upstream.XXXXXX)
cat > "$TMP_CONF" <<EOF
# formly-web-upstream.conf — REWRITTEN BY install-web.sh
# active slot: $IDLE (port $IDLE_PORT)
# updated:     $(date -u +%Y-%m-%dT%H:%M:%SZ)
upstream formly_web {
    # ACTIVE_SLOT=$IDLE
EOF
if [ "$IDLE" = "blue" ]; then
  cat >> "$TMP_CONF" <<'EOF'
    server 127.0.0.1:3000 max_fails=3 fail_timeout=10s;
    # server 127.0.0.1:3001 max_fails=3 fail_timeout=10s;
EOF
else
  cat >> "$TMP_CONF" <<'EOF'
    # server 127.0.0.1:3000 max_fails=3 fail_timeout=10s;
    server 127.0.0.1:3001 max_fails=3 fail_timeout=10s;
EOF
fi
cat >> "$TMP_CONF" <<'EOF'
    keepalive 32;
}
EOF

sudo cp "$TMP_CONF" "${UPSTREAM_CONF}.new"
rm -f "$TMP_CONF"
if ! sudo nginx -t -c /etc/nginx/nginx.conf 2>&1; then
  echo "[install-web] nginx -t failed; not swapping"
  sudo rm -f "${UPSTREAM_CONF}.new"
  exit 1
fi
sudo mv "${UPSTREAM_CONF}.new" "$UPSTREAM_CONF"
sudo nginx -s reload
echo "[install-web] nginx reloaded → $IDLE"

# --- 9. Mark new live, drain, stop old -----------------------------
# $ACTIVE_FILE is root:deploy 664 (set by bootstrap-vps.sh), so the
# deploy user can rewrite it without sudo.
echo "$IDLE" > "$ACTIVE_FILE"

echo "[install-web] sleeping ${GRACE_SECONDS}s for in-flight requests on old slot $LIVE…"
sleep "$GRACE_SECONDS"

echo "[install-web] stopping formly-web@$LIVE"
sudo systemctl stop "formly-web@$LIVE" || true

# Repoint the now-idle slot at the new release for steady-state
# parity. Next deploy lands on $LIVE again.
ln -sfn "$TARGET/web" "$SLOTS/$LIVE"

# --- 10. Prune old releases ---------------------------------------
blue_target=$(readlink -f "$SLOTS/blue" 2>/dev/null || true)
green_target=$(readlink -f "$SLOTS/green" 2>/dev/null || true)
# blue/green targets point at .../<VERSION>/web; the release dir is
# the parent. Compare parent dirs.
blue_release="${blue_target%/web}"
green_release="${green_target%/web}"
ls -1dt "$RELEASES"/*/ 2>/dev/null \
  | tail -n "+$((KEEP_RELEASES + 1))" \
  | while read -r dir; do
      dir="${dir%/}"
      if [ "$dir" = "$blue_release" ] || [ "$dir" = "$green_release" ]; then continue; fi
      echo "[install-web] pruning $dir"
      rm -rf "$dir"
    done

echo "[install-web] done. live=$IDLE"
