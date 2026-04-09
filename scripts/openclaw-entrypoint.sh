#!/bin/sh
set -e

CONFIG_DIR="/home/node/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"

mkdir -p "$CONFIG_DIR"

# Only generate config if it doesn't already exist
if [ ! -f "$CONFIG_FILE" ]; then
  VLLM_BASE="${VLLM_URL:-https://llm.agentic-ai-gist.org}"
  MODEL_ID="${VLLM_MODEL:-google/gemma-4-27b-it}"
  DISCORD_TOKEN_VAL="${DISCORD_TOKEN:-}"
  DISCORD_GUILD_VAL="${DISCORD_GUILD_ID:-}"

  cat > "$CONFIG_FILE" << EOFCONFIG
{
  "models": {
    "mode": "replace",
    "providers": {
      "vllm": {
        "baseUrl": "${VLLM_BASE}/v1",
        "api": "openai-completions",
        "apiKey": "EMPTY",
        "models": [
          {"id": "${MODEL_ID}", "name": "Gemma 4 27B"}
        ]
      }
    }
  },
  "channels": {
    "discord": {
      "enabled": true,
      "token": "${DISCORD_TOKEN_VAL}",
      "guilds": {"${DISCORD_GUILD_VAL}": {}},
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

  echo "[openclaw-entrypoint] Generated config at $CONFIG_FILE"
  echo "[openclaw-entrypoint] Model: ${MODEL_ID} via ${VLLM_BASE}"
  echo "[openclaw-entrypoint] MCP server: runtime-api (stdio)"
else
  echo "[openclaw-entrypoint] Using existing config at $CONFIG_FILE"
fi

# Start OpenClaw gateway
exec openclaw gateway start --workspace /workspace
