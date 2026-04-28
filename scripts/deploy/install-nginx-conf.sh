#!/usr/bin/env bash
# install-nginx-conf.sh — VPS-side helper to install the Drive360 nginx
# config from the staging path into /etc/nginx and reload.
#
# Lives at /usr/local/sbin/install-drive360-nginx on the VPS (installed
# once during VPS bootstrap). Granted passwordless sudo for the deploy
# user via /etc/sudoers.d/deploy-nginx — the deploy CI job is the
# ONLY caller in production.
#
#   /etc/sudoers.d/deploy-nginx:
#     deploy ALL=(root) NOPASSWD: /usr/local/sbin/install-drive360-nginx
#
# Refuses to reload if `nginx -t` fails — bad config never lands.

set -euo pipefail

STAGING="/home/deploy/drive360-nginx.conf"
TARGET="/etc/nginx/sites-available/drive360"
ENABLED="/etc/nginx/sites-enabled/drive360"

[ -f "$STAGING" ] || { echo "no staged config at $STAGING"; exit 1; }

# Atomic replace: write to a tmp, validate, then mv into place. If
# nginx -t fails on the temporary location nginx never sees the bad
# file because sites-enabled still points at the previous good one.
install -m 0644 -o root -g root "$STAGING" "$TARGET.new"

# Swap the symlink target temporarily so `nginx -t` validates the
# CANDIDATE file, not the live one.
ln -sfn "$TARGET.new" "$ENABLED"

if ! nginx -t; then
  echo "nginx config invalid — rolling back"
  ln -sfn "$TARGET" "$ENABLED"
  rm -f "$TARGET.new"
  exit 1
fi

mv "$TARGET.new" "$TARGET"
ln -sfn "$TARGET" "$ENABLED"

systemctl reload nginx
echo "nginx reloaded with new Drive360 config"
rm -f "$STAGING"
