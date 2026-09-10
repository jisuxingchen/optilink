#!/usr/bin/env bash
set -euo pipefail

DSH_VERSION="0.1.2-rc.1"
PREFIX="$HOME/.local"
BIN_DIR="$PREFIX/bin"
PKG_BIN="$PREFIX/node_modules/.bin/dsh"

mkdir -p "$BIN_DIR"

if [[ ! -x "$PKG_BIN" ]] || [[ "$($PKG_BIN --version 2>/dev/null || true)" != "$DSH_VERSION" ]]; then
  echo "Installing @deepseek-ai/dsh@$DSH_VERSION into $PREFIX ..."
  npm install --no-audit --no-fund --prefix "$PREFIX" "@deepseek-ai/dsh@$DSH_VERSION"
fi

ln -sfn "$PKG_BIN" "$BIN_DIR/dsh"

if ! grep -qs 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.bashrc"; then
  printf '\n# OptiLink / DeepSeek Harness\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.bashrc"
fi

"$BIN_DIR/dsh" --version
