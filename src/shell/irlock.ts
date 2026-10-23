// 即时渲染的三态悬浮锁键（B352-8）。
//
// 形状照 VS Code 的 Markdown Editor：一颗浮在编辑面右下角的键，**一个键承载两件事**
// （渲不渲染 + 能不能写），点一下走 `nextIrState` 的一条边：源码 → 渲染·锁 → 渲染·可写 → 源码。
// 默认锁着（用户拍板），只读文档那一态由状态机自己退化成 A ⇄ B。
//
// ⚠️ 本模块**不 import `src/markdown.ts`**：换态的落地在那边（`cycleIrState` → `applyIrState`），
//    而 markdown.ts 要反过来调这里的 `refreshIrLockKey` —— 直接 import 就是个环。
//    沿用本仓既有口子（`setInstanceOnUpdate` 同款）：由 main.ts 在启动时把换态函数登记进来。
import { tabs, type Panel, type Tab } from "../core/app-state";
import { docOf } from "../core/panels";
import { isMdTab } from "../doc-model";
import { perfProfileFor } from "../editor/perf";
import { irStateName, type IrStateName } from "../markdown/ir-state";
import { CODICONS } from "./codicons";
import { setTip } from "./tooltip";

/** 键的类名（样式与判据共用一个名字，别在 CSS 里另拼字符串）。 */
export const IR_LOCK_KEY_CLASS = "ir-lock-key";

/** 三态三形：字形反映**当前状态**（B166 口径 —— 状态不靠配色表达）。 */
const GLYPH: Record<IrStateName, string> = {
  source: CODICONS.code,
  "render-locked": CODICONS.lock,
  "render-editable": CODICONS.unlock,
};

/** 提示语写的是**点下去会怎样**（按钮档，带小尖尖那一族）。 */
const TIP: Record<IrStateName, string> = {
  source: "开启即时渲染",
  "render-locked": "解锁：可在渲染里直接改",
  "render-editable": "回到源码",
};

type CycleHandler = (tab: Tab) => void;

let onCycle: CycleHandler = () => {};

/** 登记换态入口（main.ts 启动时给 `cycleIrState`）。没登记时点击是空操作，不炸。 */
export function setIrCycleHandler(fn: CycleHandler): void {
  onCycle = fn;
}

/**
 * 造那颗键：只管构造，**不决定挂不挂、也不呈现状态**（那是 `refreshIrLockKey` 的活）。
 * 拆开是为了让「门槛不满足 ⇒ DOM 里没有这个节点」这一条只住在一个地方。
 */
export function createIrLockKey(panel: Panel): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = IR_LOCK_KEY_CLASS;
  btn.addEventListener("click", () => {
    const tab = tabs.get(panel.activeTabId);
    // 活动标签已经被关掉：这一发什么都不该做（不炸、也不把一个不存在的标签递给状态机）
    if (tab) onCycle(tab);
  });
  return btn;
}

/**
 * 呈现 + 在场判定（唯一出口）。
 *
 * 调用点两处，缺一就复刻 B228 那颗卡在旧字形的键：
 *   · `applyPanelMode`（视图模式落到 DOM 的唯一出口）；
 *   · `applyIrState`（换态落地）。
 *
 * 门槛不满足时**摘掉节点**而不是 hidden/disabled —— 大文档（>2 MB，`autoPreview` 关档）里
 * 灰着的一颗键会被用户当成可点，点了没反应就是 bug 现场。
 */
export function refreshIrLockKey(panel: Panel): void {
  const host = panel.bodyEl;
  if (!host) return;
  const tab = tabs.get(panel.activeTabId);
  const doc = tab ? docOf(tab) : undefined;
  const wants = !!tab && !!doc && isMdTab(tab) && perfProfileFor(doc.sizeClass).autoPreview;
  const existing = host.querySelector<HTMLElement>(`.${IR_LOCK_KEY_CLASS}`);
  if (!wants || !tab) {
    existing?.remove();
    return;
  }
  const btn = existing ?? createIrLockKey(panel);
  if (!existing) host.appendChild(btn);
  const name = irStateName({ liveRender: tab.liveRender, irLocked: tab.irLocked });
  btn.dataset.irState = name;
  // 只换字形、不塞文字（B348：删掉的「装饰」可能在撑布局）
  btn.innerHTML = GLYPH[name];
  setTip(btn, TIP[name]);
}
