// 标签模块对 markdown / session 的依赖注入绑定（解耦第八步收口）。
//
// tabs 作为消费者不再静态 import 这两个模块（否则与它们互相引用形成环），改为持有
// 可重绑定的本地绑定，由 main 在 bootstrap 期经 setter 注入真实实现。调用点保持原名
// （applyPanelMode / openPreviewToSide / toggleViewMode / discardBackupFor /
// scheduleSessionSave），函数体逻辑与既有静态契约测试完全不变；运行期由注入接管。

import { type Doc, type Panel, type Tab } from "../core/app-state";

let applyPanelMode: (panel: Panel) => void = () => {};
let openPreviewToSide: (panelId: number) => void = () => {};
let toggleViewMode: (target?: Tab) => void = () => {};
let discardBackupFor: (doc: Doc) => void = () => {};
let scheduleSessionSave: () => void = () => {};

export function setApplyPanelMode(fn: (panel: Panel) => void): void {
  applyPanelMode = fn;
}
export function setOpenPreviewToSide(fn: (panelId: number) => void): void {
  openPreviewToSide = fn;
}
export function setToggleViewMode(fn: (target?: Tab) => void): void {
  toggleViewMode = fn;
}
export function setDiscardBackupFor(fn: (doc: Doc) => void): void {
  discardBackupFor = fn;
}
export function setScheduleSessionSave(fn: () => void): void {
  scheduleSessionSave = fn;
}

// 下游模块（render / lifecycle / split）直接 import 这些 `let` 绑定；ESM 实时绑定，
// 运行期由上面的 setter 替换后调用点立即生效。
export { applyPanelMode, openPreviewToSide, toggleViewMode, discardBackupFor, scheduleSessionSave };
