#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

openclaw plugins install "$ROOT_DIR"

echo "Installed plugin from local path: $ROOT_DIR"
echo "Now ensure ~/.openclaw/openclaw.json contains plugins.entries.openclaw-sequence-dashboard-plugin"
