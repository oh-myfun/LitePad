# 统一同步游标方案（统一坐标系 → 唯一值 → 无漂移）

> 状态：**评估 / 方案阶段**，未经用户批准，代码未改。
> 分支：`sync/unified-cursor`（自 `main@d645114` 开出；该 commit 即"当前方案"备份基线）
> 基线形态：HEAD `d645114`，工作区 clean，全量 81 文件 1282 passed。

## 1. 现状：为什么会漂移

同步滚动现在是「**若干条路径 × 各自一套锚**」，彼此之间靠人工对齐。实测四处锚不一致：

| 环节   | 函数                                                           | 偏移锚                                 | 位置语义                   |
| ------ | -------------------------------------------------------------- | -------------------------------------- | -------------------------- |
| 源码读 | `topVisibleLineFrac`（`main.ts:4797`）                         | `scrollTop + 1`                        | 小数行（**逻辑行内**比例） |
| 源码写 | `editorLineTopPx`（`main.ts:4836`）                            | **无**（`lineBlockAt(line.from).top`） | 行首像素                   |
| 预览读 | `topVisibleLine` / `topBlockStartLine`（`preview.ts:507/541`） | `scrollTop + 8`                        | 小数行（**块内行**比例）   |
| 预览写 | `applySyncToLine`（`preview.ts:459`）                          | `块顶 - 8`                             | 块顶像素                   |

由此产生三个后果：

1. **读锚差 7px**（源码 `+1`、预览 `+8`）⇒ 同一个"看着中间"的位置，两侧算出的 `v` 差 7px；
   块高 40px 时就是 **0.18 行 ≈ 用户说的「差半行」**。
2. **源码读写不互逆**：读是「行内任意比例」，写是「行首像素」。中间一去一回吃掉整个行数差。
3. **三条路径三种口径**：跟随走小数（`topVisibleLineFrac`）、收口截整数块首（`topBlockStartLine`）、
   交接走 `topBlockStartLine + editorLineTopPx`。于是 B247 守卫（`px===null && 源码态 ⇒ return false`）、
   B248 三层兜底、B249 的"预览支改整数"全是**在容错层补这三处不一致**。

> 📌 结论：问题不在换算的数学，在**缺一个唯一规范值 + 唯一读写入口**。
> 统一公式能拿掉的不止漂移，还有这三轮修修补补的容错代码。

## 2. 目标

定义一套**源码行号（可带小数）⇄ 预览位置（块 + 块内比例）**的严格互逆公式，使
「跟随 / 切标签收口 / 切模式交接」三条路径都能由**同一个规范值**推导出落点 ——
每轮从上一个规范值**重新算**，而不是从上一轮**像素累积**，因此不漂。

## 3. 方案核心：规范游标 `v`（实数行号）

### 3.1 数据结构（纯整数，不碰几何）

预览渲染后由 `pipeline` 的块表生成一张**行↔块映射表**（一次构建、渲染变化只重建）：

```ts
// 半开区间 [start, nextStart)，覆盖 [1, docLines] 且无空洞（B244 伪块、空行缝隙一并归一）
interface RowMap {
  starts: number[];
  /* starts[k] = startLine of block k，升序，starts[0] === 1 */ spans: number[]; /* spans[k] = starts[k+1] - starts[k]，≥1 */
}
```

### 3.2 公式（`src/sync/cursor.ts`，纯函数、零 DOM）

```
位置 P = (v)                       // v ∈ [1, docLines]，实数行号
  v → 块内位置:  k = max{ j | starts[j] <= v }        // 二分
                 t = clamp((v - starts[k]) / spans[k], 0, 1)
  (k, t) → v:    v  = starts[k] + t · spans[k]        // 与上式严格互逆
```

源码 ⇄ `v`：

```
源码小数行 s (= line + ratio) ⇄ v:  直接相等（源码本来按行排版，无转换误差）
源码同侧跟随（源码→源码）:           v 直通，不跨块（ratio 是逻辑行内比例，只服务同侧连续）
```

预览 ⇄ `v`（几何层，只此一步）：

```
contentTop(px) = px + ANCHOR                            // scrollTop → 内容坐标系
pxOfContent(c) = c - ANCHOR                             // 内容坐标系 → scrollTop

previewTop(v)  = previewTopOfBlock(k) + t · (previewTopOfBlock(k+1) - previewTopOfBlock(k)) - ANCHOR
vOfPreviewTop(px) = starts[k] + t · spans[k]            // 与上式严格互逆（同一个 ANCHOR）
```

### 3.2.1 偏移常量 `ANCHOR` 的定案：**取 0（去掉偏移）**

- **本质**：`ANCHOR` 只是 `scrollTop` 与「内容坐标系」之间的**常数平移**（记账口径）。
  读 `+A`、写 `−A`，只要 A 是同一个数，**A 取任何值结果完全等价**（差量在往返中抵消）。
- **现状四值才是病**：`+1`（源码读）/ `+8`（预览读）/ `−8`（预览写）/ 无（源码写）——
  不是四个不同需求，是**同一个记账口径被抄成四个值** ⇒ 每换一次手吃一次差。
  统一成**一个常量**就消掉漂移；既然要统一，取 **0** 更干净：少一个魔法数，
  也不必解释"为什么是 8"。
- **考古**：`8` 自 `e1ecc90`（B23 大纲跳转定位精度）起存在；`.md-preview` 的 CSS 里
  **没有任何 8px 的几何依据**（`padding: 16px 24px 48px`、无 border）⇒ 早期手调魔法数，
  无几何必需。
- **取 0 的连带（已核）**：
  1. `indexOfBlockAtOffset` 的 `EPS = 0.5`（B245 亚像素容差）：比较是 `topAt(mid) <= offset + EPS`，
     offset 整体减 8 ⇒ 比较双方同步平移 ⇒ **语义不变、仍有效**。
  2. `Math.max(0, top - 8)` ⇒ `Math.max(0, top)`：顶部夹取等价。
  3. ⚠️ **桩几何要改**：`AP = topOfBlock(12) - 8` 这类测试常量去掉 `−8`
     （写锚从「块顶 − 8」变「块顶 − 0」）。用例本身仍有效（几何自动跟上）。
  4. `topVisibleLineFrac` 的 `scrollTop + 1` 去偏移：ratio 分母（行高）不变、分子少 1px
     ⇒ ratio 略变；硬编码期望值的断言要重算。
  5. 视觉影响：块顶从「容器内偏下 8px」变「正好贴顶」，8px 级小变化。
- §6 验证清单里的「约 8 条契约锚点换锚」同样适用（`+1` / `+8` / `−8` 字面）。

### 3.3 三条路径统一后

```
读:   readPos(container)  →  (k, t)  →   v = vOf(k, t)        // 唯一读函数
写:   (k, t) → v → writePos(container, v)                     // 唯一写函数
```

| 路径                             | 现在                                           | 统一后                                   |
| -------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| 跟随（`pushSyncToSiblings`）     | 源小数 → 兄弟各自取整（上/下取整各错一档）     | 源 `v` → 目标 `v`，一次写完              |
| 收口（`alignShownToSyncSource`） | 源 `topBlockStartLine()` 整数 + B247 守卫      | 源 `v`（完整）→ 目标 `v`，**不再截整数** |
| 交接（`toggleViewMode` handoff） | `topBlockStartLine + editorLineTopPx` 手工换算 | 同收口，同一函数                         |

⇒ 可以退场的容错：B247 守卫（`return false` 那支）、B249 的"预览支特殊改整数"、
`applySyncToSibling` 里预览兄弟的 `Math.floor(line)`（B242 注释明令不许带小数）。
B248 三层兜底**保留但简化**：它解决的是「离屏兄弟拿不到容器」，与坐标口径无关。

## 4. 可行性结论

**可行**，但要说清三件事：

1. **"精确"= 编号精确，不是像素精确。** 源码行高与预览块高排版不同（一行源码 ↔ 一个渲染块），
   同一个 `v` 在两侧**视觉位置本来就不一样**——这是排版事实，改不掉。
   方案能保证的是：**结构编号全局唯一、往返恒等、无累积漂移**。
2. **浮点往返必须量化**，否则 `v` 每轮带 1e-16 误差、切 100 次浮出来：
   统一 `quantize(v) = Math.round(v * 1e4) / 1e4`（1e-4 行 ≈ 0.002px，远小于 1px）。
3. **块表必须无空洞**（B244 伪块、空行缝隙）⇒ 用半开区间 `[starts[k], starts[k+1])`，
   `v` 落在缝隙时 clamp 到前一块尾部，保证全域有归属。

## 5. 落地分期（建议）

| 期             | 内容                                                                                                                                                                              | 风险                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **P1**         | 新增 `src/sync/cursor.ts`：`RowMap` + `blockOfV` / `vOfBlock` + `quantize`，**只新增不动行为**；配纯函数往返测试（1000 次随机 `v` 恒等）、块表覆盖性测试（含空行/缝隙/跨段/折行） | 极低                                          |
| **P2**         | 把跟随 / 收口 / 交接三条路径改调 `cursor`，统一 `ANCHOR`，删 B247 守卫与 `Math.floor(line)`                                                                                       | 中（动 5 个同步测试 + 约 8 条契约锚点）       |
| **P3**（可选） | 落盘槽 `t.scrollTop` 从「双语义 px」改成「统一 `v`」，拆掉 B240 二轮那个 `px = srcPreview ? null : …` 特判                                                                        | 高（动会话落盘 + 跨窗口 `EVT_SYNC_POS` 协议） |

建议先跑 **P1 + P2 骨架验证**：先看往返恒等 + 现有 1282 用例的回归面，再决定要不要进 P3。

## 6. 验证清单

- **纯函数**：随机 `v` 往返 1000 次 `quantize` 后恒等；`v` 超出 `[1, lines]` 时 clamp 不越界。
- **块表**：含空行 / 缝隙 / 跨 3 行段落 / 折行 / 图片的 MD，`RowMap` 覆盖 `[1, lines]` 无空洞。
- **行为**：切标签 N 圈落点恒等（四标签用例扩圈）、切模式往返恒等、跟随 100 帧不漂。
- **契约**：`tests/static.ts` 里盯 `+1` / `+8` / `Math.floor(line)` / `topBlockStartLine` 的约 8 条要同步换锚（锚点跟实现进化，不是改松判据）。

## 7. 回归面

`tests/sync-cross-roundtrip` · `sync-four-tabs` · `sync-scroll-mode` · `sync-switch-align` · `preview-sync`（5 个）+ `tests/static.ts` 契约；
产品侧 `src/main.ts`（`applySyncToSibling` / `syncSourceSnapshot` / `alignShownToSyncSource` / `pushSyncToSiblings` / `toggleViewMode` / `topVisibleLineFrac` / `editorLineTopPx`）+ `src/markdown/preview.ts`（`topVisibleLine` / `topBlockStartLine` / `applySyncToLine` / `indexOfBlockAtOffset`）。
