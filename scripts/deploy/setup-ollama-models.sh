#!/usr/bin/env bash
# setup-ollama-models.sh — pull the Ollama models the API uses.
# Run AS ROOT (or via sudo). Idempotent: re-running just verifies
# that each model is present, and if a newer tag exists upstream
# `ollama pull` fetches the diff. Safe to run on a cron if you want
# automatic model updates (rare; we don't recommend it).
#
# This is split out from bootstrap-vps.sh because:
#   • Models are 2–7 GB each; you don't want to redownload them
#     every time you re-run the bootstrap to fix something else.
#   • Which models you want is workload-specific — the defaults
#     here match the env file template, but you may swap in larger
#     ones (llama3.1:8b, qwen2.5:7b) if your VPS has the RAM.
#   • Pulling in a separate step lets you watch progress and cancel
#     cleanly if disk runs low.
#
# Customising:
#   CHAT_MODEL=llama3.1:8b ./setup-ollama-models.sh
#   EMBED_MODEL=mxbai-embed-large ./setup-ollama-models.sh
#   VISION_MODEL=llava:7b ./setup-ollama-models.sh   # only if you
#                                                      use vision
#   PULL_VISION=1 ./setup-ollama-models.sh           # opt-in
#
# After pulling, remember to:
#   1. Update AI_CHAT_MODEL / AI_EMBED_MODEL / AI_VISION_MODEL in
#      /opt/formly/api/env to match what you pulled.
#   2. Flip AI_ENABLED=true.
#   3. sudo systemctl restart formly-api

set -euo pipefail

if ! command -v ollama >/dev/null 2>&1; then
  echo "ollama not installed. Re-run bootstrap-vps.sh with WITH_OLLAMA=1 first."
  exit 1
fi

CHAT_MODEL="${CHAT_MODEL:-llama3.2:3b}"
EMBED_MODEL="${EMBED_MODEL:-nomic-embed-text}"
VISION_MODEL="${VISION_MODEL:-llava:7b}"
PULL_VISION="${PULL_VISION:-0}"

# Quick disk-space sanity check. Models live under
# /usr/share/ollama/.ollama/models by default. We want at least 8 GB
# free before pulling — refuses if less, since a half-pulled model
# wedges the engine until manually cleared.
free_gb=$(df -BG --output=avail /usr/share/ollama 2>/dev/null | tail -1 | tr -d 'G ' || echo 0)
if [ "${free_gb:-0}" -lt 8 ]; then
  echo "WARN: only ${free_gb} GB free under /usr/share/ollama — pulling may fail."
  echo "      free up space or set OLLAMA_MODELS=/path/with/space and retry."
fi

pull_one() {
  local model="$1"
  local label="$2"
  echo
  echo "==> $label: $model"
  # `ollama pull` is idempotent: if the model is already present at
  # the requested tag, it short-circuits with "up to date".
  ollama pull "$model"
  # Verify by listing — guards against the pull "succeeding" but the
  # registry returning a corrupt manifest (rare, but seen).
  ollama list | awk '{print $1}' | grep -qx "$model" \
    || { echo "ERROR: $model not found in 'ollama list' after pull"; exit 1; }
}

pull_one "$CHAT_MODEL"  "chat model"
pull_one "$EMBED_MODEL" "embedding model"
if [ "$PULL_VISION" = "1" ]; then
  pull_one "$VISION_MODEL" "vision model"
else
  echo
  echo "(skipped vision model: set PULL_VISION=1 to fetch $VISION_MODEL)"
fi

# Warm the chat model into RAM so the first user request doesn't
# pay the cold-load tax. Ollama keeps a model loaded for ~5 min by
# default; this is a "make the next deploy's smoke test fast" step
# more than a long-term thing.
echo
echo "==> warming $CHAT_MODEL"
curl -fsS --max-time 120 http://127.0.0.1:11434/api/generate \
  -d "$(printf '{"model":"%s","prompt":"hi","stream":false}' "$CHAT_MODEL")" \
  >/dev/null && echo "(warmed)"

echo
echo "================================================================"
echo "  Models ready."
echo
echo "  Verify with:    ollama list"
echo
echo "  Update /opt/formly/api/env:"
echo "    AI_ENABLED=true"
echo "    AI_CHAT_MODEL=$CHAT_MODEL"
echo "    AI_EMBED_MODEL=$EMBED_MODEL"
[ "$PULL_VISION" = "1" ] && echo "    AI_VISION_MODEL=$VISION_MODEL"
echo
echo "  Then:    sudo systemctl restart formly-api"
echo "================================================================"
