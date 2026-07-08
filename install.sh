#!/bin/sh
# Copyright 2026 Stefan Prodan.
# SPDX-License-Identifier: Apache-2.0
#
# Install (or update) the latest cctop release binary for this OS/arch.
#
#   curl -fsSL https://raw.githubusercontent.com/stefanprodan/cctop/main/install.sh | sh
#
# The build is a self-contained binary — it needs no Bun runtime. Re-run this
# same command to update, or use the built-in updater: `cctop upgrade`.
#
# Environment:
#   PREFIX         install prefix (default: $HOME/.local; binary -> $PREFIX/bin)
#   CCTOP_VERSION  install a specific tag, e.g. v0.5.0 (default: latest)
#   CCTOP_REPO     source repository (default: stefanprodan/cctop)
set -eu

REPO="${CCTOP_REPO:-stefanprodan/cctop}"
PREFIX="${PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"

info() { printf '%s\n' "$*"; }
err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || err "curl is required"
command -v tar >/dev/null 2>&1 || err "tar is required"

os="$(uname -s)"
case "$os" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) err "unsupported OS: $os (cctop ships Linux and macOS binaries)" ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch="amd64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *) err "unsupported architecture: $arch" ;;
esac

# Asset and checksums names must match .github/workflows/release.yml (and the
# in-binary updater, src/upgrade.ts). Rename them there and here together.
asset="cctop_${os}_${arch}.tar.gz"

if [ "${CCTOP_VERSION:-}" = "" ]; then
  base="https://github.com/$REPO/releases/latest/download"
  label="latest"
else
  tag="$CCTOP_VERSION"
  case "$tag" in v*) ;; *) tag="v$tag" ;; esac
  base="https://github.com/$REPO/releases/download/$tag"
  label="$tag"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

info "Downloading cctop ($label) for $os/$arch ..."
curl -fSL --progress-bar --proto '=https' --tlsv1.2 "$base/$asset" -o "$tmp/$asset" ||
  err "download failed: $base/$asset"

# Verify the SHA-256 against the checksums the release publishes alongside the
# archives, and abort on a mismatch. Fail closed: if the checksums file can't be
# fetched we refuse to install rather than silently installing unverified code.
curl -fsSL "$base/cctop_checksums.txt" -o "$tmp/checksums.txt" ||
  err "could not download checksums for $label; refusing to install unverified"

if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  got="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
elif [ "${CCTOP_INSECURE_SKIP_VERIFY:-}" = "1" ]; then
  got=""
  info "warning: no sha256 tool found; skipping verification (CCTOP_INSECURE_SKIP_VERIFY=1)"
else
  err "no sha256 tool (sha256sum/shasum) found; cannot verify the download — install one, or set CCTOP_INSECURE_SKIP_VERIFY=1 to bypass"
fi

if [ -n "$got" ]; then
  want="$(awk -v f="$asset" '$2 == f {print $1}' "$tmp/checksums.txt")"
  [ -n "$want" ] || err "no checksum published for $asset"
  [ "$want" = "$got" ] || err "checksum mismatch for $asset (refusing to install)"
fi

tar -xzf "$tmp/$asset" -C "$tmp" cctop || err "failed to extract cctop"
mkdir -p "$BIN_DIR"
# Install atomically: stage a sibling in $BIN_DIR (same filesystem), then mv it
# over the target. Overwriting a running binary in place fails with ETXTBSY;
# rename() only repoints the directory entry, leaving the busy inode intact, so
# re-running to update works even while cctop is running elsewhere.
staged="$BIN_DIR/.cctop.new.$$"
install -m 0755 "$tmp/cctop" "$staged" || err "failed to write to $BIN_DIR"
mv -f "$staged" "$BIN_DIR/cctop" ||
  {
    rm -f "$staged"
    err "failed to install to $BIN_DIR/cctop"
  }

info "Installed cctop $("$BIN_DIR/cctop" --version 2>/dev/null || echo "") to $BIN_DIR/cctop"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    info ""
    info "note: $BIN_DIR is not on your PATH. Add it, e.g.:"
    info "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile"
    ;;
esac
