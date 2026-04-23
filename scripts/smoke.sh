#!/usr/bin/env bash
# End-to-end smoke test hitting the live API.
# Requires a running API on :8080 and a sample AcroForm PDF path.
set -euo pipefail

API="${API:-http://localhost:8080}"
EMAIL="smoke-$(date +%s)@example.com"
PASS="smoketest123"
PDF="${1:-/dev/stdin}"

if [ ! -f "$PDF" ]; then
  echo "usage: $0 <acroform.pdf>"
  exit 1
fi

log() { echo "→ $*"; }

log "register $EMAIL"
TOKEN=$(curl -fsS -X POST "$API/v1/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"name\":\"Smoke\"}" | jq -r .token)
AUTH="Authorization: Bearer $TOKEN"

log "request upload url"
UP=$(curl -fsS -X POST "$API/v1/files/upload-url" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$(basename "$PDF")\",\"mime\":\"application/pdf\"}")
FID=$(echo "$UP" | jq -r .fileId)
URL=$(echo "$UP" | jq -r .uploadUrl)

log "PUT to MinIO"
curl -fsS -X PUT -H 'Content-Type: application/pdf' --data-binary "@$PDF" "$URL" > /dev/null

log "complete (triggers detector)"
TID=$(curl -fsS -X POST "$API/v1/files/$FID/complete" -H "$AUTH" | jq -r '.templateId // empty')

if [ -z "$TID" ]; then
  echo "no AcroForm fields detected — pick a form PDF"
  exit 2
fi

log "template $TID — fetching fields"
curl -fsS "$API/v1/templates/$TID" -H "$AUTH" | jq '.fields | length as $n | "\($n) fields"'

log "generate with empty payload"
OUT=$(curl -fsS -X POST "$API/v1/templates/$TID/generate" \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"data":{}}' | jq -r .downloadUrl)
log "download URL: $OUT"

log "✓ smoke test passed"
