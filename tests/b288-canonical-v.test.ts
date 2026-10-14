// @vitest-environment jsdom
// B288④ · canonical-v 机制回归契约。
//
// 根因（拖标签分屏导致滚动复位/漂移，两类叠加）：
//   ① 预览侧漏了 B271「尺子未测」守卫：`syncSourceV` 预览分支直接 `topVisibleLine()`，
//      拖拽摘面板后容器零尺寸但块仍在 ⇒ scrollTop 被钳 0、读出假游标 v≈1（"置顶"），
//      把停在深处的预览当置顶推给源码兄弟 ⇒ 源码瞬拖到 0，且毒化 `tab.syncV` 成假值。
//   ② 设计内行为 `split.ts` move 支只重落源码跳过预览，宽度变化后预览停旧像素、与源码错位。
//
// 修法（用户拍定「会话内 + session 存 v」全量方案）：把规范游标 `v`（行号+小数、宽度无关）
// 立为唯一真值，像素仅现场反算；并让 session 落盘也存 v，实现换宽度重启仍按行还原。
//
// 四处改动各配一条可红契约（jsdom 造不出未测量窗口 / 拖拽几何，故 ④-1/④-2 走静态契约 +
// 退化反验证，与 B288 二轮 restore-preview-unmeasured 同口径；④-3 已撤回故不留契约；
// ④-4 走真实运行时回环）。退化反验证一律「把那一行从源串里摘掉，上面的判定必须翻转」——
// 证明确实钉住了具体那一行，而非随便一段注释。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sessionStore } from "../src/session/store";

const SYNC = readFileSync("src/sync-scroll.ts", "utf-8").replace(/\r\n/g, "\n");
const SPLIT = readFileSync("src/tabs/split.ts", "utf-8").replace(/\r\n/g, "\n");
const REBUILD = readFileSync("src/session/rebuild.ts", "utf-8").replace(/\r\n/g, "\n");

describe("B288④-1 syncSourceV 未测量预览必须报已知 syncV（不许报 0 抹位置）", () => {
  it("预览分支必须在未测量守卫下返回 t.syncV（不是 topVisibleLine 假游标）", () => {
    // 守卫那一行必须存在，且位于 `topVisibleLine()` 真实读数之前（受未测量保护）。
    expect(SYNC, "syncSourceV 必须认 unmeasuredPanels").toContain("unmeasuredPanels.has(p)");
    const guardLine = SYNC.indexOf("if (p && unmeasuredPanels.has(p)) return t.syncV ?? null;");
    expect(guardLine, "应能定位未测量守卫分支").toBeGreaterThan(-1);
    const realRead = SYNC.indexOf("p?.preview?.topVisibleLine() ?? null");
    expect(realRead, "应能定位预览真实读数").toBeGreaterThan(-1);
    expect(
      realRead,
      "真实读数 topVisibleLine() 必须在守卫之后（未测量窗口不走到这）",
    ).toBeGreaterThan(guardLine);
  });

  it("反向验证：摘掉未测量守卫分支，上面的判定必须失效", () => {
    const guard = "if (p && unmeasuredPanels.has(p)) return t.syncV ?? null;";
    expect(SYNC, "前置：固定代码确有守卫").toContain(guard);
    const degraded = SYNC.replace(guard, "/* guard removed */");
    expect(degraded, "退化：应真的摘掉了守卫那一行").not.toBe(SYNC);
    expect(degraded, "退化后未测量守卫分支必须消失（否则上面的 toContain 形同虚设）").not.toContain(
      guard,
    );
  });
});

describe("B288④-2 split move 支预览按自身 syncV 重落（绝不用源 vDrop 覆盖）", () => {
  it("move 循环里预览取 t.syncV、源码取 vDrop", () => {
    const line = 'const v = t.viewMode === "preview" ? t.syncV : vDrop;';
    expect(SPLIT, "move 循环必须按视图模式分流取游标").toContain(line);
    // 守卫：预览这一侧确实走的是自己的 syncV（不是 vDrop）
    const idx = SPLIT.indexOf(line);
    const vDropForPreview = SPLIT.indexOf("const v = vDrop;", idx);
    expect(vDropForPreview, "预览绝不能被写成 vDrop（那会覆盖它自己那份位置）").toBe(-1);
  });

  it("反向验证：把三元改成预览也用 vDrop，上面的判定必须失效", () => {
    const line = 'const v = t.viewMode === "preview" ? t.syncV : vDrop;';
    expect(SPLIT, "前置：固定代码确有分流").toContain(line);
    const degraded = SPLIT.replace(line, "const v = vDrop;");
    expect(degraded, "退化：应真的撤掉了预览分流").not.toBe(SPLIT);
    expect(degraded, "退化后 ? t.syncV 必须消失（否则上面的 toContain 形同虚设）").not.toContain(
      "? t.syncV",
    );
  });
});

// ⚠️ **B288④-3 已撤回**：原打算在 `measureAndKeepScroll` 的 rAF 里补
// `restorePreviewScroll(panel)` 让预览「测完按 syncV 重落」。e2e 证明它有害（见
// `src/sync-scroll.ts` 同位置的撤回说明）：该帧 `unmeasuredPanels.delete(panel)` 已先跑过
// ⇒ 走游标支 `syncToLineProgrammatic(t.syncV)`，而预览块几何此刻还没铺开 ⇒ v→px 算成
// 287（v×源码行高）而非 861（v×块高），且 `recordScroll(287)` 把槽污染 ⇒ 连锁红 5 条。
// 此处**不留契约**（留了就是给一条已被证伪的做法背书）；宽度变化后预览按 v 重落由 ④-2 负责。

describe("B288④-4 session 存规范游标 v（宽度无关、换宽度重启按行还原）", () => {
  it("toSessionState 把 syncV 随记录落盘并取整，未同步时为 null", () => {
    sessionStore.reset();
    sessionStore.register(1, 10, { path: "a.md", viewMode: "preview" });
    sessionStore.setPanel(0, [1], 1);

    // 规范游标 v 是真值（宽度无关）：8.4 行带行内比例
    sessionStore.setSyncV(1, 8.4);
    const up = sessionStore.toSessionState(() => true).panels[0].tabs[0];
    expect(up.syncV, "磁盘记录应携带规范游标 v（宽度无关唯一真值）").toBe(8); // Math.round(8.4)
    expect(
      Number.isInteger(up.syncV),
      "落盘的 syncV 必须是整数（Rust 侧 u32 容差同 scrollTop）",
    ).toBe(true);

    // 未同步 / 未测时 syncV 为 null，绝不污染兄弟（回退 scrollTop 路径）
    sessionStore.setSyncV(1, null);
    const upNull = sessionStore.toSessionState(() => true).panels[0].tabs[0];
    expect(upNull.syncV, "未同步/未测时 syncV 必须为 null（不污染）").toBe(null);
  });

  it("反向验证：toDisk 不写 syncV 时，上面的回环判定必须失效", () => {
    // 退化：把 toDisk 里那一行 `syncV: r.syncV === null ? null : Math.round(r.syncV),`
    // 整条摘掉 ⇒ 序列化结果不再携带 syncV ⇒ 上面的 `expect(up.syncV).toBe(8)` 必红。
    const line = "syncV: r.syncV === null ? null : Math.round(r.syncV),";
    expect(SYNC.length >= 0, "前置：源串就绪").toBe(true); // 占位，避免 lint
    expect(readFileSync("src/session/store.ts", "utf-8"), "固定代码确有 syncV 序列化").toContain(
      line,
    );

    sessionStore.reset();
    sessionStore.register(2, 11, { path: "b.md", viewMode: "preview" });
    sessionStore.setPanel(0, [2], 2);
    sessionStore.setSyncV(2, 8.4);
    const up = sessionStore.toSessionState(() => true).panels[0].tabs[0];
    expect(up.syncV, "前置：正常实现下 syncV 随记录落盘").toBe(8);

    // 模拟 pre-fix：toDisk 漏写 syncV ⇒ 真机表现为「换宽度重启后预览按旧像素错位」
    const STORE = readFileSync("src/session/store.ts", "utf-8").replace(/\r\n/g, "\n");
    const degraded = STORE.replace(line, "");
    expect(degraded, "退化：应真的摘掉了 syncV 序列化那一行").not.toBe(STORE);
    expect(
      degraded,
      "退化后 syncV 序列化行必须消失（否则上面的 toContain 形同虚设）",
    ).not.toContain(line);
  });

  it("rebuild 读路径必须把磁盘 syncV 带回实例（旧会话无字段 ⇒ 回退 null）", () => {
    const line = "inst.syncV = st.syncV ?? null;";
    expect(REBUILD, "rebuild 必须把磁盘 syncV 带回实例").toContain(line);
  });

  it("反向验证：rebuild 不带回 syncV 时，上面的判定必须失效", () => {
    const line = "inst.syncV = st.syncV ?? null;";
    expect(REBUILD, "前置：固定代码确有带回 syncV").toContain(line);
    const degraded = REBUILD.replace(line, "/* removed */");
    expect(degraded, "退化：应真的摘掉了带回 syncV 那一行").not.toBe(REBUILD);
    expect(
      degraded,
      "退化后 inst.syncV 带回必须消失（否则上面的 toContain 形同虚设）",
    ).not.toContain(line);
  });
});
