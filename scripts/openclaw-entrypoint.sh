#!/bin/sh
set -e

CONFIG_DIR="/home/node/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"

mkdir -p "$CONFIG_DIR"

VLLM_BASE=$(echo "${VLLM_URL:-https://llm.agentic-ai-gist.org}" | sed 's|/$||')
MODEL_ID="${VLLM_MODEL:-google/gemma-4-26B-A4B-it}"
DISCORD_TOKEN_VAL="${DISCORD_TOKEN:-}"
DISCORD_GUILD_VAL="${DISCORD_GUILD_ID:-}"
CF_ID="${CF_ACCESS_CLIENT_ID:-}"
CF_SECRET="${CF_ACCESS_CLIENT_SECRET:-}"

# Extract vLLM hostname
VLLM_HOST=$(echo "$VLLM_BASE" | sed 's|https\?://||' | sed 's|/.*||')

# CF Access headers will be injected via provider "headers" config below
if [ -n "$CF_ID" ] && [ -n "$CF_SECRET" ]; then
  echo "[openclaw-entrypoint] CF Access headers will be set in provider config"
fi

# Register the teacher agent workspace (idempotent — skips if already exists)
if ! openclaw agents list --json 2>/dev/null | grep -q '"teacher"'; then
  openclaw agents add teacher \
    --workspace /workspace \
    --non-interactive \
    --model "${MODEL_ID}" 2>&1 || true
fi

# Always overwrite config — openclaw agents/gateway commands clobber it
cat > "$CONFIG_FILE" << EOFCONFIG
{
  "models": {
    "mode": "replace",
    "providers": {
      "vllm": {
        "baseUrl": "${VLLM_BASE}/v1",
        "api": "openai-completions",
        "apiKey": "EMPTY",
        "headers": {
          "CF-Access-Client-Id": "${CF_ID}",
          "CF-Access-Client-Secret": "${CF_SECRET}"
        },
        "models": [
          {"id": "${MODEL_ID}", "name": "Gemma 4"}
        ]
      }
    }
  },
  "channels": {
    "discord": {
      "enabled": true,
      "token": "${DISCORD_TOKEN_VAL}",
      "guilds": {"${DISCORD_GUILD_VAL}": {"requireMention": false}},
      "intents": {"presence": true, "guildMembers": true}
    }
  },
  "mcp": {
    "servers": {
      "runtime-api": {
        "command": "node",
        "args": ["/workspace/mcp-runtime/dist/index.js"],
        "cwd": "/workspace"
      }
    }
  }
}
EOFCONFIG

echo "[openclaw-entrypoint] Config written to $CONFIG_FILE"
echo "[openclaw-entrypoint] Model: ${MODEL_ID} via ${VLLM_BASE}/v1"
echo "[openclaw-entrypoint] Discord guild: ${DISCORD_GUILD_VAL}"

# Start OpenClaw gateway in foreground
exec openclaw gateway run --allow-unconfigured
