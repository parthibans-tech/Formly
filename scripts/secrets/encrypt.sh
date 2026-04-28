#!/usr/bin/env bash
# encrypt.sh — encrypt a plaintext .env into its committed .env.sops sibling.
#
# Usage:
#   ./scripts/secrets/encrypt.sh infra/compose/.env
#   ./scripts/secrets/encrypt.sh api/.env
#
# Reads .sops.yaml at repo root for recipients. Writes <input>.sops.
# Input file is left untouched — delete it manually after verifying.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# sops on macOS doesn't search ~/.config by default. Point it at the
# bootstrap-created keyfile if the env var isn't already set.
if [ -z "${SOPS_AGE_KEY_FILE:-}" ] && [ -f "$HOME/.config/sops/age/keys.txt" ]; then
  export SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"
fi

src="${1:-}"
[ -n "$src" ] && [ -f "$src" ] || { echo "usage: $0 <path-to-plaintext-.env>"; exit 1; }

dst="${src}.sops"
echo "encrypting $src → $dst"
# --filename-override tells sops which path to match against
# .sops.yaml creation_rules. Without it, rules match `api/.env`
# (the input) instead of `api/.env.sops` (the destination).
sops --encrypt --input-type dotenv --output-type dotenv \
  --filename-override "$dst" "$src" > "$dst"
echo "done. Commit $dst, then delete $src locally if you don't need the plaintext."
