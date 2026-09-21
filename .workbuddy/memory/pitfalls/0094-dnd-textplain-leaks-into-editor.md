# ADR 0094：标签拖拽的 `text/plain` + 冒泡阶段监听 → 落点编辑器把文件名插进正文

- **状态**：Accepted（B91-2 首次交付即引入，用户当场报出）
- **域**：拖拽 / HTML5 DnD × contenteditable（CodeMirror 6）
- **来源**：用户报「拖动标签会导致**面板中其他文档里插入文件名**」
- **关联**：`pitfalls/0093`（同一次报告的另一半）；`src/shell/tabdnd.ts` 的模块头

## 背景（Context）

标签拖拽是**本页/本应用内部的协议**：谁被拖了、要落到哪，全部由 `TAB_MIME`
（`application/x-litepad-tab`）里的载荷 + claim/payload IPC 决定。但 B91-2 首次交付时，
`startTabDrag` 里还顺手写了一份**给人看的可读正文**：

```ts
dt.effectAllowed = "copyMove";
dt.setData(TAB_MIME, encodeTabDrag(full));
if (payload.name) dt.setData("text/plain", payload.name);   // 「拖到别的编辑器里粘出标签名」
```

而 `installTabDnd` 的事件监听挂在 **document 的冒泡阶段**。

## 根因（Root Cause）

两处叠加，缺一不可：

1. **`text/plain` 是一份「可以往编辑器里插」的合法内容。** dataTransfer 里只要存在可读
   文本，落点那个 `contenteditable`（本项目的 CM6 编辑器）就会按「有人拖了一段文本进来」
   处理，把文件名插进正文。
2. **冒泡阶段的监听比组件晚。** 事件派发顺序是 `document(capture) → … → target → … →
   document(bubble)`。监听挂在冒泡阶段时，**目标元素（编辑器）自己的监听先跑**，等我们的
   处理器接手时，文本已经插完了 —— 我们拦得住「标签落在哪」，拦不住「正文被改」。

**跨窗口时更彻底**：目标窗口要问源窗口要正文（HTML5 的自定义 MIME 未必能跨过 WebView2
的进程边界），而 `drop` 里 `getData` 读不出载荷时，旧代码直接 `return` —— **连
`preventDefault()` 都没有**，于是浏览器自己动手，把 `text/plain` 插进用户的文档。

**判据**：拖一个标签落到**另一个面板的编辑器**上，标签被正常搬走，但那份文档的正文里
**多出一行文件名**（用户报的正是这个）。窗口内、窗口间都能复现。

## 决策（Decision）

三条一起上，任何一条单独都不够：

1. **不放 `text/plain`。** 标签拖拽是内部协议，不对外提供任何可读正文。这同时是跨窗口的
   兜底 —— 自定义 MIME 没跨过去时，dataTransfer 里**没有任何东西**可以插。
2. **监听一律挂捕获阶段 + `stopPropagation`。** document 的捕获监听比任何页面内组件都早，
   拦得住之后组件根本收不到事件。
3. **`drop` 先无条件 `preventDefault`（claim），再谈载荷读不读得出来。** 空拦截的代价只是
   「这次拖拽没落地」，漏拦的代价是**用户文档被改坏**；读不出载荷时另记一行日志
   （`onWarn("tab drag payload unreadable")`）以免变成「静默无效」。

`claim()` 辅助把这三件事收在一处，并**只对标签拖拽生效** —— 文件拖入（`Files`）必须原样
放行给 `filedrop.ts`，绝不误伤。

## 后果与守卫（Consequences）

- 放弃了一个「附加功能」：把标签拖到**别的应用**里不再粘出文件名。这是有意的取舍 ——
  代价（自家文档被改坏）远大于收益。
- 守卫（都在 `tests/tabdnd.test.ts`）：
  ·「写私有 MIME…且**不放可读正文**」→ 断言 `getData("text/plain") === ""` 且 `types` 只有 `TAB_MIME`；
  ·「标签拖拽的事件**绝不漏进页面内组件**」→ 编辑器上挂 dragover/drop/dragend 监听，断言一个都没听到；
  ·「但**文件拖入照旧漏给**页面内组件」→ 对照组，防误伤 `filedrop.ts`；
  ·「载荷读不出来…」→ 断言 `defaultPrevented === true`。
- `tests/regressions.test.ts` 静态契约：`not.toMatch(/setData\(\s*["']text\/plain["']/)`、
  必须匹配 `addEventListener("drop", onDrop, CAPTURE)` 与 `claim` 里的
  `e.preventDefault(); e.stopPropagation()`。
  反向验证：还原 `text/plain` / 把注册改回冒泡，上述用例必须**变红**。
- 通用教训：**凡是把内容「交给别人处理」的通道，都要问一句「别人会拿它做什么」。**
  `text/plain` 对编辑器就是「插入这段文本」的指令；而**事件监听必须假设页面里还有别的
  监听者**，想自己说了算就得挂捕获阶段。
