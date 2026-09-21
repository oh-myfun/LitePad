# ADR 0093：同步摘掉 `setDragImage` 的元素 → Chromium 拍不到快照，拖拽影像整个消失

- **状态**：Accepted（B91-2 首次交付即引入，用户当场报出）
- **域**：拖拽 / HTML5 DnD（Chromium 快照时序）
- **来源**：B91-2 把标签拖拽换成 HTML5 DnD 之后，用户报「窗口内和窗口间拖动 tab 或面板时
  **没有标签影像了**」
- **关联**：`ref/architecture-detail.md`「拖拽」；`pitfalls/0094`（同一次报告的另一半根因）

## 背景（Context）

B91-2 用 `dataTransfer.setDragImage(el, x, y)` 把影像交给系统绘制（这样它能跟出窗口）。
影像元素按「挂进 body → 交给 `setDragImage` → 摘掉」三步走，`startTabDrag` 里是这样写的：

```ts
document.body.appendChild(image);
dt.setDragImage(image, anchor.x, anchor.y);
image.remove();          // ← 认为「setDragImage 是同步快照，返回后就能摘」
```

影像必须**已渲染过**才拍得出图（detached / `display:none` 都是空图），所以离屏挂进 body
这一步是对的。问题出在**摘掉的时机**。

## 根因（Root Cause）

**Chromium 不是在 `setDragImage` 调用时拍快照的，而是在 `dragstart` 派发返回之后**
（源码位置：`blink::DragController::StartDrag`，它在 `DispatchDragEvent` 之后才去读那个
元素、把它画成拖拽影像）。页面在 `dragstart` 处理器里同步把元素移出文档时，轮到
Chromium 读它，元素已经 detached：

```
dragstart 处理器执行 ──┐
  appendChild(image)   │
  setDragImage(image)  │  只是记下「等下用这个元素」
  image.remove()       │  元素此刻已脱离文档
───────────────────────┘
DispatchDragEvent 返回
  → DragController::StartDrag 读 image → 已经不在文档里 → 拍不出图
  → 系统拿不到影像 → 拖整个标签栏 / 整组 / 跨窗口全程都没有跟手影像
```

**判据**：`setDragImage` 的入参、锚点、`inDom` 快照全都正常（单测看着是绿的），但肉眼
完全看不到影像；把 `remove()` 换成 `setTimeout(() => image.remove(), 0)` 立刻恢复。
症状与「拉起的 drag 没有任何 visual」一致，且**窗口内与跨窗口同时失效**（影像都由系统画，
失败就哪儿都没有）。

## 决策（Decision）

**给系统拍快照的元素，摘除必须推到下一轮宏任务。**

```ts
dt.setDragImage(image, anchor.x, anchor.y);
setTimeout(() => image.remove(), 0);   // 快照已拍完，页面上也不会留下浮层
```

对齐 VS Code `applyDragImage` 的写法（`setTimeout(() => dragImage.remove(), 0)`）。
另外顺手在起手处清掉上一轮的残留（`document.querySelectorAll(".tab-drag-image")`），
免得极端时序下越堆越多。

## 后果与守卫（Consequences）

- 影像在 DOM 里多活一帧。**所有「拍完即摘」的同步断言都会因此失效** —— 必须改成
  「调用当刻 `inDom === true`」+「`await setTimeout(0)` 之后已摘」两段式。
  `tests/dnd.ts` 的 `FakeDataTransfer.setDragImage` 在**调用当刻**记录 `inDom` / `offscreen`，
  所以第一段断言仍然成立，只需把第二段推迟到宏任务之后。
- 守卫：`tests/tabdnd.test.ts`「影像：挂进 body 拍快照、**推一帧再摘**」、
  `tests/splitview.test.ts`「拍快照那一刻影像『挂着 + 离屏』」、
  `tests/regressions.test.ts` 的静态契约（必须匹配 `setTimeout(() => image.remove(), 0)`）。
  反向验证：把 `setTimeout(...)` 还原成同步 `remove()`，上述用例必须**变红**。
- 与 `pitfalls/0085`（vite 概率性挂死）同族：**症状是「什么都没发生」而不是报错**。
  这一类只能靠「先问『这个 API 的时机到底是什么时候』」而不是靠日志排查。
