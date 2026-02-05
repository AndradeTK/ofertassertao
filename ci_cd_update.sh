#!/bin/bash
# CI/CD auto-update script for docker-compose deployment
# Pulls latest code from GitHub and restarts the app if there are changes

set -e

REPO_DIR="$(dirname "$0")"
cd "$REPO_DIR"

echo "[CI/CD] Pulling latest code from GitHub..."
git fetch origin
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u})
BASE=$(git merge-base @ @{u})

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[CI/CD] Already up to date. No action needed."
elif [ "$LOCAL" = "$BASE" ]; then
  echo "[CI/CD] New updates found. Pulling and restarting containers..."
  git pull
  docker-compose down
  docker-compose up -d --build
  echo "[CI/CD] Update complete."
else
  echo "[CI/CD] Local changes detected. Please resolve manually."
  exit 1
fi
