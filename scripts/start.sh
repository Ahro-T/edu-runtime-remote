#!/bin/bash
# start.sh — Start the Edu runtime stack (remote vLLM)
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Container runtime detection
if [ "${CONTAINER_RUNTIME:-}" = "podman" ]; then
  COMPOSE="sudo podman-compose"
  CONTAINER="sudo podman"
else
  COMPOSE="docker compose"
  CONTAINER="docker"
fi

# Load .env if present
if [ -f .env ]; then
  echo "[start] Loading .env"
else
  echo "[start] No .env found. Run ./scripts/setup-dev.sh first."
  exit 1
fi

PROJECT_NAME="edu-runtime"
API_PORT=3000
OPENCLAW_PORT=3100
PG_PORT=5432

echo "[start] Building and starting Edu stack (${CONTAINER_RUNTIME:-docker})..."
$COMPOSE -p "$PROJECT_NAME" up -d --build

echo ""
echo "[start] Waiting for postgres to be healthy..."
for i in $(seq 1 30); do
  if $COMPOSE -p "$PROJECT_NAME" exec -T postgres pg_isready -U postgres -d edu_runtime > /dev/null 2>&1; then
    echo "[start] postgres: healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[start] ERROR: postgres did not become healthy in 60s"
    exit 1
  fi
  sleep 2
done

echo "[start] Waiting for app to be healthy..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${API_PORT}/health" > /dev/null 2>&1; then
    echo "[start] app: healthy (http://localhost:${API_PORT})"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[start] ERROR: app did not become healthy in 60s"
    exit 1
  fi
  sleep 2
done

echo ""
echo "========================================="
echo "  Edu Runtime is running"
echo "========================================="
echo "  API:       http://localhost:${API_PORT}"
echo "  OpenClaw:  http://localhost:${OPENCLAW_PORT}"
echo "  Postgres:  localhost:${PG_PORT}"
echo ""
echo "  Stop:  ./scripts/stop.sh"
echo "========================================="
