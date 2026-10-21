#!/usr/bin/env bash
# Launches the built app against a scratch database, read-only.
#
# VSCode's integrated terminal exports ELECTRON_RUN_AS_NODE, which makes the Electron binary run as
# bare node and die on the ESM entry point. Clear it before doing anything else.
set -euo pipefail
unset ELECTRON_RUN_AS_NODE

cd "$(dirname "$0")/.."

: "${X_MUSIC_DB:=$HOME/.config/x-music/library.db}"
export X_MUSIC_DB
mkdir -p "$(dirname "$X_MUSIC_DB")"

# Pin read-only unless the caller has deliberately opted out.
if [[ "${X_MUSIC_ALLOW_WRITES:-}" != "1" ]]; then
  export X_MUSIC_FORCE_READ_ONLY=1
fi

# The app runs outside the dev shell, so point it at an mpv if one is not on PATH.
if [[ -z "${X_MUSIC_MPV:-}" ]]; then
  X_MUSIC_MPV=$(command -v mpv || ls -d /nix/store/*-mpv-0.*/bin/mpv 2>/dev/null | head -1 || true)
  export X_MUSIC_MPV
fi
[[ -n "${X_MUSIC_MPV:-}" ]] && echo "x-music: mpv $X_MUSIC_MPV"

ELECTRON="${ELECTRON_EXEC:-$(command -v electron || true)}"
if [[ -z "$ELECTRON" ]]; then
  ELECTRON=$(ls -d /nix/store/*-electron-43.*/bin/electron 2>/dev/null | head -1)
fi
[[ -n "$ELECTRON" ]] || { echo "no electron found; run inside 'nix develop'" >&2; exit 1; }

[[ -f out/main/index.js ]] || npx electron-vite build

echo "x-music: $ELECTRON"
echo "x-music: database $X_MUSIC_DB"
exec "$ELECTRON" . --no-sandbox "$@"
