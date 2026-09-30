#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DELIVERABLES="$APP_ROOT/dist"
VERSION="$(node -p "require('$APP_ROOT/package.json').version")"
RELEASE_DATE="${HRBOSS_RELEASE_DATE:-$(date +%Y%m%d)}"
if [[ ! "$RELEASE_DATE" =~ ^[0-9]{8}$ ]]; then
  printf 'HRBOSS_RELEASE_DATE must contain exactly 8 digits (YYYYMMDD).\n' >&2
  exit 1
fi
BASENAME="ZhaocaiGuan-source-${VERSION}-${RELEASE_DATE}"
ZIP_PATH="$DELIVERABLES/$BASENAME.zip"
HASH_PATH="$DELIVERABLES/$BASENAME-SHA256SUMS.txt"

for target in "$ZIP_PATH" "$HASH_PATH"; do
  if [[ -e "$target" ]]; then
    printf 'Refusing to overwrite existing source artifact: %s\n' "$target" >&2
    exit 1
  fi
done

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hrboss-source-release.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
BUNDLE="$TMP_DIR/$BASENAME"
mkdir -p "$BUNDLE/app"

rsync -a \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='frontend/node_modules/' \
  --exclude='frontend/dist/' \
  --exclude='electron-spike/node_modules/' \
  --exclude='out/' \
  --exclude='dist/' \
  --exclude='data/' \
  --exclude='tmp/' \
  --exclude='deliverables/' \
  --exclude='.dev-data/' \
  --exclude='.runtime/' \
  --exclude='.DS_Store' \
  --exclude='._*' \
  --exclude='__MACOSX/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='.npmrc' \
  --exclude='rating-config.json' \
  --exclude='windows-acceptance-evidence/' \
  --exclude='*.db' \
  --exclude='*.db-wal' \
  --exclude='*.db-shm' \
  --exclude='*.sqlite' \
  --exclude='*.sqlite-wal' \
  --exclude='*.sqlite-shm' \
  --exclude='*.sqlite3' \
  --exclude='*.sqlite3-wal' \
  --exclude='*.sqlite3-shm' \
  --exclude='*.log' \
  --exclude='*.pem' \
  --exclude='*.key' \
  --exclude='*.p12' \
  --exclude='*.pfx' \
  --exclude='*.crt' \
  --exclude='*.cer' \
  --exclude='*.mobileprovision' \
  "$APP_ROOT/" "$BUNDLE/app/"

ditto "$APP_ROOT/DEVELOPMENT.md" "$BUNDLE/DEVELOPMENT-README.md"

if find "$BUNDLE" -type f \( \
  -name '.env*' -o -name '.npmrc' -o -name 'rating-config.json' -o \
  -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' -o \
  -name '*.sqlite' -o -name '*.sqlite-wal' -o -name '*.sqlite-shm' -o \
  -name '*.sqlite3' -o -name '*.sqlite3-wal' -o -name '*.sqlite3-shm' -o -name '*.log' -o \
  -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o \
  -name '*.crt' -o -name '*.cer' -o -name '*.mobileprovision' \
\) -print -quit | grep -q .; then
  printf 'Sensitive or runtime file detected in source bundle.\n' >&2
  exit 1
fi

mkdir -p "$DELIVERABLES"
# Mark Chinese filenames as UTF-8 and omit host metadata in the portable source ZIP.
/usr/bin/tar --format zip --options zip:hdrcharset=UTF-8 \
  --no-xattrs --no-acls --no-mac-metadata --uid 0 --gid 0 \
  -cf "$ZIP_PATH" -C "$TMP_DIR" "$BASENAME"
(
  cd "$DELIVERABLES"
  shasum -a 256 "$(basename "$ZIP_PATH")" > "$(basename "$HASH_PATH")"
)

printf 'Created:\n%s\n%s\n' "$ZIP_PATH" "$HASH_PATH"
