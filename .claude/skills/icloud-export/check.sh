#!/usr/bin/env bash
# What this skill needs, and what is missing. Installs nothing.
set -uo pipefail
ok=0; missing=()

have() { command -v "$1" >/dev/null 2>&1; }
say() { printf '%-14s %s\n' "$1" "$2"; }

echo "Checking what is needed to export from Photos…"
echo

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This skill reads the macOS Photos library. It only works on a Mac."
  exit 1
fi

if have osxphotos; then say "osxphotos" "✓ $(osxphotos --version 2>/dev/null | head -1)"
else say "osxphotos" "✗ missing — reads the Photos library"; missing+=(osxphotos); ok=1; fi

if have node; then say "node" "✓ $(node --version)"
else say "node" "✗ missing — runs the review page in your browser"; missing+=(node); ok=1; fi

if have sips; then say "sips" "✓ built in"
else say "sips" "✗ missing — makes the small preview images"; ok=1; fi

if have exiftool; then say "exiftool" "✓ $(exiftool -ver)"
else say "exiftool" "✗ missing — without it the photos lose their GPS location"; missing+=(exiftool); ok=1; fi

if have ffmpeg; then say "ffmpeg" "✓ optional, for video"
else say "ffmpeg" "· optional, only needed for video clips"; fi

echo
if ((ok == 0)); then
  echo "Everything is here."
  exit 0
fi

echo "To install what is missing:"
for m in "${missing[@]}"; do
  case "$m" in
    osxphotos) echo "  brew install osxphotos      # or: uv tool install osxphotos" ;;
    exiftool)  echo "  brew install exiftool" ;;
    node)      echo "  brew install node" ;;
  esac
done
echo
echo "Photos will also ask for permission the first time, and the terminal needs"
echo "Full Disk Access (System Settings → Privacy & Security) to read the library."
exit 2
