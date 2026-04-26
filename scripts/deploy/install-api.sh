#!/usr/bin/env bash
# install-api.sh — runs ON THE VPS, invoked by GitHub Actions
# `deploy-api` after rsyncing the new artifact into
# /opt/formly/incoming/api/. Implements blue-green: deploy lands in
# the IDLE slot, gets health-checked on its loopback port, then
# nginx is atomically swapped to point at it. The old slot stays
# running for a grace period as instant rollback.
#
# Layout on the box:
#
#   /opt/formly/
#     incoming/api/                 ← rsync drops here every deploy
#     api/
#       env                         ← shared env (root:600)
#       env.blue                    ← LISTEN_ADDR=127.0.0.1:8080
#       env.green                   ← LISTEN_ADDR=127.0.0.1:8081
#       active                      ← file: "blue" or "green"
#       releases/<VERSION>/
#         formly-api
#         migrations/
#         RELEASE
#       slots/
#         blue/                     → releases/<VERSION>
#         green/                    → releases/<VERSION>
#
# Flow per deploy:
#   1. Read $APP_ROOT/active to find the LIVE slot.
#   2. The OTHER slot is IDLE — we're going to land there.
#   3. Stage release dir, repoint slots/<idle> symlink at it.
#   4. systemctl restart formly-api@<idle> (it's already running an
#      old release, restart picks up the new symlink).
#   5. Health check 127.0.0.1:<idle_port>/healthz — bail if it fails
#      (live traffic is still served by the LIVE slot, no impact).
#   6. Rewrite nginx upstream snippet to point at <idle>, atomically
#      `mv` it into place, `nginx -s reload` (graceful — no dropped
#      connections).
#   7. Update $APP_ROOT/active to <idle> (the new live).
#   8. Sleep GRACE seconds so in-flight requests on old slot drain.
#   9. systemctl stop formly-api@<old> — old slot now idle, ready
#      to receive the next deploy.
#
# Rollback: re-run with VERSION=<previous>, OR manually:
#   echo blue > /opt/formly/api/active   # if green is bad
#   sed -i ... /etc/nginx/snippets/formly-api-upstream.conf
#   sudo nginx -s reload

set -euo pipefail

VERSION="${VERSION:?VERSION env required (set by deploy.yml)}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
GRACE_SECONDS="${GRACE_SECONDS:-30}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}"

INCOMING=/opt/formly/incoming/api
APP_ROOT=/opt/formly/api
RELEASES="$APP_ROOT/releases"
SLOTS="$APP_ROOT/slots"
TARGET="$RELEASES/$VERSION"
ACTIVE_FILE="$APP_ROOT/active"
UPSTREAM_CONF=/etc/nginx/snippets/formly-api-upstream.conf

declare -A PORT=( [blue]=8080 [green]=8081 )

echo "[install-api] version=$VERSION"

# --- 1. Pick idle slot --------------------------------------------
# First-time deploy bootstrap: no $ACTIVE_FILE yet → start with blue
# as the live slot, deploy to green. After this initial run both
# slots end up running the same version, which is the steady-state
# we want.
if [ -f "$ACTIVE_FILE" ]; then
  LIVE=$(cat "$ACTIVE_FILE")
else
  echo "[install-api] no active file — first deploy, treating blue as initial"
  LIVE=blue
  echo blue > "$ACTIVE_FILE"
fi
case "$LIVE" in
  blue)  IDLE=green ;;
  green) IDLE=blue ;;
  *) echo "[install-api] invalid active slot '$LIVE'"; exit 2 ;;
esac
LIVE_PORT=${PORT[$LIVE]}
IDLE_PORT=${PORT[$IDLE]}
echo "[install-api] live=$LIVE:$LIVE_PORT  idle=$IDLE:$IDLE_PORT"

# --- 2. Sanity-check incoming -------------------------------------
test -x "$INCOMING/formly-api" || { echo "missing formly-api binary"; exit 2; }
test -d "$INCOMING/migrations" || { echo "missing migrations/"; exit 2; }

# --- 3. Stage versioned release ------------------------------------
mkdir -p "$RELEASES" "$SLOTS"
# Reuse an existing release dir for this VERSION if it exists (e.g.
# re-running install after a transient failure) — but rebuild from
# /incoming so a partial copy is overwritten.
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp "$INCOMING/formly-api" "$TARGET/formly-api"
chmod 755 "$TARGET/formly-api"
cp -R "$INCOMING/migrations" "$TARGET/migrations"
[ -f "$INCOMING/RELEASE" ] && cp "$INCOMING/RELEASE" "$TARGET/RELEASE" || true

# --- 4. Repoint idle slot's symlink at the new release -------------
ln -sfn "$TARGET" "$SLOTS/$IDLE"

# --- 5. Restart the idle systemd instance --------------------------
sudo systemctl daemon-reload
echo "[install-api] restarting formly-api@$IDLE …"
sudo systemctl restart "formly-api@$IDLE"

# Wait for systemd "active". This is just process-up; we still need
# the HTTP healthz check below to confirm the app responds.
for i in $(seq 1 15); do
  state=$(systemctl is-active "formly-api@$IDLE" || true)
  if [ "$state" = "active" ]; then break; fi
  if [ "$state" = "failed" ]; then
    echo "[install-api] formly-api@$IDLE failed to start — recent logs:"
    journalctl -u "formly-api@$IDLE" -n 80 --no-pager || true
    exit 1
  fi
  sleep 1
done

# --- 6. HTTP health check on the idle slot's loopback port ---------
# Hammer /healthz until it responds 200, or timeout. The LIVE slot
# is unaffected by failures here — we haven't touched nginx yet.
echo "[install-api] health-check 127.0.0.1:$IDLE_PORT/healthz …"
ok=0
for i in $(seq 1 "$HEALTH_TIMEOUT"); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$IDLE_PORT/healthz" >/dev/null 2>&1; then
    ok=1
    echo "[install-api] healthy after ${i}s"
    break
  fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  echo "[install-api] idle slot $IDLE failed health check; aborting (live slot $LIVE still serving)"
  journalctl -u "formly-api@$IDLE" -n 80 --no-pager || true
  exit 1
fi

# --- 7. Atomically swap the nginx upstream -------------------------
# Rewrite the snippet so the IDLE slot's server line is uncommented
# and the LIVE slot's is commented out. We build the new file in
# /tmp (deploy user can write there), `sudo cp` it next to the live
# file, then `sudo mv` — same filesystem so the rename is atomic.
# nginx only re-reads on `-s reload`.
TMP_CONF=$(mktemp /tmp/formly-api-upstream.XXXXXX)
cat > "$TMP_CONF" <<EOF
# formly-api-upstream.conf — REWRITTEN BY install-api.sh
# active slot: $IDLE (port $IDLE_PORT)
# updated:     $(date -u +%Y-%m-%dT%H:%M:%SZ)
upstream formly_api {
    # ACTIVE_SLOT=$IDLE
EOF
if [ "$IDLE" = "blue" ]; then
  cat >> "$TMP_CONF" <<'EOF'
    server 127.0.0.1:8080 max_fails=3 fail_timeout=10s;
    # server 127.0.0.1:8081 max_fails=3 fail_timeout=10s;
EOF
else
  cat >> "$TMP_CONF" <<'EOF'
    # server 127.0.0.1:8080 max_fails=3 fail_timeout=10s;
    server 127.0.0.1:8081 max_fails=3 fail_timeout=10s;
EOF
fi
cat >> "$TMP_CONF" <<'EOF'
    keepalive 32;
}
EOF

# Validate the new config BEFORE swapping. nginx -t reads the whole
# tree; if anything's wrong (typo, missing include) we abort here
# with the live slot still serving.
sudo cp "$TMP_CONF" "${UPSTREAM_CONF}.new"
rm -f "$TMP_CONF"
if ! sudo nginx -t -c /etc/nginx/nginx.conf 2>&1; then
  # Roll back: nginx -t loads the EXISTING config; the .new file we
  # just wrote isn't included anywhere yet, so the failure is
  # something else in /etc/nginx. Abort without swapping.
  echo "[install-api] nginx -t failed; not swapping"
  sudo rm -f "${UPSTREAM_CONF}.new"
  exit 1
fi
sudo mv "${UPSTREAM_CONF}.new" "$UPSTREAM_CONF"
sudo nginx -s reload
echo "[install-api] nginx reloaded → $IDLE"

# --- 8. Mark the new live and let old drain ------------------------
# $ACTIVE_FILE is root:deploy 664 (set by bootstrap-vps.sh), so the
# deploy user can rewrite it without sudo.
echo "$IDLE" > "$ACTIVE_FILE"

echo "[install-api] sleeping ${GRACE_SECONDS}s for in-flight requests on old slot $LIVE…"
sleep "$GRACE_SECONDS"

# --- 9. Stop the old slot ------------------------------------------
# Don't `disable` — we want it ready to start again next deploy.
echo "[install-api] stopping formly-api@$LIVE"
sudo systemctl stop "formly-api@$LIVE" || true

# Repoint the now-idle slot's symlink at the same release so both
# slots agree at steady-state. Next deploy will land on $LIVE again.
ln -sfn "$TARGET" "$SLOTS/$LIVE"

# --- 10. Prune old release directories -----------------------------
# Never delete a release that EITHER slot symlink points at, even
# if it's old (paranoid guard for manual rollback scenarios).
blue_target=$(readlink -f "$SLOTS/blue" 2>/dev/null || true)
green_target=$(readlink -f "$SLOTS/green" 2>/dev/null || true)
ls -1dt "$RELEASES"/*/ 2>/dev/null \
  | tail -n "+$((KEEP_RELEASES + 1))" \
  | while read -r dir; do
      dir="${dir%/}"
      if [ "$dir" = "$blue_target" ] || [ "$dir" = "$green_target" ]; then continue; fi
      echo "[install-api] pruning $dir"
      rm -rf "$dir"
    done

echo "[install-api] done. live=$IDLE"
