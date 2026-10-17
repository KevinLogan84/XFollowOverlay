#!/usr/bin/env bash
# Developer ID release for the Mac app.
# Archive → export → notarize → staple → re-zip.
# Does not publish unless you pass --publish.
set -euo pipefail

PUBLISH=0
# Public GitHub repo by default. Override to publish elsewhere:
#   PUBLISH_REPO=other/repo scripts/release-macos.sh --publish
PUBLISH_REPO="${PUBLISH_REPO:-KevinLogan84/XFollowOverlay}"
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    -h|--help)
      echo "Usage: scripts/release-macos.sh [--publish]"
      echo "  Builds a notarized X-Follow-Overlay-macOS.zip."
      echo "  --publish   also run gh release create (off by default)."
      echo "              Repo is \$PUBLISH_REPO (default KevinLogan84/XFollowOverlay)."
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
if [[ ! -d "$DEVELOPER_DIR" && -d /Applications/Xcode-beta.app/Contents/Developer ]]; then
  export DEVELOPER_DIR="/Applications/Xcode-beta.app/Contents/Developer"
fi

PROJ="$ROOT/Safari/X Follow Overlay/X Follow Overlay.xcodeproj"
SCHEME="X Follow Overlay (macOS)"
TEAM="KVVL57G45T"
IDENTITY="Developer ID Application: Kevin Logan (KVVL57G45T)"
VERSION="1.2.12"
BUILD="157"
DIST="$ROOT/dist"
ARCHIVE="$DIST/X Follow Overlay.xcarchive"
EXPORT_DIR="$DIST/export"
APP_NAME="X Follow Overlay.app"
NOTARY_ZIP="$DIST/X-Follow-Overlay-notarize.zip"
FINAL_ZIP="$DIST/X-Follow-Overlay-macOS.zip"
EXPORT_PLIST="$DIST/ExportOptions.plist"

echo "==> Syncing web extension resources..."
bash "$ROOT/scripts/sync-safari-resources.sh"

mkdir -p "$DIST"
rm -rf "$ARCHIVE" "$EXPORT_DIR" "$NOTARY_ZIP" "$FINAL_ZIP"

echo "==> Archiving ${SCHEME}..."
xcodebuild archive \
  -project "$PROJ" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  ENABLE_HARDENED_RUNTIME=YES \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD"

echo "==> Writing ExportOptions.plist..."
cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>developer-id</string>
  <key>teamID</key>
  <string>${TEAM}</string>
  <key>signingStyle</key>
  <string>automatic</string>
</dict>
</plist>
EOF

echo "==> Exporting Developer ID app..."
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -allowProvisioningUpdates

APP="$EXPORT_DIR/$APP_NAME"
if [[ ! -d "$APP" ]]; then
  echo "Export succeeded but ${APP_NAME} was not found in ${EXPORT_DIR}" >&2
  exit 1
fi

if find "$APP" \( -iname 'AGENTS.md' -o -iname 'reinstall-macos.mdc' -o -path '*/docs/private/*' \) | grep -q .; then
  echo "Private docs leaked into the app bundle." >&2
  exit 1
fi

echo "==> Zipping for notarization..."
ditto -c -k --keepParent "$APP" "$NOTARY_ZIP"

echo "==> Submitting to notarytool..."
xcrun notarytool submit "$NOTARY_ZIP" \
  --keychain-profile "${NOTARY_PROFILE:-notary}" \
  --wait

echo "==> Stapling and checking..."
xcrun stapler staple "$APP"
spctl -a -vv "$APP"

echo "==> Re-zipping the stapled app..."
ditto -c -k --keepParent "$APP" "$FINAL_ZIP"
rm -f "$NOTARY_ZIP"

# Archive, export, and DerivedData intermediates are real .app/.appex bundles.
# Launch Services and pluginkit keep them, so Safari lists a second extension
# next to the copy in /Applications. Unregister those built copies, delete
# them, then refresh the installed app if it is there.
echo "==> Unregistering built extension copies..."
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
DERIVED_DATA="${HOME}/Library/Developer/Xcode/DerivedData"

unregister_built() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  local appex bundle
  while IFS= read -r appex; do
    [[ -n "$appex" ]] || continue
    pluginkit -r "$appex" 2>/dev/null || true
  done < <(find "$root" -name '*.appex' -type d -print 2>/dev/null || true)
  while IFS= read -r bundle; do
    [[ -n "$bundle" ]] || continue
    "$LSREG" -u "$bundle" 2>/dev/null || true
  done < <(find "$root" \( -name '*.app' -o -name '*.appex' \) -type d -print 2>/dev/null || true)
}

unregister_built "$EXPORT_DIR"
unregister_built "$ARCHIVE"
if [[ -d "$DERIVED_DATA" ]]; then
  shopt -s nullglob
  for intermediates in "$DERIVED_DATA"/X_Follow_Overlay-*/Build/Intermediates.noindex/ArchiveIntermediates; do
    unregister_built "$intermediates"
  done
  shopt -u nullglob
fi

DSYM_ZIP="$DIST/X-Follow-Overlay-dSYMs.zip"
rm -f "$DSYM_ZIP"
if [[ -d "$ARCHIVE/dSYMs" ]] && ls "$ARCHIVE/dSYMs"/*.dSYM >/dev/null 2>&1; then
  echo "==> Keeping dSYMs (private, not uploaded): $DSYM_ZIP"
  ditto -c -k --keepParent "$ARCHIVE/dSYMs" "$DSYM_ZIP" || echo "Could not save dSYMs" >&2
fi

echo "==> Removing dist/export, dist/X Follow Overlay.xcarchive, and ArchiveIntermediates..."
rm -rf "$EXPORT_DIR" "$ARCHIVE"
if [[ -d "$DERIVED_DATA" ]]; then
  shopt -s nullglob
  for intermediates in "$DERIVED_DATA"/X_Follow_Overlay-*/Build/Intermediates.noindex/ArchiveIntermediates; do
    rm -rf "$intermediates"
  done
  shopt -u nullglob
fi

if [[ -d '/Applications/X Follow Overlay.app' ]]; then
  "$LSREG" -f '/Applications/X Follow Overlay.app' || true
fi

echo "Release zip: $FINAL_ZIP"

if [[ "$PUBLISH" == "1" ]]; then
  echo "==> Publishing GitHub release v${VERSION}..."
  gh release create "v${VERSION}" --repo "$PUBLISH_REPO" "$FINAL_ZIP" \
    --title "X Follow Overlay ${VERSION}" \
    --notes "Free Mac build. Sign in on x.com and sync. API keys are optional and stay on your Mac."
else
  echo "Skipping gh release create (pass --publish to upload)."
fi
