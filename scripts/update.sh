#!/usr/bin/env bash
# Auto-update a Beekeeper deployment installed as a macOS LaunchAgent.
#
# Idempotent and safe to run from cron/launchd: bails out early with exit 0
# when there are no new upstream commits, so the common case is cheap. On
# an update it runs: git pull --ff-only, npm ci, npm run build, beekeeper
# install, launchctl kickstart.
#
# Usage: scripts/update.sh [CONFIG_DIR]
#   CONFIG_DIR  Path to beekeeper config directory
#               (default: $HOME/.beekeeper)
#
# Environment:
#   BEEKEEPER_LABEL          LaunchAgent label to kickstart
#                            (default: io.keepur.beekeeper)
#   BEEKEEPER_UPDATE_BRANCH  Branch that must be checked out for updates
#                            to proceed (default: main). Override if you
#                            intentionally track a non-main branch.

set -euo pipefail

CONFIG_DIR="${1:-$HOME/.beekeeper}"
LABEL="${BEEKEEPER_LABEL:-io.keepur.beekeeper}"
EXPECTED_BRANCH="${BEEKEEPER_UPDATE_BRANCH:-main}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '[beekeeper-update] %s\n' "$*"; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "$EXPECTED_BRANCH" ]]; then
  log "checked out branch is '$BRANCH', expected '$EXPECTED_BRANCH'; refusing to auto-update"
  log "set BEEKEEPER_UPDATE_BRANCH='$BRANCH' to override"
  exit 1
fi

log "fetching origin"
git fetch --quiet origin "$EXPECTED_BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$EXPECTED_BRANCH")"

if [[ "$LOCAL" == "$REMOTE" ]]; then
  log "already up to date ($LOCAL)"
  exit 0
fi

log "updating ${LOCAL:0:12} -> ${REMOTE:0:12}"
git pull --ff-only --quiet

log "npm ci"
npm ci --silent

log "npm run build"
npm run build --silent

log "beekeeper install $CONFIG_DIR"
node dist/cli.js install "$CONFIG_DIR"

log "restart LaunchAgent $LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

log "done — now at ${REMOTE:0:12}"
