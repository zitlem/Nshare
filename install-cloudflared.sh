#!/usr/bin/env bash
#
# install-cloudflared.sh — cross-platform cloudflared installer (Linux + macOS)
#
# Usage:   ./install-cloudflared.sh
# Detects OS + CPU architecture and installs the cloudflared binary so the
# NShare public-link (Cloudflare tunnel) feature works.
#
set -euo pipefail

REPO="https://github.com/cloudflare/cloudflared/releases/latest/download"

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
err()  { printf '\033[31mError:\033[0m %s\n' "$*" >&2; }

# Run a command with sudo when we are not already root.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    err "Not running as root and 'sudo' is not available. Re-run as root."
    exit 1
  fi
fi

# Pick a downloader.
download() { # download <url> <output>
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$2" "$1"
  else
    err "Neither curl nor wget is installed. Install one and re-run."
    exit 1
  fi
}

if command -v cloudflared >/dev/null 2>&1; then
  say "cloudflared already installed: $(command -v cloudflared) ($(cloudflared --version 2>/dev/null | head -1))"
  exit 0
fi

OS="$(uname -s)"
RAW_ARCH="$(uname -m)"

# Normalise architecture to cloudflared's naming.
case "$RAW_ARCH" in
  x86_64|amd64)          ARCH="amd64" ;;
  aarch64|arm64)         ARCH="arm64" ;;
  armv7l|armv6l|arm)     ARCH="arm"   ;;
  i386|i686)             ARCH="386"   ;;
  *) err "Unsupported architecture: $RAW_ARCH"; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$OS" in
  Linux)
    if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
      say "Debian/Ubuntu detected — installing via .deb ($ARCH)"
      download "$REPO/cloudflared-linux-$ARCH.deb" "$TMP/cloudflared.deb"
      $SUDO dpkg -i "$TMP/cloudflared.deb" || $SUDO apt-get -f install -y
    elif command -v rpm >/dev/null 2>&1; then
      say "RPM-based distro detected — installing via .rpm ($ARCH)"
      # cloudflared publishes x86_64/aarch64 rpm naming
      case "$ARCH" in amd64) RARCH="x86_64" ;; arm64) RARCH="aarch64" ;; *) RARCH="$ARCH" ;; esac
      download "$REPO/cloudflared-linux-$RARCH.rpm" "$TMP/cloudflared.rpm"
      $SUDO rpm -i "$TMP/cloudflared.rpm"
    else
      say "Generic Linux — installing raw binary to /usr/local/bin ($ARCH)"
      download "$REPO/cloudflared-linux-$ARCH" "$TMP/cloudflared"
      chmod +x "$TMP/cloudflared"
      $SUDO mv "$TMP/cloudflared" /usr/local/bin/cloudflared
    fi
    ;;
  Darwin)
    if command -v brew >/dev/null 2>&1; then
      say "macOS + Homebrew detected — installing via brew"
      brew install cloudflared
    else
      say "macOS — installing raw binary to /usr/local/bin ($ARCH)"
      download "$REPO/cloudflared-darwin-$ARCH.tgz" "$TMP/cloudflared.tgz"
      tar -xzf "$TMP/cloudflared.tgz" -C "$TMP"
      chmod +x "$TMP/cloudflared"
      $SUDO mv "$TMP/cloudflared" /usr/local/bin/cloudflared
    fi
    ;;
  *)
    err "Unsupported OS: $OS (this script handles Linux and macOS; use install-cloudflared.ps1 on Windows)"
    exit 1
    ;;
esac

if command -v cloudflared >/dev/null 2>&1; then
  say "Done: $(command -v cloudflared) ($(cloudflared --version 2>/dev/null | head -1))"
  echo
  echo "Next: restart the NShare server so it picks up the new PATH, then use the QR button."
else
  err "Install finished but 'cloudflared' is not on PATH. Set \"cloudflared_path\" in config.json to its full path."
  exit 1
fi
