# 界面截图

本目录保存 README 与文档引用的界面截图。所有图片均由 `scripts/screenshot.py`
**直接截取真实运行窗口**生成，不含手绘、拼接或后期修饰。

## ⚠️ 维护约定（硬性）

**任何会改变界面观感的改动，必须在同一个提交里同步刷新受影响的截图。**

需要刷新截图的情形包括但不限于：

- 新增 / 修改 / 删除功能，菜单项、工具栏按钮、状态栏信息项发生变化
- 对话框（首选项、快捷键等）的内容或排版变化
- 配色、字体、行距、圆角、图标、间距等视觉样式调整
- 标签栏、分屏、大纲、查找栏等布局行为变化
- 应用更名、图标更换、版本号变更导致窗口标题变化

理由：截图是面向用户的文档，一张过期截图会直接误导使用者，且与发布版本不一致。
**代码合并前请确认 `docs/screenshots/` 与当前界面一致**；若确实不影响观感，在提交信息里注明「界面无变化」。

尚未有截图覆盖、但值得补拍的界面状态：大纲 TOC 抽屉、查找替换悬浮栏、命令面板、
标签溢出的横向滚动、浅色 / 深色主题对照、导出的 HTML 效果、
**悬停提示（tooltip，B58 起为自绘层）**。
（原先这里的「标签栏折叠下拉」已随 B53 删除，不要再拍。）

## 当前截图

| 文件 | 内容 |
| --- | --- |
| `main.png` | 主界面：左右分屏，左侧 Markdown 源码、右侧实时预览（深色主题） |
| `preferences.png` | 设置 → 首选项 弹窗：外观 / 字体与行距 / 编辑器 / Markdown 预览 |
| `keymap.png` | 设置 → 快捷键 面板：搜索过滤、分组列表、可改绑键位 |
| `code-light.png` | 浅色主题下的代码视图：多标签、TypeScript 语法高亮、代码折叠 |

⚠️ **待刷新（B53–B57 改了标签栏，图已过期）**：`main.png`。
标签已是 **24px 药丸、标签栏 32px**，且**名字前有文件类型图标**（按语言家族取色的矢量字形）。
补拍 `main.png` 时演示会话请**放几个不同语言的标签**（如 `docs/example.md` + 某个 `.ts` / `.json`），
否则截图里看不出图标按家族配色 —— 只有一个 md 标签时所有图标都是同一色，等于白拍。

> B58 把提示换成了自绘层（原生 `title` 已弃用），但**提示只在悬停时出现，静态截图不受影响**，
> 所以 `main.png` 那几张不必因此重拍；想展示提示效果可另拍一张 `tooltip.png`（悬停工具栏或标签）。

## 如何刷新

截图依赖运行中的 exe 与一份演示会话。**不要用当前工作会话去拍**，否则会拍到无关文件。

1. 构建可运行版本（`cargo build --release` 产出的是 devUrl 变体，会白屏）：

   ```bash
   node node_modules/@tauri-apps/cli/tauri.js build --config '{"build":{"beforeBuildCommand":""}}'
   ```

2. 备份并写入演示会话 `%APPDATA%\LitePad\session.json`。
   会话字段为 **camelCase**（`cursorLine` / `viewMode` / `activePanel`），
   与 `src/ipc/api.ts` 的 `SessionState` 一致。

   分屏「左源码 + 右预览」的关键是把**同一个 md 文件**放进两个面板，
   分别指定 `viewMode: "source"` 与 `viewMode: "preview"`：

   ```jsonc
   {
     "panels": [
       { "tabs": [ { "path": "E:/Project/LitePad/docs/example.md", "encoding": "UTF-8",
                     "eol": "LF", "cursorLine": 8, "cursorCol": 1, "viewMode": "source" } ],
         "active": 0 },
       { "tabs": [ { "path": "E:/Project/LitePad/docs/example.md", "encoding": "UTF-8",
                     "eol": "LF", "cursorLine": 1, "cursorCol": 1, "viewMode": "preview" } ],
         "active": 0 }
     ],
     "layout": { "kind": "split", "dir": "h", "ratio": 0.5,
                 "a": { "kind": "leaf", "panelId": 0 },
                 "b": { "kind": "leaf", "panelId": 1 } },
     "activePanel": 0
   }
   ```

   主题等在 `settings.json` 中设置（`"theme": "dark"` / `"light"`）。

3. 启动 exe 并截图。窗口会先被移到左上角、调整为 1600×1000 再抓取：

   ```bash
   python scripts/screenshot.py --exe litepad.exe --size 1600x1000 \
       --out docs/screenshots/main.png
   ```

   `--exe <进程名>` 按进程定位窗口，比标题关键字可靠（资源管理器标题里也可能含 "LitePad"）；
   另有 `--pid <pid>` 与 `--screen`（全屏）。

4. 对话框需要点开菜单再截。菜单栏各项与弹层的**物理像素**坐标可先用脚本量出来，
   不要凭肉眼估：`docs/screenshots` 的窗口四角固定为 `(0,0)`–`(1600,1000)`，
   菜单文字簇的中心可按亮度阈值聚类定位（参考历史脚本思路：按行/列扫描截图找文字簇）。

5. 拍完删除备份的演示会话，恢复用户自己的 `session.json` / `settings.json`。

## 注意

- 会话与会话恢复相关字段若出现「重启后光标回到第 1 行 / 预览模式丢失」，
  多半是 Rust `TabSession` 的 serde 命名与前端不一致（详见 `.workbuddy/memory/ref/architecture-detail.md`），
  而不是截图脚本的问题。
- 本机显示缩放为 150%，`scripts/screenshot.py` 会先声明 DPI 感知，因此 `--size` 即真实像素。
