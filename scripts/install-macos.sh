#!/usr/bin/env bash
# Build X Follow Overlay and install to /Applications (Hot Spot Usage style).
# After this, enable once in Safari -> Settings -> Extensions.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode-beta.app/Contents/Developer}"
if [[ ! -d "$DEVELOPER_DIR" ]]; then
  export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
fi

PROJ="$ROOT/Safari/X Follow Overlay/X Follow Overlay.xcodeproj"
SCHEME="X Follow Overlay (macOS)"
DERIVED="/tmp/XFollowOverlayDerivedData"
APP_NAME="X Follow Overlay.app"
DEST="/Applications/X Follow Overlay.app"
TEAM="${DEVELOPMENT_TEAM:-KVVL57G45T}"

echo "==> Syncing web extension resources..."
bash "$ROOT/scripts/sync-safari-resources.sh"

echo "==> Building ${SCHEME}..."
xcodebuild \
  -project "$PROJ" \
  -scheme "$SCHEME" \
  -configuration Release \
  -derivedDataPath "$DERIVED" \
  -destination "platform=macOS" \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  MARKETING_VERSION=1.2.11 \
  CURRENT_PROJECT_VERSION=156 \
  build

BUILT="$DERIVED/Build/Products/Release/$APP_NAME"
if [[ ! -d "$BUILT" ]]; then
  BUILT="$DERIVED/Build/Products/Debug/$APP_NAME"
fi
if [[ ! -d "$BUILT" ]]; then
  echo "Build succeeded but app not found under $DERIVED/Build/Products" >&2
  ls -la "$DERIVED/Build/Products" 2>/dev/null || true
  exit 1
fi

echo "==> Installing to ${DEST}..."
osascript -e 'quit app "X Follow Overlay"' 2>/dev/null || true
sleep 0.5
rm -rf "$DEST"
cp -R "$BUILT" "$DEST"

# Avoid Safari listing both the temp build and /Applications copy
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$LSREG" -u "$BUILT" 2>/dev/null || true
"$LSREG" -u "$BUILT/Contents/PlugIns/X Follow Overlay Extension.appex" 2>/dev/null || true
"$LSREG" -f "$DEST"

echo "==> Unpinning leftover toolbar icon from the X web app..."
python3 - <<'PY' || true
import plistlib
import subprocess
from pathlib import Path

domain = "com.apple.Safari.WebApp"
export_path = Path("/tmp/safari-webapp-toolbar.plist")
try:
    subprocess.check_call(["defaults", "export", domain, str(export_path)])
except subprocess.CalledProcessError:
    raise SystemExit(0)

data = plistlib.loads(export_path.read_bytes())
remove = {
    "WebExtension-com.kevinlogan.xfollowoverlay.Extension (UNSIGNED)",
    "WebExtension-com.kevinlogan.xfollowoverlay.Extension (KVVL57G45T)",
}

def strip_ids(seq):
    return [x for x in (seq or []) if x not in remove]

tb_key = "NSToolbar Configuration WebAppToolbarIdentifier"
tb = data.get(tb_key)
if isinstance(tb, dict):
    tb["TB Item Identifiers"] = strip_ids(tb.get("TB Item Identifiers"))
    tb["TB Default Item Identifiers"] = strip_ids(tb.get("TB Default Item Identifiers"))
    data[tb_key] = tb

ext_key = "ExtensionsToolbarConfiguration WebAppToolbarIdentifier"
ext = data.get(ext_key) if isinstance(data.get(ext_key), dict) else {}
ext["OrderedToolbarItemIdentifiers"] = strip_ids(ext.get("OrderedToolbarItemIdentifiers"))
removed = list(ext.get("UserRemovedToolbarItemIdentifiers") or [])
for ident in remove:
    if ident not in removed:
        removed.append(ident)
ext["UserRemovedToolbarItemIdentifiers"] = removed
data[ext_key] = ext

export_path.write_bytes(plistlib.dumps(data, fmt=plistlib.FMT_BINARY))
subprocess.check_call(["defaults", "import", domain, str(export_path)])
print("Removed X Follow Overlay from the X web app toolbar")
PY

echo "==> Launching companion app..."
open "$DEST"

cat <<'EOF'

Installed: /Applications/X Follow Overlay.app

One-time Safari setup:
  1. Safari -> Settings -> Extensions
  2. Enable "X Follow Overlay"
  3. Allow x.com when asked
  4. Open x.com -> people icon under Post -> Sync free to refresh

After that you do not need Xcode. To update later:
  ./scripts/install-macos.sh

EOF
