#!/bin/bash
# setup-dev.sh — Set up dev environment on a shared NUC (no Node required)
# Usage: ./scripts/setup-dev.sh
set -eu

echo "========================================="
echo "  Edu Runtime — Dev Setup"
echo "========================================="

# Install Claude Code (standalone, no npm)
if command -v claude >/dev/null 2>&1; then
  echo "[setup] Claude Code already installed"
else
  echo "[setup] Installing Claude Code..."
  curl -fsSL https://claude.ai/install.sh | sh
fi

# Interactive .env setup
if [ -f .env ]; then
  printf "[setup] .env already exists. Overwrite? (y/N) "
  read overwrite
  if [ "$overwrite" != "y" ] && [ "$overwrite" != "Y" ]; then
    echo "[setup] Keeping existing .env"
    echo ""
    echo "========================================="
    echo "  Ready!"
    echo "========================================="
    echo "  ./scripts/start.sh    — start runtime"
    echo "  claude                — start coding"
    echo "  ./scripts/cleanup.sh  — remove everything"
    echo "========================================="
    exit 0
  fi
fi

echo ""
echo "[setup] Creating .env — press Enter to use default"
echo ""

printf "VLLM_URL [https://llm.agentic-ai-gist.org]: "
read vllm_url
vllm_url="${vllm_url:-https://llm.agentic-ai-gist.org}"

printf "VLLM_MODEL [google/gemma-4-26B-A4B-it]: "
read vllm_model
vllm_model="${vllm_model:-google/gemma-4-26B-A4B-it}"

printf "CF_ACCESS_CLIENT_ID (Cloudflare Access, skip if not needed): "
read cf_client_id
cf_client_id="${cf_client_id:-}"

printf "CF_ACCESS_CLIENT_SECRET (Cloudflare Access, skip if not needed): "
read cf_client_secret
cf_client_secret="${cf_client_secret:-}"

printf "Discord bot token (skip if not using Discord): "
read discord_token
discord_token="${discord_token:-}"

printf "Discord guild ID (skip if not using Discord): "
read discord_guild
discord_guild="${discord_guild:-}"

printf "LOG_LEVEL [info]: "
read log_level
log_level="${log_level:-info}"

cat > .env << EOF
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/edu_runtime
VAULT_PATH=/app/wiki-vault
VLLM_URL=${vllm_url}
VLLM_MODEL=${vllm_model}
CF_ACCESS_CLIENT_ID=${cf_client_id}
CF_ACCESS_CLIENT_SECRET=${cf_client_secret}
OPENCLAW_DISCORD_TOKEN=${discord_token}
OPENCLAW_DISCORD_GUILD_ID=${discord_guild}
LOG_LEVEL=${log_level}
PORT=3000
EOF

echo ""
echo "[setup] .env created"

echo ""
echo "========================================="
echo "  Ready!"
echo "========================================="
echo "  ./scripts/start.sh    — start runtime"
echo "  claude                — start coding"
echo "  ./scripts/cleanup.sh  — remove everything"
echo "========================================="
