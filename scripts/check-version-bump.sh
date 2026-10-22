#!/usr/bin/env bash
# LitePad 版本号守卫（由 .githooks/pre-push 调用）—— 把版本维护口径变成可执行判据。
#
# 口径（用户 2026-10-18 定）：
#   每次修改            → **自动** +patch，不必征询
#   较大改动（feat）     → 必须先**问用户**是否 +minor
#   非兼容的大型改动     → 必须先**问用户**是否 +major
#
# 本脚本**不替用户决定档位**。它只做两件事：
#   A. 「该自动加的 patch 到底加了没有」（没加 = 交付流程漏跑 bump）；
#   B. 「该问的 minor / major 问了没有」（没问 = 拦住推送，逼出那次询问）。
# 旧的「按提交类型自动判档并强制 bump」已废弃：那等于工具替用户拍板，与口径相反。
#
# 用法：
#   bash scripts/check-version-bump.sh                    # 手动查
#   git push origin main                                  # 正常推送（守卫自动跑）
#   LITEPAD_VERSION_ACK=asked git push origin "v<版本>"    # **仅限真的问过用户且用户答不升档**
#   LITEPAD_SKIP_VERSION_CHECK=1 git push ...             # 紧急绕过（版本一致性也不查）
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1

if [ "${LITEPAD_SKIP_VERSION_CHECK:-0}" = "1" ]; then
  echo "⚠ 已按 LITEPAD_SKIP_VERSION_CHECK=1 跳过版本号守卫（版本状态未经校验）" >&2
  exit 0
fi

# ---- 工具必须齐：缺一个就**响亮失败**，不许静默放行 ----
# 钩子环境里 grep 可能不在 PATH（09-18 实测：grep 缺失时下面这些 `grep -c` 全变空串，
# `[ "" -gt 0 ]` 判假 ⇒ 「✓ 版本号守卫通过」其实是**根本没统计**。宁可拦住推送。
for need in grep sed awk node git; do
  command -v "$need" >/dev/null 2>&1 || {
    echo "✗ 版本守卫缺工具「$need」，无法完成统计 —— **拒绝静默放行**（补 PATH 后重推）。" >&2
    exit 1
  }
done

# ---- A0) 四处版本号必须一致（package.json 为准，其余三处必须跟上）----
PKG="$(node -p "require('./package.json').version" 2>/dev/null || echo "")"
TAURI="$(node -p "require('./src-tauri/tauri.conf.json').version" 2>/dev/null || echo "")"
CARGO="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' src-tauri/Cargo.toml | head -1)"
LOCK="$(awk '/^name = "litepad"$/{f=1;next} f&&/^version/{print $3;exit}' src-tauri/Cargo.lock | tr -d '\"')"

if [ -z "$PKG" ]; then echo "⚠ 读不到 package.json 版本，跳过守卫" >&2; exit 0; fi
for pair in "tauri.conf.json:$TAURI" "Cargo.toml:$CARGO" "Cargo.lock:$LOCK"; do
  if [ "${pair#*:}" != "$PKG" ]; then
    echo "✗ 版本号不一致：package.json=$PKG，${pair%%:*}=${pair#*:}" >&2
    echo "  修：bash scripts/bump-version.sh patch   （或 <minor|major>，四处由它一次写齐）" >&2
    exit 1
  fi
done

# ---- 定位最近 tag ----
TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo "")"
if [ -z "$TAG" ]; then echo "· 尚无 tag，跳过版本号守卫"; exit 0; fi
TAG_VER="${TAG#v}"
echo "· 版本号 $PKG，最近 tag $TAG（$TAG_VER）"

split() { IFS=. read -r "$1" "$2" "$3" <<< "$4"; }
MAJOR_C=; MINOR_C=; PATCH_C=; split MAJOR_C MINOR_C PATCH_C "$PKG"
MAJOR_T=; MINOR_T=; PATCH_T=; split MAJOR_T MINOR_T PATCH_T "$TAG_VER"

# ---- A) 每次修改都要有 patch ----
# 统计 tag 以来**碰过产品代码**的提交数（只碰 docs/tests/scripts/记忆的不算一次「修改」）。
PRODUCT_COMMITS="$(git log "$TAG..HEAD" --no-merges --format='%h' -- src/ src-tauri/src/ | grep -c . || true)"
if [ "${PRODUCT_COMMITS:-0}" -gt 0 ] && [ "$PKG" = "$TAG_VER" ]; then
  echo "" >&2
  echo "✗ 版本守卫：$TAG 以来有 $PRODUCT_COMMITS 个改动产品代码的提交，但版本号仍是 v$PKG（没动过）。" >&2
  echo "  口径是「每次修改都要有一档 patch，由交付方在出包前显式推；**同一 bug 多轮只算一档**」⇒ 交付流程漏跑了 bump。补一条：" >&2
  echo "      bash scripts/bump-version.sh patch --commit --note '随 B<本轮 ticket 号>'" >&2
  echo "  （`--note` 里的「随 Bxxx」是判同的额度记录：同一 B 号本版内已出现过，就不该再给第二档）" >&2
  echo "  （若这批提交里混着纯 docs/test 的，也只该有至少一个 patch —— 版本是仓库级，不做逐提交核对）" >&2
  exit 1
fi

# ---- B) feat ⇒ 必须先问用户是否 minor ----
FEATS="$(git log "$TAG..HEAD" --no-merges --pretty=format:'%s' | grep -cE '^feat(\(|\!|:)' || true)"
if [ "${FEATS:-0}" -gt 0 ] && [ "$MINOR_C" = "$MINOR_T" ] && [ "$MAJOR_C" = "$MAJOR_T" ]; then
  if [ "${LITEPAD_VERSION_ACK:-}" = "asked" ]; then
    echo "⚠ $TAG 以来有 $FEATS 个 feat 提交，minor 未动 —— 已按 LITEPAD_VERSION_ACK=asked 放行" >&2
  else
    echo "" >&2
    echo "✗ 版本守卫：$TAG 以来有 $FEATS 个 feat（较大改动）。口径要求**先问用户**是否推进 minor。" >&2
    echo "  正确动作：问用户 →「推进」就 bash scripts/release.sh minor；「不推进」再推：" >&2
    echo "      LITEPAD_VERSION_ACK=asked git push origin main（tag 单独推：git push origin \"v<版本>\"）" >&2
    echo "  ⚠️ 没问过用户就别设这个环境变量 —— 它代表「已征询且用户答不升档」。" >&2
    exit 1
  fi
fi

# ---- B) 破坏性变更 ⇒ 必须先问用户是否 major ----
BREAKING="$(git log "$TAG..HEAD" --no-merges --pretty=format:'%s%n%b' | grep -cE '^[a-z]+\([^)]*\)!|^[a-z]+!:|^BREAKING CHANGE' || true)"
if [ "${BREAKING:-0}" -gt 0 ] && [ "$MAJOR_C" = "$MAJOR_T" ]; then
  if [ "${LITEPAD_VERSION_ACK:-}" = "asked" ]; then
    echo "⚠ $TAG 以来有 $BREAKING 处破坏性变更标记，major 未动 —— 已按 ACK 放行" >&2
  else
    echo "" >&2
    echo "✗ 版本守卫：$TAG 以来有 $BREAKING 处破坏性变更（`!` 或 BREAKING CHANGE）。" >&2
    echo "  口径要求**先问用户**是否推进 major。确认后：" >&2
    echo "      bash scripts/release.sh major            # 用户同意升 major" >&2
    echo "      LITEPAD_VERSION_ACK=asked git push ...   # 用户答不升" >&2
    exit 1
  fi
fi

echo "✓ 版本号守卫通过（patch 已随修改推进；无待征询的 minor/major）"
exit 0
