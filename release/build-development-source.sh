#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DELIVERABLES="$APP_ROOT/dist"
# The Node exporter freezes the requested commit before reading any contents;
# ZIP, provenance manifest and checksums all go to DELIVERABLES without overwrite.
exec node "$SCRIPT_DIR/export-source.js" "${1:-HEAD}"
