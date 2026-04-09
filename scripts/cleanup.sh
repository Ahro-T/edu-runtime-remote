#!/bin/bash
# cleanup.sh — Remove ALL traces from a shared NUC
# Designed for daily install/teardown cycles: clone → run → cleanup → repeat
# Usage: ./scripts/cleanup.sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_NAME="edu-runtime"

echo "========================================="
echo "  Edu Runtime — Full Cleanup"
echo "========================================="
echo ""
printf "  This will remove EVERYTHING: containers, volumes, images, project.\n"
printf "  Continue? (y/N) "
read confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "[cleanup] Aborted."
  exit 0
fi

# Container runtime detection
if [ "${CONTAINER_RUNTIME:-}" = "podman" ]; then
  COMPOSE="sudo podman-compose"
  CONTAINER="sudo podman"
else
  COMPOSE="docker compose"
  CONTAINER="docker"
fi

# 1. Stop and remove containers + volumes + networks
echo ""
echo "[1/6] Stopping containers and removing volumes..."
cd "$PROJECT_ROOT"
$COMPOSE down -v --remove-orphans --rmi local 2>/dev/null || true

# 2. Remove project-specific Docker images (built by compose)
echo "[2/6] Removing project Docker images..."
$CONTAINER images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
  | grep -E "^${PROJECT_NAME}" \
  | xargs -r $CONTAINER rmi -f 2>/dev/null || true
# Also remove dangling images from multi-stage builds
$CONTAINER image prune -f 2>/dev/null || true

# 3. Remove project-specific Docker volumes (if any survived)
echo "[3/6] Removing orphan volumes..."
$CONTAINER volume ls --format '{{.Name}}' 2>/dev/null \
  | grep -E "^${PROJECT_NAME}" \
  | xargs -r $CONTAINER volume rm -f 2>/dev/null || true

# 4. Remove Claude Code (all known paths)
echo "[4/6] Removing Claude Code..."
rm -rf "$HOME/.claude" 2>/dev/null || true
rm -f "$HOME/.claude.json" 2>/dev/null || true
rm -rf "$HOME/.config/claude" 2>/dev/null || true
rm -f "$HOME/.local/bin/claude" 2>/dev/null || true
rm -rf "$HOME/.local/share/claude" 2>/dev/null || true
# Remove Claude installer's PATH addition from shell profiles
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  if [ -f "$rc" ]; then
    sed -i '/# Added by Claude/d' "$rc" 2>/dev/null || true
    sed -i '/\.local\/bin.*claude/d' "$rc" 2>/dev/null || true
  fi
done

# 5. Remove npm/node artifacts if local dev was used
echo "[5/6] Removing local dev artifacts..."
rm -rf "$PROJECT_ROOT/node_modules" 2>/dev/null || true
rm -rf "$PROJECT_ROOT/dist" 2>/dev/null || true
rm -rf "$PROJECT_ROOT/.omc" 2>/dev/null || true
rm -f "$PROJECT_ROOT/.env" 2>/dev/null || true

# 6. Remove the project directory itself
echo "[6/6] Removing project directory..."
cd /
rm -rf "$PROJECT_ROOT"

echo ""
echo "========================================="
echo "  Clean slate. No traces left."
echo ""
echo "  To start fresh:"
echo "    git clone <repo> && cd edu-runtime-remote"
echo "    ./scripts/setup-dev.sh"
echo "    ./scripts/start.sh"
echo "========================================="
