#!/usr/bin/env bash
# LiteMD release build (frontend + rust + bundle).
#
# Requires the GNU host toolchain; see rust-toolchain.toml.
set -e

export PATH="/c/msys64/mingw64/bin:$HOME/.cargo/bin:$PATH"

cd "$(dirname "$0")/.."

exec npm run tauri build "$@"
