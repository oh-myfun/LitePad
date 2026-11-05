// B461 · 差异标签的数据层（Task 1 只建三件纯事：输入描述、能不能开、块数变化的广播钩子）。
//
// ⚠️ 为什么 `leftText` 是**读取口**而不是字符串：A 档左栏正文就是 `doc.baseline`，而基线在
//    保存 / 以磁盘为准重载 / 换编码这些写点会被**整体换掉**（B458 的既定做法是给它一个读取口，
//    于是「存完盘差异自己清空」不需要任何人记得派发）。快照会把差异冻在打开那一刻，
//    用户按完 Ctrl+S 左右却还是旧的 —— 那就是仓库里第二条「什么算改过」的真相，禁止。
//
// ⚠️ 本模块只**类型依赖** `core/app-state`，不 import 任何渲染层：surface / face / 侧栏面板
//    都往这里长，反向 import 会成环（预审 R6：块数通知走 `setDiffBlocksListener` 这一格注册槽，
//    正是为了让 surface 不必认识面板模块）。
//
// 分工：`tier: "baseline"` 归 Task 5（与上次保存比较），`tier: "files"` 归 Task 6（任选两文件）；
// 块级计算与对齐归 Task 2；两侧底色与占位块归 Task 3。

import type { Doc } from "../core/app-state";

/** 数据来源档位：`baseline` = 文档 vs 它上次保存的正文；`files` = 任选两个文件。 */
export type DiffTier = "baseline" | "files";

/** 一栏的身份（`original` 恒为左、`modified` 恒为右；「交换左右」换的是输入，不换身份）。 */
export type DiffSide = "original" | "modified";

/** 一张差异标签的输入描述 —— 差异标签本身不含正文，只含「怎么取到两侧正文」。 */
export interface DiffSpec {
  tier: DiffTier;
  /** 右栏 = 这份文档的另一个实例（可编辑、脏归它） */
  docId: number;
  /** 左栏正文的读取口。A 档实时读 `doc.baseline`；B 档闭包持有一份只读对比缓冲 */
  leftText: () => string;
  leftName: string;
  rightName: string;
  /** B 档左栏的文件路径（「刷新」要重读盘）；A 档为 null */
  leftPath: string | null;
}

/**
 * A 档能不能开（设计稿 ⑩·3 + Review Focus 1）。
 *
 * `doc.baseline === null` 是「只知道它脏、不知道原样是什么」那一种（热退出副本还原、跨窗口认领），
 * 此时任何一行都无从判增删 —— 打开差异编辑器会把每一行刷成绿色糊用户一脸。
 * 菜单那一项因此要置灰，调用方也必须先问这一句再建标签。
 */
export function canOpenAgainstBaseline(doc: Doc | null): boolean {
  return !!doc && doc.baseline !== null;
}

/**
 * 块数变化的唯一通知槽（单槽，不是多播 —— 目前只有侧栏那一块视图消费它）。
 *
 * 谁注册：侧栏差异面板（Task 9）。谁广播：持有 surface 的那一侧（Task 2/4 的重算点）。
 * 传 `null` 是注销（抽屉收起 / 测试收尾），不是「关掉通知」。
 */
let blocksListener: ((spec: DiffSpec) => void) | null = null;

export function setDiffBlocksListener(fn: ((spec: DiffSpec) => void) | null): void {
  blocksListener = fn;
}

/** 广播一次「这张标签的块数/内容变了」。没人注册就是空转，不许抛。 */
export function notifyDiffBlocks(spec: DiffSpec): void {
  blocksListener?.(spec);
}
