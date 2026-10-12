#!/usr/bin/env bash
# Sync root web-extension files into the Safari Xcode Resources folder.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/Safari/X Follow Overlay/Shared (Extension)/Resources"

if [[ ! -d "$DEST" ]]; then
  echo "Safari Resources folder missing: $DEST" >&2
  exit 1
fi

sync_dir() {
  local src="$1"
  local dst="$2"
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude '.DS_Store' "$src/" "$dst/"
  else
    find "$dst" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -a "$src"/. "$dst/"
  fi
}

sync_dir "$ROOT/background" "$DEST/background"
sync_dir "$ROOT/content" "$DEST/content"
sync_dir "$ROOT/icons" "$DEST/icons"
sync_dir "$ROOT/popup" "$DEST/popup"
sync_dir "$ROOT/shared" "$DEST/shared"
cp "$ROOT/manifest.json" "$DEST/manifest.json"

echo "Synced web extension → Safari Resources"
