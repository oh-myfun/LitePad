// Synchronization-scroll subsystem — logic cleared in step 1 of the sync-scroll refactor.
//
// The user reported persistent problems with sync-scrolling and decided to redesign it from
// scratch with a new approach. As step 1, ALL behavioral logic here has been removed: every
// exported function is now a no-op. They remain exported only so the existing call sites keep
// compiling until the new design lands; none of them affect scrolling, cursor, or position
// memory / restore.
//
// Scope of the teardown (per the explicit request):
//   · sync-follow (multi-pane / multi-doc scroll following, jump sync, cross-window broadcast)
//   · scroll-position memory / restore (the B288⑥ path is intentionally removed)
// The sync toggle UI (B152 link/unlink button) is intentionally kept visible but inert: flipping
// it updates `docSyncModes` (see core/app-state) and its own glyph only — no scroll effect, no
// cross-window broadcast, no position restore.

import { EditorView } from "@codemirror/view";
import type { Tab, Panel } from "./core/app-state";

/** Legacy re-entrancy guard for cursor-sync loops. No longer used (logic cleared). */
export const syncingCursorDocId: number | null = null;

/** Whether `tab` is the sync source for `panel`. Always false now (sync disabled). */
export function isSyncSource(_tab: Tab, _panel: Panel): boolean {
  return false;
}

/** Push a sibling instance to cursor `v`. No-op (sync logic cleared). */
export function applySyncToSibling(_other: Tab, _v: number | null, _atFloor = false): void {}

/** One-shot land of a freshly built preview at the source cursor. No-op. */
export function landPreviewAtSource(_other: Tab, _v: number | null): void {}

/** Re-land after a geometry change on the next frame. No-op. */
export function landOnFrameGeometry(_tab: Tab, _v: number | null): void {}

/** Snapshot the source cursor before it goes off-screen. No-op (returns null). */
export function syncSourceSnapshot(_src: Tab | undefined, _nextTabId: number): number | null {
  return null;
}

/** Align the shown instance to the sync source on tab switch. No-op (returns false). */
export function alignShownToSyncSource(
  _panel: Panel,
  _src: Tab | undefined,
  _snap: number | null,
  _atFloor = false,
): boolean {
  return false;
}

/** Broadcast / push the source position to sibling instances. No-op. */
export function pushSyncToSiblings(
  _src: Tab,
  _crossWindow = false,
  _opts: { v?: number | null; skipTabIds?: number[]; atFloor?: boolean } = {},
): void {}

/** Triggered jump (outline / goto-line / find-hit) sync entry. No-op (local nav handled by callers). */
export function syncJumpToLine(_src: Tab, _v: number | null): void {}

/** Visible top line as a fractional real line number. No-op (returns 0). */
export function topVisibleLineFrac(_view: EditorView, _px?: number): number {
  return 0;
}

/** Convert a canonical cursor `v` to editor pixels. No-op (returns null). */
export function sourceTopOfV(_view: EditorView, _v: number): number | null {
  return null;
}

/** Canonical cursor `v` of a tab. No-op (returns null). */
export function syncSourceV(_t: Tab | undefined): number | null {
  return null;
}

/** Scrollable floor (maxScroll) of an element. No-op (returns 0). */
export function ownFloorPx(_el: HTMLElement): number {
  return 0;
}

/** Whether a tab is scrolled to its own floor. No-op (returns false). */
export function tabAtOwnFloor(_t: Tab | undefined): boolean {
  return false;
}

/** Capture scroll position before a view disappears. No-op. */
export function rememberViewScroll(_panel: Panel): void {}

/** Restore scroll position for an editor instance. No-op (position memory cleared). */
export function restoreViewScroll(_panel: Panel): void {}

/** Restore scroll position for a preview instance. No-op (position memory cleared). */
export function restorePreviewScroll(_panel: Panel): void {}

/** Whether preview geometry is not ready for cursor conversion. Always false now. */
export function previewGeometryUnready(_panel: Panel): boolean {
  return false;
}

/** Re-measure and reclaim scroll position after a view-mode switch. No-op. */
export function measureAndKeepScroll(_panel: Panel): void {}
