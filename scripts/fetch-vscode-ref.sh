#!/usr/bin/env bash
# 拉取 microsoft/vscode（MIT）中与本项目（LitePad）相关的源码，作为 UI / 架构改进的参考。
#
# 为什么不用 git clone：整仓 1.4 GB，而我们要的只是「设计语言 + 关键控件实现」。
# 逐文件 curl 到 docs/vscode-reference/ 镜像原路径，体积可控、可重复、可 diff。
#
# 用法：
#   bash scripts/fetch-vscode-ref.sh                # 取 main
#   bash scripts/fetch-vscode-ref.sh v1.137.0       # 取指定 tag / commit
#
# ⚠️ 需要外网。会话沙箱会拦网络，本地跑请在允许联网的环境执行。

set -uo pipefail

REF="${1:-main}"
RAW="https://raw.githubusercontent.com/microsoft/vscode/${REF}"
API="https://api.github.com/repos/microsoft/vscode"
DEST="docs/vscode-reference"

FILES=(
  # ---------- Modern UI：VS Code 1.129+ 的新设计语言（本项目对标的主要来源）----------
  "src/vs/workbench/contrib/modernUI/browser/media/tabs.css"
  "src/vs/workbench/contrib/modernUI/browser/media/connectedEditorTabs.css"
  "src/vs/workbench/contrib/modernUI/browser/media/roundedCorners.css"
  "src/vs/workbench/contrib/modernUI/browser/media/padding.css"
  "src/vs/workbench/contrib/modernUI/browser/media/fontRamp.css"
  "src/vs/workbench/contrib/modernUI/browser/media/sashHandles.css"
  "src/vs/workbench/contrib/modernUI/browser/media/paneHeaders.css"
  "src/vs/workbench/contrib/modernUI/browser/media/shadows.css"
  "src/vs/workbench/contrib/modernUI/browser/media/statusBar.css"
  "src/vs/workbench/contrib/modernUI/browser/media/editorBorder.css"
  "src/vs/workbench/contrib/modernUI/browser/media/activityBar.css"
  "src/vs/workbench/contrib/modernUI/browser/media/commandCenter.css"
  "src/vs/workbench/contrib/modernUI/browser/media/keyboardFocusOnly.css"
  "src/vs/workbench/contrib/modernUI/browser/media/notificationsDialogs.css"
  "src/vs/workbench/contrib/modernUI/browser/media/titlebar.css"
  "src/vs/workbench/contrib/modernUI/browser/modernUI.contribution.ts"
  "src/vs/workbench/contrib/modernUI/browser/connectedEditorTabs.ts"

  # ---------- 编辑器组 / 标签 / 标题栏 ----------
  "src/vs/workbench/browser/parts/editor/media/editorgroupview.css"
  "src/vs/workbench/browser/parts/editor/media/multieditortabscontrol.css"
  "src/vs/workbench/browser/parts/editor/media/singleeditortabscontrol.css"
  "src/vs/workbench/browser/parts/editor/media/editortitlecontrol.css"
  "src/vs/workbench/browser/parts/editor/media/breadcrumbscontrol.css"
  "src/vs/workbench/browser/parts/editor/media/editorplaceholder.css"
  "src/vs/workbench/browser/parts/editor/media/editorstatus.css"
  "src/vs/workbench/browser/parts/editor/media/sidebysideeditor.css"
  "src/vs/workbench/browser/parts/editor/editorTabsControl.ts"
  "src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts"
  "src/vs/workbench/browser/parts/editor/singleEditorTabsControl.ts"
  "src/vs/workbench/browser/parts/editor/editorGroupView.ts"
  "src/vs/workbench/browser/parts/editor/editorTitleControl.ts"
  "src/vs/workbench/browser/parts/editor/editorAutoSave.ts"
  "src/vs/workbench/browser/parts/editor/editorConfiguration.ts"
  "src/vs/workbench/browser/parts/editor/editorDropTarget.ts"

  # ---------- 网格布局 / 分屏 / 分隔条 / 滚动条 ----------
  "src/vs/base/browser/ui/grid/gridview.css"
  "src/vs/base/browser/ui/grid/gridview.ts"
  "src/vs/base/browser/ui/splitview/splitview.css"
  "src/vs/base/browser/ui/splitview/splitview.ts"
  "src/vs/base/browser/ui/sash/sash.css"
  "src/vs/base/browser/ui/sash/sash.ts"
  "src/vs/base/browser/ui/scrollbar/media/scrollbars.css"

  # ---------- 菜单 / 弹层 ----------
  "src/vs/base/browser/ui/menu/menubar.css"
  "src/vs/base/browser/ui/menu/menu.ts"
  "src/vs/base/browser/ui/contextview/contextview.css"
  "src/vs/workbench/browser/media/floatingPanels.css"

  # ---------- 工具栏 / 按钮 / 输入控件 ----------
  "src/vs/base/browser/ui/toolbar/toolbar.css"
  "src/vs/base/browser/ui/actionbar/actionbar.css"
  "src/vs/base/browser/ui/button/button.css"
  "src/vs/base/browser/ui/inputbox/inputBox.css"
  "src/vs/base/browser/ui/findinput/findInput.css"
  "src/vs/base/browser/ui/countBadge/countBadge.css"
  "src/vs/base/browser/ui/selectBox/selectBox.css"
  "src/vs/base/browser/ui/list/list.css"
  "src/vs/base/browser/ui/list/listView.ts"
  "src/vs/base/browser/ui/list/listWidget.ts"

  # ---------- 命令面板（quick input）/ 查找 / 搜索 ----------
  "src/vs/platform/quickinput/browser/media/quickInput.css"
  "src/vs/editor/contrib/find/browser/findWidget.css"
  "src/vs/workbench/contrib/search/browser/media/searchview.css"

  # ---------- 工作台外壳（标题栏 / 状态栏 / 侧边栏 / 面板）----------
  "src/vs/workbench/browser/media/style.css"
  "src/vs/workbench/browser/parts/statusbar/media/statusbarpart.css"
  "src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css"
  "src/vs/workbench/browser/parts/panel/media/panelpart.css"
  "src/vs/workbench/browser/parts/sidebar/media/sidebarpart.css"
  "src/vs/workbench/browser/parts/activitybar/media/activitybarpart.css"
  "src/vs/workbench/browser/parts/media/paneCompositePart.css"

  # ---------- 首选项（设置界面，对应本项目的首选项弹窗）----------
  "src/vs/workbench/contrib/preferences/browser/media/settingsEditor2.css"

  # ---------- Markdown 预览（本项目核心功能）----------
  "src/vs/workbench/contrib/markdown/browser/media/markdown.css"
  "src/vs/workbench/contrib/markdown/browser/markdownDocumentRenderer.ts"

  # ---------- 悬停提示（tooltip，对应本项目自绘的 .tooltip 层）----------
  # B58 起提示全应用改为自绘层（原生 title 不可控），外观/交互数值取自这几份：
  #   外观与指针几何 → platform/hover/browser/hover.css、base/browser/ui/hover/hoverWidget.css
  #   延时与 groupId 秒开规则 → platform/hover/browser/hoverService.ts、workbench.contribution.ts
  #   键帽数值 → base/browser/ui/keybindingLabel/keybindingLabel.css
  "src/vs/platform/hover/browser/hover.css"
  "src/vs/platform/hover/browser/hoverWidget.ts"
  "src/vs/platform/hover/browser/hoverService.ts"
  "src/vs/platform/hover/browser/updatableHoverWidget.ts"
  "src/vs/base/browser/ui/hover/hoverWidget.css"
  "src/vs/base/browser/ui/hover/hoverWidget.ts"
  "src/vs/base/browser/ui/hover/hover.ts"
  "src/vs/base/browser/ui/keybindingLabel/keybindingLabel.css"
  "src/vs/editor/contrib/hover/browser/hover.css"

  # ---------- 主题色彩令牌（tab.* / editorGroup.* 等定义处）----------
  "src/vs/platform/theme/common/colors/baseColors.ts"
  "src/vs/platform/theme/common/colors/editorColors.ts"
  "src/vs/platform/theme/common/colors/miscColors.ts"
  "src/vs/workbench/common/theme.ts"
  "LICENSE.txt"
)

ok=0
failed=()

# RESUME=1 只补缺失的文件。脚本本身是幂等的（整目录覆盖），但整跑一遍要 5 分钟以上。
RESUME="${RESUME:-0}"

for f in "${FILES[@]}"; do
  out="${DEST}/${f}"
  if [ "$RESUME" = "1" ] && [ -s "$out" ]; then
    ok=$((ok + 1))
    printf '  skip  %s\n' "$f"
    continue
  fi
  mkdir -p "$(dirname "$out")"
  # ⚠️ raw.githubusercontent 会限流/掐连接：同一个路径可能这一分钟 200、下一分钟 000
  #    （实测首轮 65 份里挂了 14 份，重试全部 200）。因此必须带重试，
  #    且要 --retry-all-errors —— 默认只重试 HTTP 错误，「连接被重置」不重试。
  if curl -fsS --max-time 60 --retry 4 --retry-delay 3 --retry-all-errors \
    -o "$out" "${RAW}/${f}"; then
    ok=$((ok + 1))
    printf '  ok    %s\n' "$f"
  else
    # 再探一次状态码：404 = 上游路径变了（要改脚本清单），000 = 网络问题（重跑即可）
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${RAW}/${f}")
    rm -f "$out"
    failed+=("$f")
    printf '  FAIL(%s) %s\n' "$code" "$f"
  fi
done

sha=$(curl -fsS --max-time 30 "${API}/commits/${REF}" 2>/dev/null |
  grep -o '"sha": *"[0-9a-f]\{40\}"' | head -1 | cut -d'"' -f4)

cat >"${DEST}/REVISION.txt" <<EOF
upstream: https://github.com/microsoft/vscode
ref:      ${REF}
commit:   ${sha:-unknown}
fetched:  $(date -u '+%Y-%m-%dT%H:%M:%SZ')
license:  MIT (见同目录 LICENSE.txt)
files:    ${ok} 份

本目录是 microsoft/vscode 源码的**只读参考副本**，用于 LitePad 的样式与架构对照。
不要在这里改代码 —— 要更新请重跑 scripts/fetch-vscode-ref.sh。
EOF

echo
echo "完成：${ok}/${#FILES[@]} 份 → ${DEST}/"
if [ "${#failed[@]}" -gt 0 ]; then
  echo "失败 ${#failed[@]} 份（上游路径可能已变动，需要更新脚本里的清单）："
  printf '  - %s\n' "${failed[@]}"
  exit 1
fi
