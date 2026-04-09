#!/bin/bash
# stop.sh — Stop containers (data preserved in volumes)
# Use cleanup.sh for full removal including data
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Container runtime detection
if [ "${CONTAINER_RUNTIME:-}" = "podman" ]; then
  COMPOSE="sudo podman-compose"
else
  COMPOSE="docker compose"
fi

echo "[stop] Stopping edu-runtime..."
$COMPOSE down --remove-orphans 2>/dev/null || true

echo ""
echo "========================================="
echo "  Edu Runtime stopped — data preserved"
echo "  ./scripts/start.sh   — restart"
echo "  ./scripts/cleanup.sh — full removal"
echo "========================================="
