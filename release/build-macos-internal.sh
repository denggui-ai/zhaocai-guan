#!/usr/bin/env bash
set -euo pipefail

MODE="${1:---candidate}"
case "$MODE" in
  --candidate|--publish|--official) ;;
  *)
    printf 'Usage: %s [--candidate|--publish|--official]\n' "$0" >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DELIVERABLES="$APP_ROOT/dist"
SOURCE_COMMIT="$(git -C "$APP_ROOT" rev-parse HEAD)"
SOURCE_TREE="$(git -C "$APP_ROOT" rev-parse "$SOURCE_COMMIT^{tree}")"
SOURCE_STATUS="$(git -C "$APP_ROOT" status --porcelain=v1 --untracked-files=all)"
SOURCE_STATE="dirty"
if [[ -z "$SOURCE_STATUS" ]]; then
  SOURCE_STATE="clean"
fi
if [[ "$SOURCE_STATE" != clean ]]; then
  printf 'Refusing to build or publish a Mac HR artifact from a dirty worktree. Freeze and commit the exact source first.\n' >&2
  exit 1
fi
VERSION="$(git -C "$APP_ROOT" show "$SOURCE_COMMIT:package.json" \
  | node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).version)')"
PRODUCT_NAME="$(git -C "$APP_ROOT" show "$SOURCE_COMMIT:package.json" \
  | node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).productName)')"
BUILD_NODE_VERSION="$(node -p 'process.version')"
BUILD_NPM_VERSION="$(npm --version)"
BUILD_ELECTRON_VERSION="$(git -C "$APP_ROOT" show "$SOURCE_COMMIT:package.json" \
  | node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).devDependencies.electron)')"
SOURCE_LOCK_SHA256="$(git -C "$APP_ROOT" show "$SOURCE_COMMIT:package-lock.json" | shasum -a 256 | awk '{print $1}')"
FRONTEND_LOCK_SHA256="$(git -C "$APP_ROOT" show "$SOURCE_COMMIT:frontend/package-lock.json" | shasum -a 256 | awk '{print $1}')"
RELEASE_DATE="${HRBOSS_RELEASE_DATE:-$(date +%Y%m%d)}"
if [[ ! "$RELEASE_DATE" =~ ^[0-9]{8}$ ]]; then
  printf 'HRBOSS_RELEASE_DATE must contain exactly 8 digits (YYYYMMDD).\n' >&2
  exit 2
fi
RELEASE_REVISION="${HRBOSS_RELEASE_REVISION:-}"
if [[ -n "$RELEASE_REVISION" && ! "$RELEASE_REVISION" =~ ^r[1-9][0-9]*$ ]]; then
  printf 'HRBOSS_RELEASE_REVISION must be empty or match r1, r2, ...\n' >&2
  exit 2
fi
REVISION_SEGMENT="${RELEASE_REVISION:+-${RELEASE_REVISION}}"
SIGNING_KIND="adhoc"
if [[ "$MODE" == --official ]]; then
  BASENAME="ZhaocaiGuan-macOS-arm64-${VERSION}-${RELEASE_DATE}${REVISION_SEGMENT}-official-notarized"
  SIGNING_KIND="developer-id"
else
  BASENAME="ZhaocaiGuan-macOS-arm64-${VERSION}-${RELEASE_DATE}${REVISION_SEGMENT}-internal"
fi

# The candidate owns one narrowly named /tmp tree. No build, signing, Forge
# output, or temporary artifact is allowed to use the working repository.
STAGING_ROOT="$(mktemp -d /tmp/hrboss-macos-candidate.XXXXXX)"
STAGING_ROOT="$(cd "$STAGING_ROOT" && pwd -P)"
SOURCE_STAGE="$STAGING_ROOT/source"
FROZEN_RELEASE_DIR="$SOURCE_STAGE/release"
CANDIDATE_DIR="$STAGING_ROOT/candidate"
CANDIDATE_APP="$CANDIDATE_DIR/$PRODUCT_NAME.app"
ARTIFACT_ROOT="$STAGING_ROOT/artifacts"
PACKAGE_STAGE="$ARTIFACT_ROOT/$BASENAME"
TMP_ZIP="$ARTIFACT_ROOT/$BASENAME.zip"
TMP_DMG="$ARTIFACT_ROOT/$BASENAME.dmg"
TMP_HASHES="$ARTIFACT_ROOT/$BASENAME-SHA256SUMS.txt"
NOTARY_SUBMISSION_ZIP="$ARTIFACT_ROOT/$BASENAME-notary-submission.zip"
SELF_TEST_EVIDENCE="$ARTIFACT_ROOT/MACOS-CANDIDATE-SELF-TEST"
SELF_TEST_HASHES="$ARTIFACT_ROOT/MACOS-CANDIDATE-SELF-TEST-SHA256SUMS.txt"

FINAL_STAGE="$DELIVERABLES/$BASENAME"
FINAL_ZIP="$DELIVERABLES/$BASENAME.zip"
FINAL_DMG="$DELIVERABLES/$BASENAME.dmg"
FINAL_HASHES="$DELIVERABLES/$BASENAME-SHA256SUMS.txt"

CREATED_FINAL_STAGE=0
CREATED_FINAL_ZIP=0
CREATED_FINAL_DMG=0
CREATED_FINAL_HASHES=0
PROMOTION_HIDDEN=""
DMG_MOUNTPOINT=""
DMG_ATTACHED=0

is_managed_staging_root() {
  case "$STAGING_ROOT" in
    /tmp/hrboss-macos-candidate.*|/private/tmp/hrboss-macos-candidate.*) return 0 ;;
    *) return 1 ;;
  esac
}

remove_managed_stage_path() {
  local target="$1"
  case "$target" in
    "$STAGING_ROOT"|"$STAGING_ROOT"/*) rm -rf -- "$target" ;;
    *)
      printf 'Refusing to remove path outside owned candidate staging: %s\n' "$target" >&2
      return 1
      ;;
  esac
}

assert_source_snapshot_unchanged() {
  local current_commit current_tree current_status
  current_commit="$(git -C "$APP_ROOT" rev-parse HEAD)"
  current_tree="$(git -C "$APP_ROOT" rev-parse "$current_commit^{tree}")"
  current_status="$(git -C "$APP_ROOT" status --porcelain=v1 --untracked-files=all)"
  if [[ "$current_commit" != "$SOURCE_COMMIT" \
      || "$current_tree" != "$SOURCE_TREE" \
      || -n "$current_status" ]]; then
    printf 'Source snapshot changed during the Mac release build; refusing to continue.\n' >&2
    return 1
  fi
}

cleanup() {
  local status=$?
  if [[ "$DMG_ATTACHED" == 1 && -n "$DMG_MOUNTPOINT" ]]; then
    hdiutil detach "$DMG_MOUNTPOINT" >/dev/null 2>&1 || true
    DMG_ATTACHED=0
  fi
  if [[ $status -ne 0 ]]; then
    if [[ -n "$PROMOTION_HIDDEN" && -e "$PROMOTION_HIDDEN" ]]; then
      case "$PROMOTION_HIDDEN" in
        "$DELIVERABLES"/."$BASENAME".promote.*) rm -rf -- "$PROMOTION_HIDDEN" ;;
      esac
    fi
    [[ "$CREATED_FINAL_HASHES" == 1 ]] && rm -f -- "$FINAL_HASHES"
    [[ "$CREATED_FINAL_DMG" == 1 ]] && rm -f -- "$FINAL_DMG"
    [[ "$CREATED_FINAL_ZIP" == 1 ]] && rm -f -- "$FINAL_ZIP"
    [[ "$CREATED_FINAL_STAGE" == 1 ]] && rm -rf -- "$FINAL_STAGE"
    if [[ "${HRBOSS_KEEP_FAILED_MAC_STAGE:-0}" != 1 ]]; then
      remove_managed_stage_path "$STAGING_ROOT"
    else
      printf 'Failed candidate staging retained at: %s\n' "$STAGING_ROOT" >&2
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if ! is_managed_staging_root; then
  printf 'Unsafe candidate staging root: %s\n' "$STAGING_ROOT" >&2
  exit 1
fi
chmod 700 "$STAGING_ROOT"

assert_publish_targets_absent() {
  local target
  for target in "$FINAL_STAGE" "$FINAL_ZIP" "$FINAL_DMG" "$FINAL_HASHES"; do
    if [[ -e "$target" ]]; then
      printf 'Refusing to overwrite existing release artifact: %s\n' "$target" >&2
      return 1
    fi
  done
}

validate_packaged_app() {
  local app_path="$1"
  local signing_kind="${2:-adhoc}"
  local main_binary="$app_path/Contents/MacOS/ZhaocaiGuan"
  local sqlite_binary="$app_path/Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  local resources_root="$app_path/Contents/Resources/app"
  local sqlite_module="$resources_root/node_modules/better-sqlite3"
  local link_path link_target resolved_link

  if [[ ! -f "$main_binary" || ! -f "$sqlite_binary" ]]; then
    printf 'Required packaged arm64 binary is missing in: %s\n' "$app_path" >&2
    return 1
  fi
  local required_runtime_file
  for required_runtime_file in \
    release-build.json \
    resume-structure.js \
    screenshot-ai-fill-approval.js \
    screenshot-ai-import-state.js \
    screenshot-ai-native-approval.js \
    screenshot-draft-preview.js \
    screenshot-import-task-public.js \
    action-server.js \
    candidate-main.js \
    preload.js \
    external-ai-user-approval.js \
    f009-interview-llm.js \
    screenshot-ai-reader.js \
    screenshot-ai-fill-runner.js \
    screenshot-field-ai.js \
    start-screenshot-import.js \
    local-vision-preflight.js \
    import-boss-screenshots.js \
    ingest-screenshot-drafts.js \
    resume-candidate-intake.js \
    manual-resume-import.js; do
    if [[ ! -f "$resources_root/$required_runtime_file" ]]; then
      printf 'Required current-release module is missing from packaged app: %s\n' "$required_runtime_file" >&2
      return 1
    fi
  done
  if ! node -e '
    const metadata = require(process.argv[1]);
    const [
      commit, tree, state, version, mode, releaseDate, revision,
      nodeVersion, npmVersion, electronVersion, sourceLock, frontendLock,
    ] = process.argv.slice(2);
    if (metadata.schema_version !== "hrboss_release_build_v1"
      || metadata.source_commit !== commit
      || metadata.source_tree !== tree
      || metadata.source_worktree_state !== state
      || metadata.application_version !== version
      || metadata.release_mode !== mode.replace(/^--/, "")
      || metadata.release_date !== releaseDate
      || metadata.release_revision !== (revision || null)
      || metadata.build_toolchain?.node !== nodeVersion
      || metadata.build_toolchain?.npm !== npmVersion
      || metadata.build_toolchain?.electron !== electronVersion
      || metadata.lockfiles?.root_package_lock_sha256 !== sourceLock
      || metadata.lockfiles?.frontend_package_lock_sha256 !== frontendLock
      || metadata.target !== "darwin-arm64") process.exit(1);
  ' "$resources_root/release-build.json" "$SOURCE_COMMIT" "$SOURCE_TREE" "$SOURCE_STATE" \
    "$VERSION" "$MODE" "$RELEASE_DATE" "$RELEASE_REVISION" \
    "$BUILD_NODE_VERSION" "$BUILD_NPM_VERSION" "$BUILD_ELECTRON_VERSION" \
    "$SOURCE_LOCK_SHA256" "$FRONTEND_LOCK_SHA256"; then
    printf 'Packaged release-build.json is missing or invalid.\n' >&2
    return 1
  fi
  if ! grep -q 'resume_structure_v1' "$resources_root/resume-structure.js" \
    || ! grep -q 'screenshot_ai_import_state_v1' "$resources_root/screenshot-ai-import-state.js" \
    || ! grep -q 'SCREENSHOT_EXTERNAL_AI_APPROVAL_REQUIRED' "$resources_root/action-server.js" \
    || ! grep -q 'screenshot-import:approve-retry' "$resources_root/candidate-main.js" \
    || ! grep -q 'name_verified_by_hr' "$resources_root/action-server.js"; then
    printf 'Packaged backend does not contain the current screenshot/resume contracts.\n' >&2
    return 1
  fi
  if ! grep -R -q '截图导入任务中心' "$resources_root/frontend/dist/assets" \
    || ! grep -R -q '我已对照原图确认姓名' "$resources_root/frontend/dist/assets" \
    || ! grep -R -q 'screenshot-import-task-panel' "$resources_root/frontend/dist/assets"; then
    printf 'Packaged frontend does not contain the current task-center/name-review UI.\n' >&2
    return 1
  fi
  if [[ "$(lipo -archs "$main_binary")" != arm64 ]]; then
    printf 'Packaged main executable is not exactly arm64: %s\n' "$main_binary" >&2
    return 1
  fi
  if [[ "$(lipo -archs "$sqlite_binary")" != arm64 ]]; then
    printf 'Packaged better_sqlite3.node is not exactly arm64: %s\n' "$sqlite_binary" >&2
    return 1
  fi

  for excluded in \
    "$resources_root/data" \
    "$resources_root/tmp" \
    "$resources_root/out" \
    "$resources_root/dist" \
    "$resources_root/.runtime" \
    "$resources_root/deliverables" \
    "$resources_root/.github" \
    "$resources_root/.impeccable" \
    "$resources_root/.gitattributes" \
    "$resources_root/forge.config.js" \
    "$resources_root/release" \
    "$resources_root/handoff" \
    "$resources_root/checks" \
    "$resources_root/create-ui-fixture-db.js"; do
    if [[ -e "$excluded" ]]; then
      printf 'Packaged application contains forbidden development/runtime material: %s\n' "$excluded" >&2
      return 1
    fi
  done

  if find "$resources_root" -maxdepth 1 -type f -name 'check-*.js' -print -quit | grep -q .; then
    printf 'Packaged application contains root check scripts.\n' >&2
    return 1
  fi
  if [[ -d "$resources_root/frontend" ]] && find "$resources_root/frontend" -mindepth 1 -maxdepth 1 ! -name dist -print -quit | grep -q .; then
    printf 'Packaged frontend contains development files outside frontend/dist.\n' >&2
    return 1
  fi
  if find "$resources_root" -type f \( \
    -name '.env' -o -name '.env.*' -o -name '.npmrc' -o \
    -name 'rating-config.json' -o \
    -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' -o \
    -name '*.sqlite' -o -name '*.sqlite-wal' -o -name '*.sqlite-shm' -o \
    -name '*.sqlite3' -o -name '*.sqlite3-wal' -o -name '*.sqlite3-shm' -o \
    -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o \
    -name '*.crt' -o -name '*.cer' -o -name '*.mobileprovision' \
    \) -print -quit | grep -q .; then
    printf 'Packaged application contains forbidden data, config, or credential-like files.\n' >&2
    return 1
  fi

  while IFS= read -r -d '' link_path; do
    link_target="$(readlink "$link_path")"
    case "$link_target" in
      /*)
        printf 'Packaged application contains an absolute symlink: %s\n' "$link_path" >&2
        return 1
        ;;
    esac
    if ! resolved_link="$(realpath "$link_path" 2>/dev/null)"; then
      printf 'Packaged application contains a broken symlink: %s\n' "$link_path" >&2
      return 1
    fi
    case "$resolved_link" in
      "$resources_root"|"$resources_root"/*) ;;
      *)
        printf 'Packaged application symlink escapes Resources/app: %s\n' "$link_path" >&2
        return 1
        ;;
    esac
  done < <(find "$resources_root" -type l -print0)

  if [[ "$signing_kind" == developer-id ]]; then
    node "$FROZEN_RELEASE_DIR/macos-official-gate.js" verify-app "$app_path"
  elif [[ "$signing_kind" == developer-id-notarized ]]; then
    node "$FROZEN_RELEASE_DIR/macos-official-gate.js" verify-notarized-app "$app_path"
  else
    codesign --verify --deep --strict --verbose=2 "$app_path"
  fi
  HRBOSS_PACKAGED_SQLITE_MODULE="$sqlite_module" ELECTRON_RUN_AS_NODE=1 "$main_binary" -e \
    "const Database=require(process.env.HRBOSS_PACKAGED_SQLITE_MODULE); const db=new Database(':memory:'); db.prepare('SELECT 1').get(); db.close();"
}

if [[ "$MODE" == --publish || "$MODE" == --official ]]; then
  assert_publish_targets_absent
fi

mkdir -p "$SOURCE_STAGE"

# Build only from the immutable committed tree. No untracked file, local
# node_modules tree, ignored frontend build, or concurrent worktree edit can
# enter the release source snapshot.
assert_source_snapshot_unchanged
git -C "$APP_ROOT" archive --format=tar "$SOURCE_COMMIT" \
  | /usr/bin/tar -xf - -C "$SOURCE_STAGE"
assert_source_snapshot_unchanged

for forbidden in data tmp out dist .runtime deliverables frontend/dist node_modules; do
  if [[ -e "$SOURCE_STAGE/$forbidden" ]]; then
    printf 'Forbidden repository material entered committed candidate source: %s\n' "$forbidden" >&2
    exit 1
  fi
done
if find "$SOURCE_STAGE" -type f \( \
  -name '.env' -o -name '.env.*' -o -name '.npmrc' -o \
  -name 'rating-config.json' -o \
  -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' -o \
  -name '*.sqlite' -o -name '*.sqlite-wal' -o -name '*.sqlite-shm' -o \
  -name '*.sqlite3' -o -name '*.sqlite3-wal' -o -name '*.sqlite3-shm' -o \
  -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o \
  -name '*.crt' -o -name '*.cer' -o -name '*.mobileprovision' \
  \) -print -quit | grep -q .; then
  printf 'Committed candidate source contains forbidden data, config, or credential-like files.\n' >&2
  exit 1
fi

node -e '
  const fs = require("fs");
  const [
    output, commit, tree, state, version, mode, releaseDate, revision,
    nodeVersion, npmVersion, electronVersion, sourceLock, frontendLock,
  ] = process.argv.slice(1);
  const metadata = {
    schema_version: "hrboss_release_build_v1",
    source_commit: commit,
    source_tree: tree,
    source_worktree_state: state,
    application_version: version,
    release_mode: mode.replace(/^--/, ""),
    release_date: releaseDate,
    release_revision: revision || null,
    build_toolchain: {
      node: nodeVersion,
      npm: npmVersion,
      electron: electronVersion,
    },
    lockfiles: {
      root_package_lock_sha256: sourceLock,
      frontend_package_lock_sha256: frontendLock,
    },
    target: "darwin-arm64",
  };
  fs.writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
' "$SOURCE_STAGE/release-build.json" "$SOURCE_COMMIT" "$SOURCE_TREE" "$SOURCE_STATE" \
  "$VERSION" "$MODE" "$RELEASE_DATE" "$RELEASE_REVISION" \
  "$BUILD_NODE_VERSION" "$BUILD_NPM_VERSION" "$BUILD_ELECTRON_VERSION" \
  "$SOURCE_LOCK_SHA256" "$FRONTEND_LOCK_SHA256"

(
  cd "$SOURCE_STAGE"
  npm ci --no-audit --no-fund
  ./node_modules/.bin/electron-rebuild -f -w better-sqlite3
  if [[ "$MODE" == --official ]]; then
    # The official gate and its signer dependency both come from the frozen,
    # lockfile-rebuilt source stage. No active-worktree module participates.
    node "$FROZEN_RELEASE_DIR/macos-official-gate.js" preflight
  fi
  npm run verify
  ./node_modules/.bin/electron-forge package --platform=darwin --arch=arm64
)

PACKAGED_APP="$SOURCE_STAGE/dist/$PRODUCT_NAME-darwin-arm64/$PRODUCT_NAME.app"
if [[ "$MODE" == --official ]]; then
  node "$FROZEN_RELEASE_DIR/macos-official-gate.js" sign-app "$PACKAGED_APP"
else
  codesign --force --deep --sign - "$PACKAGED_APP"
fi
validate_packaged_app "$PACKAGED_APP" "$SIGNING_KIND"
assert_source_snapshot_unchanged

mkdir -p "$CANDIDATE_DIR"
mv "$PACKAGED_APP" "$CANDIDATE_APP"

MAIN_BINARY="$CANDIDATE_APP/Contents/MacOS/ZhaocaiGuan"
SQLITE_BINARY="$CANDIDATE_APP/Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
(
  cd "$CANDIDATE_DIR"
  shasum -a 256 \
    "$PRODUCT_NAME.app/Contents/MacOS/ZhaocaiGuan" \
    "$PRODUCT_NAME.app/Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
    "$PRODUCT_NAME.app/Contents/Resources/app/release-build.json" \
    "$PRODUCT_NAME.app/Contents/Resources/app/resume-structure.js" \
    "$PRODUCT_NAME.app/Contents/Resources/app/screenshot-ai-import-state.js" \
    "$PRODUCT_NAME.app/Contents/Resources/app/screenshot-import-task-public.js" \
    "$PRODUCT_NAME.app/Contents/Resources/app/frontend/dist/index.html" \
    > SHA256SUMS.txt
  shasum -a 256 -c SHA256SUMS.txt
)

run_candidate_self_test() {
  mkdir -p "$ARTIFACT_ROOT"
  node "$FROZEN_RELEASE_DIR/macos-candidate-self-test.js" \
    --app "$CANDIDATE_APP" --evidence-root "$SELF_TEST_EVIDENCE"
  (
    cd "$ARTIFACT_ROOT"
    shasum -a 256 \
      MACOS-CANDIDATE-SELF-TEST/summary.json \
      MACOS-CANDIDATE-SELF-TEST/summary.md \
      > "$(basename "$SELF_TEST_HASHES")"
    shasum -a 256 -c "$(basename "$SELF_TEST_HASHES")"
  )
  assert_source_snapshot_unchanged
}

if [[ "$MODE" != --official ]]; then
  run_candidate_self_test
fi

if [[ "$MODE" == --candidate ]]; then
  remove_managed_stage_path "$SOURCE_STAGE"
  printf 'Mac arm64 candidate PASS (no deliverables written):\n%s\nSelf-test evidence: %s\n' \
    "$CANDIDATE_APP" "$SELF_TEST_EVIDENCE"
  exit 0
fi

# --official selects the later Developer ID/notarized channel. Its notarization
# must report Accepted and tickets must be stapled/validated before assembly.
# --publish creates local ad-hoc archives eligible for the planned unnotarized
# first release after human acceptance and an explicit owner's release decision.
# Neither mode uploads artifacts or grants permission to publish them.
if [[ "$MODE" == --official ]]; then
  mkdir -p "$ARTIFACT_ROOT"
  node "$FROZEN_RELEASE_DIR/macos-official-gate.js" notarize-app "$CANDIDATE_APP" "$NOTARY_SUBMISSION_ZIP"
  SIGNING_KIND="developer-id-notarized"
  validate_packaged_app "$CANDIDATE_APP" "$SIGNING_KIND"
  run_candidate_self_test
fi

# All distribution artifacts are first created and validated inside the owned
# /tmp tree, then promoted without overwriting any existing delivery path.
mkdir -p "$PACKAGE_STAGE" "$ARTIFACT_ROOT"
GENERATED_README="$ARTIFACT_ROOT/MACOS-README.md"
README_TEMPLATE="$FROZEN_RELEASE_DIR/MACOS-README.md"
UAT_CHECKLIST="$FROZEN_RELEASE_DIR/MACOS-HR-UAT-CHECKLIST.md"
if [[ "$MODE" == --official ]]; then
  README_TEMPLATE="$FROZEN_RELEASE_DIR/MACOS-OFFICIAL-README.md"
fi
sed "s/__HRBOSS_SHA256SUMS_FILENAME__/${BASENAME}-SHA256SUMS.txt/g" \
  "$README_TEMPLATE" > "$GENERATED_README"
if grep -q '__HRBOSS_SHA256SUMS_FILENAME__' "$GENERATED_README"; then
  printf 'Generated Mac README still contains an unresolved checksum placeholder.\n' >&2
  exit 1
fi
ditto "$CANDIDATE_APP" "$PACKAGE_STAGE/$PRODUCT_NAME.app"
ditto "$GENERATED_README" "$PACKAGE_STAGE/MACOS-README.md"
ditto "$SELF_TEST_EVIDENCE" "$PACKAGE_STAGE/MACOS-CANDIDATE-SELF-TEST"
ditto "$SELF_TEST_HASHES" "$PACKAGE_STAGE/MACOS-CANDIDATE-SELF-TEST-SHA256SUMS.txt"
if [[ "$MODE" != --official ]]; then
  ditto "$UAT_CHECKLIST" "$PACKAGE_STAGE/MACOS-HR-UAT-CHECKLIST.md"
fi
ditto "$CANDIDATE_DIR/SHA256SUMS.txt" "$PACKAGE_STAGE/SHA256SUMS.txt"

TMP_DMG_SOURCE="$STAGING_ROOT/dmg-source/$BASENAME"
mkdir -p "$TMP_DMG_SOURCE"
ditto "$CANDIDATE_APP" "$TMP_DMG_SOURCE/$PRODUCT_NAME.app"
ditto "$GENERATED_README" "$TMP_DMG_SOURCE/MACOS-README.md"
ditto "$SELF_TEST_EVIDENCE" "$TMP_DMG_SOURCE/MACOS-CANDIDATE-SELF-TEST"
ditto "$SELF_TEST_HASHES" "$TMP_DMG_SOURCE/MACOS-CANDIDATE-SELF-TEST-SHA256SUMS.txt"
if [[ "$MODE" != --official ]]; then
  ditto "$UAT_CHECKLIST" "$TMP_DMG_SOURCE/MACOS-HR-UAT-CHECKLIST.md"
fi
ln -s /Applications "$TMP_DMG_SOURCE/Applications"

# Preserve app symlinks and modes while marking its Chinese path as UTF-8.
/usr/bin/tar --format zip --options zip:hdrcharset=UTF-8 \
  --no-xattrs --no-acls --no-mac-metadata --uid 0 --gid 0 \
  -cf "$TMP_ZIP" -C "$ARTIFACT_ROOT" "$BASENAME"
hdiutil create -volname "$PRODUCT_NAME $VERSION" -srcfolder "$TMP_DMG_SOURCE" -format UDZO "$TMP_DMG"
if [[ "$MODE" == --official ]]; then
  # The distributed disk image is a separately signed/notarized artifact. Its
  # Accepted result and stapled ticket must precede checksums and promotion.
  node "$FROZEN_RELEASE_DIR/macos-official-gate.js" notarize-dmg "$TMP_DMG"
fi
(
  cd "$ARTIFACT_ROOT"
  shasum -a 256 "$(basename "$TMP_DMG")" "$(basename "$TMP_ZIP")" > "$(basename "$TMP_HASHES")"
  shasum -a 256 -c "$(basename "$TMP_HASHES")"
)
hdiutil verify "$TMP_DMG"
unzip -tq "$TMP_ZIP"

ZIP_CHECK_ROOT="$STAGING_ROOT/zip-check"
mkdir -p "$ZIP_CHECK_ROOT"
ditto -x -k "$TMP_ZIP" "$ZIP_CHECK_ROOT"
validate_packaged_app "$ZIP_CHECK_ROOT/$BASENAME/$PRODUCT_NAME.app" "$SIGNING_KIND"

DMG_MOUNTPOINT="$STAGING_ROOT/dmg-mount"
mkdir -p "$DMG_MOUNTPOINT"
hdiutil attach -nobrowse -readonly -mountpoint "$DMG_MOUNTPOINT" "$TMP_DMG" >/dev/null
DMG_ATTACHED=1
validate_packaged_app "$DMG_MOUNTPOINT/$PRODUCT_NAME.app" "$SIGNING_KIND"
# The validation above just walked the whole volume, and macOS starts indexing a
# freshly attached one, so the first detach often loses to a reader that is on
# its way out. Retry before forcing, and only force after validation has already
# passed against this mount.
detach_validated_dmg() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if hdiutil detach "$DMG_MOUNTPOINT" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  printf 'DMG mountpoint stayed busy; forcing detach: %s\n' "$DMG_MOUNTPOINT" >&2
  hdiutil detach -force "$DMG_MOUNTPOINT" >/dev/null
}
detach_validated_dmg
DMG_ATTACHED=0

assert_source_snapshot_unchanged
assert_publish_targets_absent
mkdir -p "$DELIVERABLES"

promote_without_overwrite() {
  local source="$1"
  local destination="$2"
  local marker="$3"
  PROMOTION_HIDDEN="$DELIVERABLES/.${BASENAME}.promote.${marker}.$$"
  if [[ -e "$PROMOTION_HIDDEN" || -e "$destination" ]]; then
    printf 'Refusing release promotion because target already exists: %s\n' "$destination" >&2
    return 1
  fi
  ditto "$source" "$PROMOTION_HIDDEN"
  mv -n "$PROMOTION_HIDDEN" "$destination"
  if [[ -e "$PROMOTION_HIDDEN" || ! -e "$destination" ]]; then
    printf 'Release promotion could not claim target without overwrite: %s\n' "$destination" >&2
    return 1
  fi
  PROMOTION_HIDDEN=""
}

promote_without_overwrite "$PACKAGE_STAGE" "$FINAL_STAGE" stage
CREATED_FINAL_STAGE=1
promote_without_overwrite "$TMP_DMG" "$FINAL_DMG" dmg
CREATED_FINAL_DMG=1
promote_without_overwrite "$TMP_ZIP" "$FINAL_ZIP" zip
CREATED_FINAL_ZIP=1
promote_without_overwrite "$TMP_HASHES" "$FINAL_HASHES" hashes
CREATED_FINAL_HASHES=1

assert_source_snapshot_unchanged
remove_managed_stage_path "$SOURCE_STAGE"

if [[ "$MODE" == --official ]]; then
  printf 'Created local verified, notarized Mac artifacts (not uploaded; owner release decision required):\n%s\n%s\n%s\n%s\nCandidate evidence: %s\n' \
    "$FINAL_STAGE" "$FINAL_DMG" "$FINAL_ZIP" "$FINAL_HASHES" "$STAGING_ROOT"
  exit 0
fi

printf 'Created local verified, unnotarized Mac ad-hoc artifacts (not uploaded; human acceptance and owner release decision required):\n%s\n%s\n%s\n%s\nCandidate evidence: %s\n' \
  "$FINAL_STAGE" "$FINAL_DMG" "$FINAL_ZIP" "$FINAL_HASHES" "$STAGING_ROOT"
