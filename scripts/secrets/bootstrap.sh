#!/usr/bin/env bash
# bootstrap.sh — one-time SOPS + age setup for a new developer.
#
# Idempotent: re-running won't clobber an existing key.
#
# What it does:
#   1. Installs sops + age via Homebrew (no-op if present).
#   2. Generates an age keypair at ~/.config/sops/age/keys.txt
#      if you don't have one yet.
#   3. Prints your PUBLIC key so you can add it to .sops.yaml.
#
# The PRIVATE key never leaves your machine. Treat keys.txt like
# an SSH private key — chmod 600, no cloud sync, no committing.

set -euo pipefail

KEY_DIR="${HOME}/.config/sops/age"
KEY_FILE="$KEY_DIR/keys.txt"

echo "==> [1/3] sops + age"
if ! command -v sops >/dev/null 2>&1 || ! command -v age-keygen >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install sops age
  else
    echo "Install sops + age manually:"
    echo "  Linux:  apt install age && curl -L https://github.com/getsops/sops/releases/latest/download/sops-v3.9.0.linux.amd64 -o /usr/local/bin/sops && chmod +x /usr/local/bin/sops"
    echo "  macOS:  brew install sops age"
    exit 1
  fi
else
  echo "(sops $(sops --version 2>&1 | head -1) and age already installed)"
fi

echo "==> [2/3] age keypair"
if [ -f "$KEY_FILE" ]; then
  echo "(existing key at $KEY_FILE — not overwriting)"
else
  install -d -m 700 "$KEY_DIR"
  age-keygen -o "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "(generated new key at $KEY_FILE)"
fi

PUBKEY=$(grep '^# public key:' "$KEY_FILE" | awk '{print $4}')

echo "==> [3/3] next steps"
cat <<EOF

================================================================
  Your age PUBLIC key:

    $PUBKEY

  Add it to .sops.yaml under the 'age:' list:

    age:
      - $PUBKEY  # $(whoami)

  Then re-key existing encrypted files so you can decrypt them:

    sops updatekeys infra/compose/.env.sops
    sops updatekeys api/.env.sops

  (Skip the updatekeys step if no encrypted files exist yet —
   you'll be a recipient on the first \`sops -e\` instead.)

  ── Daily workflow ──
    Edit:        sops infra/compose/.env.sops
    Decrypt:     ./scripts/secrets/decrypt.sh
    Encrypt new: ./scripts/secrets/encrypt.sh <plaintext-path>

  ── CI ──
    The runner needs ITS OWN keypair. Generate it on any machine,
    add the pubkey to .sops.yaml, then push the PRIVATE key as
    GitHub secret SOPS_AGE_KEY:

      age-keygen -o /tmp/ci-key.txt
      gh secret set SOPS_AGE_KEY < /tmp/ci-key.txt
      shred -u /tmp/ci-key.txt
================================================================
EOF
