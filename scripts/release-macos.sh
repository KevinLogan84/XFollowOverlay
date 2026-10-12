#!/usr/bin/env bash
# Developer ID release for the Mac app.
# Archive → export → notarize → staple → re-zip.
# Does not publish unless you pass --publish.
set -euo pipefail

PUBLISH=0
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    -h|--help)
      echo "Usage: scripts/release-macos.sh [--publish]"
      echo "  Builds a notarized X-Follow-Overlay-macOS.zip."
      echo "  --publish   also run gh release create (off by default)."
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
VERSION="1.2.1"
BUILD="143"
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

echo "Release zip: $FINAL_ZIP"

if [[ "$PUBLISH" == "1" ]]; then
  echo "==> Publishing GitHub release v${VERSION}..."
  gh release create "v${VERSION}" --repo KevinLogan84/XFollowOverlay "$FINAL_ZIP" \
    --title "X Follow Overlay ${VERSION}" \
    --notes "Free Mac build. Sign in on x.com and sync. API keys are optional and stay on your Mac."
else
  echo "Skipping gh release create (pass --publish to upload)."
fi
