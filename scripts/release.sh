#!/usr/bin/env bash
# LitePad 发布流程（本地）：
#   1. 校验工作树干净、版本号三处同步 bump（package.json / tauri.conf.json / Cargo.toml）
#   2. 全量构建（npm run build:all：tsc + vitest + cargo build/test + tauri release + NSIS）
#      —— 加 --ci 可跳过：由 GitHub Actions 在 tag 上构建并发布（避免本地重复一次 40 分钟构建）
#   3. 提交 + 打 tag（vX.Y.Z）
#   4. 推送后 GitHub Actions 自动构建并创建 Release（.github/workflows/release.yml）
#
# 用法：
#   bash scripts/release.sh 0.2.0             # 指定版本，本地全量构建后打 tag
#   bash scripts/release.sh minor             # 0.1.0 → 0.2.0
#   bash scripts/release.sh minor --ci        # 同上，但跳过本地构建，交给 Actions
#   bash scripts/release.sh patch             # 0.1.0 → 0.1.1
#   bash scripts/release.sh major             # 0.1.0 → 1.0.0
#
# 记住：Actions 的 Release 只由 **v\* tag** 触发。只提交不推 tag = 不会有任何发布。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

VER_ARG="${1:?用法: bash scripts/release.sh <x.y.z|patch|minor|major> [--ci]}"
SKIP_BUILD=0
if [ "${2:-}" = "--ci" ]; then SKIP_BUILD=1; fi

# ---- 前置校验 ----
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作树不干净，先提交/暂存全部改动："
  git status --short
  exit 1
fi

CUR=$(node -p "require('./package.json').version")

# ---- 1) 版本号四处同步 ----
# 唯一实现在 scripts/bump-version.sh（档位计算、目标 tag 冲突校验、Cargo.lock 同步都在那里）。
# 这里**不再重复写一遍**：两处各写一份 = 以后加一处漏一处（本项目已有同类教训）。
bash scripts/bump-version.sh "$VER_ARG" || { echo "✗ 版本号同步失败（档位非法 / 目标 tag 已存在 / 文件格式变了）" >&2; exit 1; }
VER="$(node -p "require('./package.json').version")"
if [ "$VER" = "$CUR" ]; then
  echo "✗ 版本号没有变化（仍是 v$CUR），没什么可发布的" >&2
  exit 1
fi

echo "═══════════════════════════════════════"
echo " LitePad release：v$CUR → v$VER"
echo "═══════════════════════════════════════"

# ---- 1.5) 更新日志：从 Conventional Commit 自动生成本版小节（随后进同一个 release 提交）----
bash scripts/gen-changelog.sh "$(git describe --tags --abbrev=0 2>/dev/null)" "$VER"

# ---- 2) 全量构建（含测试与 NSIS 打包）----
if [ "$SKIP_BUILD" -eq 1 ]; then
  echo "⏭ 跳过本地全量构建（--ci）：交由 GitHub Actions 在 tag 上构建 NSIS 并创建 Release"
else
  npm run build:all
  echo "✓ 全量构建通过"
  echo "  产物：src-tauri/target/release/litepad.exe"
  echo "        src-tauri/target/release/bundle/nsis/LitePad_${VER}_x64-setup.exe"
fi

# ---- 3) 提交 + tag ----
git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md
git commit -m "chore(release): v$VER"
git tag -a "v$VER" -m "LitePad v$VER"
echo "✓ 已提交并打 tag v$VER"

# ---- 4) 推送指引 ----
cat <<EOF

后续手动步骤：
  1. git push origin main --follow-tags      # 推送提交与 tag
     （注意：必须推 tag —— GitHub 的 Release 只由 v* tag 触发；
      只推 main 只会跑 CI 编译校验，不会发布）
  2. GitHub Actions（release.yml）会在 tag 触发后自动：
     Windows runner 构建 → NSIS 安装包 → 创建 GitHub Release 并附产物
     查看进度：gh run list --workflow=release.yml   或   gh run watch
  3. 如需本地产物先传：gh release create v$VER src-tauri/target/release/bundle/nsis/*.exe
  4. 发布失败可在 Actions 页面手动 Dispatch（workflow_dispatch），填入 tag 重跑
EOF
