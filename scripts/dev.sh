#!/usr/bin/env bash
# LitePad dev runner.
#
# This machine has no MSVC Build Tools, so the project pins the GNU host
# toolchain (see rust-toolchain.toml) and links with MSYS2 MinGW-w64.
set -e

# MSYS2 MinGW provides the linker for the GNU host toolchain
# (pinned by rust-toolchain.toml); ~/.cargo/bin holds the rustup proxies.
export PATH="/c/msys64/mingw64/bin:$HOME/.cargo/bin:$PATH"

cd "$(dirname "$0")/.."

exec npm run tauri dev "$@"
