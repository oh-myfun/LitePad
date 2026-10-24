// 编码菜单的两组纯函数叶子：BOM 目标判定 + 语言分组收口。
// 这些函数只依赖 `MenuItem` 类型，不碰任何模块级状态，故抽成独立模块，
// 方便单独单测、也避免 main.ts 继续膨胀（编码转换的「写盘出口」`convertDoc`
// 与「菜单模型」`encodingMenuModel` 在 prefs.ts，只在此消费本模块的叶子）。
import { type MenuItem } from "./shell/menu";

/** UTF-8 两档 —— 只有这两档之间才需要「添加 / 移除 BOM」这种就地操作。 */
export const ENC_UTF8 = "UTF-8";
export const ENC_UTF8_BOM = "UTF-8 with BOM";

/**
 * BOM 的目标编码。`null` = 当前编码不存在「就地加/去 BOM」这回事
 * （UTF-16 的带/不带 BOM 是两条独立条目，不走这里）。
 */
export function bomTarget(current: string, wantBom: boolean): string | null {
  if (current === ENC_UTF8) return wantBom ? ENC_UTF8_BOM : null;
  if (current === ENC_UTF8_BOM) return wantBom ? null : ENC_UTF8;
  return null;
}

/**
 * 把一组编码条目按语言收成**两级**（用户口径：归类用子菜单，别用分组小标题 ——
 *   B218 早先那版插在条目之间的小标题整份作废了，代价是 `MenuItem.heading` 字段
 *   和 `.menu-heading` 样式一起删了，别照着重做）：
 *   第一组的条目**内联平铺**（当前就是统一码那几条，一点即达，不必多点一下）；
 *   之后每个语言组收成一条带 chevron 的子菜单入口，区块之间用分隔线隔开。
 *
 * ⚠️ 「哪一组内联」只认后端下发的 `groups[0]`（第一条记录的分组），**不写死某个
 *    组名** —— 以后 Rust 调组顺序，前端不用跟着改。
 * ⚠️ 分组只认后端下发的 `group`：Rust 那份 `all()` 已经按组排好，这里只负责切块。
 *    千万别在前端另维护一张「编码 → 语言」的对照表：两张表迟早差一条，而差的那
 *    一条就是这个函数的全部意义所在。
 */
export function withLanguageGroups(items: MenuItem[], groups: string[]): MenuItem[] {
  const out: MenuItem[] = [];
  let bucket: MenuItem[] = [];
  let bucketName = "";
  // 收口一块：前面已经有内容 ⇒ 进子菜单区（补一条分隔线 + 一条组入口）
  const flushAsGroup = (name: string, entries: MenuItem[]) => {
    if (out.length > 0) out.push({ separator: true });
    out.push({ label: name, submenu: entries });
  };
  items.forEach((item, i) => {
    const group = groups[i] ?? "";
    if (group !== bucketName) {
      if (bucket.length > 0) {
        // 第一块直接铺开；之后的每一块才收成子菜单
        if (out.length > 0) flushAsGroup(bucketName, bucket);
        else out.push(...bucket);
      }
      bucket = [item];
      bucketName = group;
    } else {
      bucket.push(item);
    }
  });
  if (bucket.length > 0) {
    if (out.length > 0) flushAsGroup(bucketName, bucket);
    else out.push(...bucket);
  }
  return out;
}
