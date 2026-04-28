#!/usr/bin/env bash
# decrypt.sh — decrypt all *.sops files into their plaintext siblings.
#
# Run after pulling main, or when you need a fresh local .env.
# Plaintext outputs are gitignored — they're for local processes only.
#
#   ./scripts/secrets/decrypt.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ -z "${SOPS_AGE_KEY_FILE:-}" ] && [ -f "$HOME/.config/sops/age/keys.txt" ]; then
  export SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"
fi

found=0
for src in infra/compose/.env.sops api/.env.sops; do
  [ -f "$src" ] || continue
  found=1
  dst="${src%.sops}"
  echo "decrypting $src → $dst"
  sops --decrypt --input-type dotenv --output-type dotenv "$src" > "$dst"
  chmod 600 "$dst"
done

[ "$found" = 1 ] || { echo "no *.sops files found yet"; exit 0; }
echo "done. Plaintext is chmod 600 and gitignored."
