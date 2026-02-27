#!/usr/bin/env bash
set -euo pipefail

BINARIES_DIR="src-tauri/binaries"
mkdir -p "$BINARIES_DIR"

detect_target() {
  local os arch target
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)
      case "$arch" in
        x86_64) target="x86_64-unknown-linux-gnu" ;;
        aarch64) target="aarch64-unknown-linux-gnu" ;;
        *) echo "Unsupported arch: $arch"; exit 1 ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        x86_64) target="x86_64-apple-darwin" ;;
        arm64)  target="aarch64-apple-darwin" ;;
        *) echo "Unsupported arch: $arch"; exit 1 ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*)
      target="x86_64-pc-windows-msvc"
      ;;
    *)
      echo "Unsupported OS: $os"
      exit 1
      ;;
  esac
  echo "$target"
}

TARGET=$(detect_target)
echo "Detected target: $TARGET"

case "$(uname -s)" in
  Linux)
    echo "Downloading ffmpeg for Linux..."
    curl -L -o /tmp/ffmpeg.tar.xz \
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-lgpl.tar.xz"
    tar xf /tmp/ffmpeg.tar.xz -C /tmp
    FFMPEG_DIR=$(find /tmp -maxdepth 1 -type d -name "ffmpeg-*" | head -1)
    cp "${FFMPEG_DIR}/bin/ffmpeg"  "${BINARIES_DIR}/ffmpeg-${TARGET}"
    cp "${FFMPEG_DIR}/bin/ffprobe" "${BINARIES_DIR}/ffprobe-${TARGET}"
    chmod +x "${BINARIES_DIR}/ff"*
    rm -rf /tmp/ffmpeg.tar.xz "${FFMPEG_DIR}"
    ;;
  Darwin)
    echo "Installing ffmpeg via Homebrew..."
    brew install ffmpeg 2>/dev/null || brew upgrade ffmpeg 2>/dev/null || true
    cp "$(which ffmpeg)"  "${BINARIES_DIR}/ffmpeg-${TARGET}"
    cp "$(which ffprobe)" "${BINARIES_DIR}/ffprobe-${TARGET}"
    chmod +x "${BINARIES_DIR}/ff"*
    ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "Downloading ffmpeg for Windows..."
    curl -L -o /tmp/ffmpeg.zip \
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip"
    unzip -o /tmp/ffmpeg.zip -d /tmp/ffmpeg-extracted
    FFMPEG_DIR=$(find /tmp/ffmpeg-extracted -maxdepth 1 -type d -name "ffmpeg-*" | head -1)
    cp "${FFMPEG_DIR}/bin/ffmpeg.exe"  "${BINARIES_DIR}/ffmpeg-${TARGET}.exe"
    cp "${FFMPEG_DIR}/bin/ffprobe.exe" "${BINARIES_DIR}/ffprobe-${TARGET}.exe"
    rm -rf /tmp/ffmpeg.zip /tmp/ffmpeg-extracted
    ;;
esac

echo ""
echo "Sidecar binaries installed:"
ls -lh "${BINARIES_DIR}/"
echo ""
echo "Ready to run: bun tauri dev"
