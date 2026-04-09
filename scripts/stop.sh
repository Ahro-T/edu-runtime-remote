#!/bin/bash
# stop.sh — Stop containers (data preserved)
# Use cleanup.sh for full removal
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Container runtime detection
if [ "${CONTAINER_RUNTIME:-}" = "podman" ]; then
  COMPOSE="sudo podman-compose"
  CONTAINER="sudo podman"
else
  COMPOSE="docker-compose"
  CONTAINER="docker"
fi

echo "[stop] Stopping edu-runtime..."
$COMPOSE -p edu-runtime down --remove-orphans 2>/dev/null || true

echo ""
echo "========================================="
echo "  Edu Runtime stopped — data preserved"
echo "  cleanup.sh for full removal"
echo "========================================="
