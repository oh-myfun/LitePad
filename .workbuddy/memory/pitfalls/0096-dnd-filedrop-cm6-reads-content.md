# ADR 0096：文件拖入监听挂冒泡阶段 → CM6 把**文件内容**读出来插进文档

- **状态**：Accepted（B91-2 收尾时用户报出，是同一次改动暴露的第三处回归）
- **域**：拖拽 / HTML5 DnD × CodeMirror 6
- **来源**：用户报「拖入文档到打开的文档窗口里，会直接插入文档内容……而且目前应该没有插入
  文档内容的功能设计才对」
- **关联**：`pitfalls/0093`、`0094`（同一次改造的另外两处回归）；`src/shell/filedrop.ts` 函数头

## 背景（Context）

B91 关掉 wry 原生拖放（`dragDropEnabled: false`）后，页面内 HTML5 拖放复活，路径改走
WebView2 桥。但 `installFileDropTarget` 的四个监听（dragenter/over/leave/drop）仍挂在
**document 的冒泡阶段** —— 和 0094 里 `tabdnd.ts` 当初犯的是同一个错，只是这次的受害者不同。

## 根因（Root Cause）

CodeMirror 6 的 `handlers.drop`（`@codemirror/view`）**自带「拖文件进来就把内容读出来插进去」
的行为**：

```js
let files = event.dataTransfer.files;
if (files && files.length) {
  for (let i = 0; i < files.length; i++) {
    let reader = new FileReader();
    reader.readAsText(files[i]);          // ← 读的是文件内容
    ...
    dropText(view, event, text, false);   // ← 插进当前文档
  }
}
```

它的 `eventObservers` 挂在 **`view.contentDOM`** 上，也就是**编辑器自己的 DOM**。事件派发顺序
是 `document(capture) → … → contentDOM → … → document(bubble)`，所以冒泡阶段的我们**永远比
CM6 晚** —— 等处理器跑到，正文已经被改了，`preventDefault()` 无从撤销那次插入。

**判据**：从资源管理器拖一个文件进已打开的文档，文件照常打开（宿主那条链路没坏），但当前
文档的正文里**多出一份被拖文件的全部内容**。

## 决策（Decision）

1. **监听一律挂捕获阶段 + `stopPropagation`**（`claim()` 辅助，与 `tabdnd.ts` 同构）：
   document 的捕获监听比任何页面内组件都早，认领之后 `drop` 根本到不了编辑器。
2. **`claim()` 只对文件拖拽生效**（`types` 含 `Files`）：编辑器内部拖选区（`Text`）与标签拖拽
   （自定义 MIME）原样放行，两套拖拽共用一条 `drop` 事件但互不干扰。
3. **不改「落点之后怎么办」**：文件拖入仍旧交给宿主换路径 → 按面板/分区打开或分屏，
   菜单那一项插的是**文件路径**。

⚠️ **本项目没有「插入文档内容」这个功能**：`main.ts` 的 `insertDroppedPath` 插的是路径字符串
（`changes: { from: pos, insert: path }`），内容从来不是我们要的东西。所以这不是「该不该插」
的取舍，而是**必须拦**。

## 后果与守卫（Consequences）

- 守卫（`tests/filedrop.test.ts`）：
  · 编辑器 DOM 替身上挂四个监听，断言文件 `drop` / `dragover` **一个都没收到**（收到就等于
    CM6 会把内容插进文档），同时 `defaultPrevented === true`、文件仍交给宿主；
  · 对照组：`types: ["Text"]` 与自定义 MIME 的 `drop` 必须**原样漏给**编辑器（别误伤 CM6 的
    拖选区和 `tabdnd.ts`）；
  · 静态契约：四个 `addEventListener(…, CAPTURE)` + `capture: true` + `stopPropagation()`，
    卸载也带同选项。
- 反向验证：`CAPTURE` 改回 `{ capture: false }` → 3 条变红（drop、dragover 漏给编辑器、
  静态契约），恢复后 19/19 绿。
- `tests/tabdnd.test.ts` 里「文件拖入照旧漏给页面内组件」那条是对照组，只装 `installTabDnd`
  （不装 `installFileDropTarget`），因此不受本次改动影响 —— 改完记得跑全量，别只看单文件。
- 通用教训（与 0094 同源但更容易漏）：**页面级监听若想「自己说了算」，默认就该挂捕获阶段。**
  尤其要记住 **CM6 这类第三方组件会在自己的 DOM 上吃 `drop`，而且吃法是把文件内容读出来
  插进用户的文档** —— 挂冒泡阶段时，你拦的「默认动作」和你拦的「正文被改」是两件事。
