#!/usr/bin/env bash
# bump-version.sh —— LitePad 版本号的**唯一**写入入口（四处同步）。
#
# 规则（用户 2026-10-18 定）：
#   每次修改      → **自动** +patch（无需征询）
#   较大改动 feat  → **先问用户**是否 +minor
#   非兼容大改动   → **先问用户**是否 +major
# 本脚本只负责「把版本号写对」，**不判断该升哪一档** —— 判断权在规则与用户：
# patch 由交付流程自动调用，minor/major 只能由用户拍板后手动调用（或走 release.sh）。
#
# 用法：
#   bash scripts/bump-version.sh patch                  # 0.20.0 → 0.20.1（只改文件）
#   bash scripts/bump-version.sh patch --commit         # 改完并单独提交（干净时才提交）
#   bash scripts/bump-version.sh minor --commit --note "B305 最近打开"
#   bash scripts/bump-version.sh 0.21.0                 # 指定版本
#
# 为什么单独成脚本：release.sh 里原本内联了一份「三处同步 + cargo update」，
# 两处各写一遍 = 加一处漏一处（记忆里同类教训已多次）。现在 release.sh 第 1 步也调本脚本。
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1

LEVEL="${1:?用法: bash scripts/bump-version.sh <patch|minor|major|x.y.z> [--commit] [--note '...']}"
shift || true
DO_COMMIT=0
NOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) DO_COMMIT=1 ;;
    --note) NOTE="${2:-}"; shift ;;
    *) echo "✗ 未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

VER_FILES=(package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock)

CUR="$(node -p "require('./package.json').version" 2>/dev/null || echo "")"
[ -n "$CUR" ] || { echo "✗ 读不到 package.json 的 version" >&2; exit 1; }

if [[ "$LEVEL" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW="$LEVEL"
elif [[ "$LEVEL" =~ ^(patch|minor|major)$ ]]; then
  IFS=. read -r MA MI PA <<< "$CUR"
  case "$LEVEL" in
    major) MA=$((MA + 1)); MI=0; PA=0 ;;
    minor) MI=$((MI + 1)); PA=0 ;;
    patch) PA=$((PA + 1)) ;;
  esac
  NEW="$MA.$MI.$PA"
else
  echo "✗ 无效档位：$LEVEL（应为 x.y.z 或 patch/minor/major）" >&2
  exit 2
fi

if [ "$NEW" = "$CUR" ]; then echo "· 版本号已是 v$NEW，无需改动"; exit 0; fi
if git rev-parse -q --verify "refs/tags/v$NEW" >/dev/null; then
  echo "✗ tag v$NEW 已存在，不能把版本号写成一个已发布过的数字" >&2
  exit 1
fi

# ---- 四处同步（三处文本 + Cargo.lock 交给 cargo 自己写，别手改）----
# ⚠️ NEW 必须走**环境变量**注入：`node -e '…' NEW=x` 只是把它当 argv 传进去，
#    脚本里读 process.env.NEW 会得到 undefined，于是把 "undefined" 写进版本号。
export NEW
node -e '
  const fs = require("fs"), NEW = process.env.NEW;
  const edit = (f, re, rep) => {
    const t = fs.readFileSync(f, "utf-8");
    if (!re.test(t)) { console.error("✗ " + f + " 中找不到版本号（格式变了？别静默跳过）"); process.exit(1); }
    fs.writeFileSync(f, t.replace(re, rep));
  };
  edit("package.json", /("version":\s*")[^"]+(")/, "$1" + NEW + "$2");
  edit("src-tauri/tauri.conf.json", /("version":\s*")[^"]+(")/, "$1" + NEW + "$2");
  edit("src-tauri/Cargo.toml", /^(version\s*=\s*")[^"]+(")/m, "$1" + NEW + "$2");
' || { echo "✗ 写入失败，已中止" >&2; exit 1; }

# cargo 未必在 PATH 里（与 release.sh / build-all.sh 同款兜底）
command -v cargo >/dev/null 2>&1 || export PATH="$HOME/.cargo/bin:$PATH"
if command -v cargo >/dev/null 2>&1; then
  (cd src-tauri && cargo update -p litepad -q) || { echo "✗ Cargo.lock 同步失败" >&2; exit 1; }
else
  echo "⚠ 找不到 cargo：Cargo.lock 未同步（四处会不一致，守卫会拦住 —— 补上工具链再跑）" >&2
fi

echo "✓ 版本号 v$CUR → v$NEW（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）"

if [ "$DO_COMMIT" = 1 ]; then
  # ⚠️ 只有当**除版本号四件套外干净**时才单独提交。工作树脏时提交会把别人的在飞改动一起卷进来
  #    （本项目红线：工作区脏时绝不提交），所以那种情况下只写文件 + 给出下一步命令。
  others="$(git status --porcelain | grep -vE '^( M|M |A  |\?\?) (package\.json|src-tauri/(tauri\.conf\.json|Cargo\.toml|Cargo\.lock))$' || true)"
  if [ -n "$others" ]; then
    echo "⚠ 工作树另有改动 ⇒ **不自动提交**版本号（别把并行会话的在飞文件卷进来）。"
    echo "  待那批改动的提交落地后，手动补一条："
    echo "      git add ${VER_FILES[*]} && git commit -m 'chore(version): v$NEW（patch）'"
  else
    git add "${VER_FILES[@]}"
    msg="chore(version): v$NEW（$LEVEL）"
    [ -n "$NOTE" ] && msg="$msg · $NOTE"
    git commit -m "$msg" >/dev/null && echo "✓ 已单独提交：$msg"
  fi
fi
