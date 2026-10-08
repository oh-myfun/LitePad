#!/usr/bin/env bash
# LitePad dev runner.
#
# 工具链为 MSVC（见 rust-toolchain.toml：stable-x86_64-pc-windows-msvc）。
# 链接器由 Visual Studio 的 C++ 桌面工作负载 + Windows SDK 提供，rustc 自动探测，无需手工加 PATH。
set -e

export PATH="$HOME/.cargo/bin:$PATH"

cd "$(dirname "$0")/.."

exec npm run tauri dev "$@"
