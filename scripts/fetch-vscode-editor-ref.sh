#!/usr/bin/env bash
# 拉取 microsoft/vscode 中与「文本编辑」相关的源码（editor + base + platform），
# 过滤后落到 docs/vscode-reference/src/，作为 LitePad 编辑器相关改进的参考。
#
# 与 fetch-vscode-ref.sh（逐文件精选清单，约 80 份）不同：本脚本是**目录级**整模块下载，
# 覆盖所有文本编辑相关的交互 / UI / 模型 / 视图 / 装饰 / 补全 / 折叠 / 格式化 / 查找 /
# 悬停 / 重命名 / Diff 编辑器实现，参考时内部 import 可跳转。
#
# 用法：
#   bash scripts/fetch-vscode-editor-ref.sh            # main（最新）
#   bash scripts/fetch-vscode-editor-ref.sh v1.137.0   # 钉版本
#
# ⚠️ 需要外网 + git（会话沙箱会拦网络，本地跑请在允许联网的环境执行）。
# ⚠️ docs/vscode-reference/src/ 被 .gitignore 排除，这里只入库脚本、INDEX.md、REVISION_EDITOR.txt。

set -uo pipefail

REF="${1:-main}"
REPO="https://github.com/microsoft/vscode.git"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/docs/vscode-reference/src"
TMP="$(mktemp -d -t vscode-clone.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

echo "克隆 $REF 的 editor/base/platform（depth 1 + blob:none + sparse）…"
# 参考副本不需要历史，depth 1 大幅减少对象量；
# -c http.version=HTTP/1.1 规避沙箱网络下 GitHub 大仓库常见的 HTTP/2 CANCEL 中断。
git -c http.version=HTTP/1.1 -c core.compression=0 clone --depth 1 --filter=blob:none --sparse --no-tags -q "$REPO" "$TMP"
cd "$TMP"
git fetch --depth 1 origin "$REF"
git -c http.version=HTTP/1.1 sparse-checkout set src/vs/editor src/vs/base src/vs/platform
git checkout -q FETCH_HEAD

SHA="$(git rev-parse HEAD)"
echo "commit: $SHA"

# 过滤 + 拷贝（排除测试 / worker / 语法定义，只留 .ts/.css）
python3 - "$TMP" "$DEST" <<'PY'
import os, sys, shutil
src, dest = sys.argv[1], sys.argv[2]
os.makedirs(dest, exist_ok=True)
keep_ext = (".ts", ".css")
# 整目录排除：Monaco 的语法定义 / 语言贡献 / worker 线程代码（与「文本编辑交互」参考无关）
exclude_dirs = ("/basic-languages/", "/language/", "/worker/")
copied = 0
for root, dirs, files in os.walk(src):
    rel = os.path.relpath(root, src).replace("\\", "/")
    low = "/" + rel.lower() + "/"
    if any(d in low for d in exclude_dirs):
        dirs[:] = []  # 剪掉整个目录，不递归
        continue
    for f in files:
        fl = f.lower()
        if not fl.endswith(keep_ext):
            continue
        if fl.endswith(".test.ts"):
            continue
        if "worker" in fl:  # 文件级排除含 worker 的文件（如 editorWorkerService.ts）
            continue
        full = os.path.join(root, f)
        tgt = os.path.join(dest, rel, f)
        os.makedirs(os.path.dirname(tgt), exist_ok=True)
        shutil.copyfile(full, tgt)
        copied += 1
print(f"copied={copied}")
PY

cat >"$ROOT/docs/vscode-reference/REVISION_EDITOR.txt" <<EOF
upstream: https://github.com/microsoft/vscode
scope:    src/vs/editor + src/vs/base + src/vs/platform（文本编辑相关）
ref:      ${REF}
commit:   ${SHA}
fetched:  $(date -u '+%Y-%m-%dT%H:%M:%SZ')
license:  MIT (见同目录 LICENSE.txt)
filter:   仅 .ts/.css；排除 *.test.ts、文件名含 worker、standalone/basic-languages、standalone/language
note:     本目录（src/）不入库（.gitignore），需要时用本脚本重跑。
EOF

echo "完成 → $DEST"
