#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <github-repo-url> [branch]"
  echo "Example: $0 https://github.com/acme/openclaw-sequence-dashboard-plugin.git main"
  exit 1
fi

REPO_URL="$1"
BRANCH="${2:-main}"
TMP_DIR="/tmp/openclaw-sequence-dashboard-plugin-$RANDOM"

git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$TMP_DIR"
openclaw plugins install "$TMP_DIR"

echo "Installed plugin from: $REPO_URL#$BRANCH"
echo "Temporary clone path: $TMP_DIR"
echo "You can remove it after confirming installation."
