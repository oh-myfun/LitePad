// B143 · 「文件滚动到底之后，再往回滚动好像就没法刷新记录位置了」。
//
// 症状看着像「位置记录不刷新」，真因却在**落盘那一跳**：
//   · 浏览器里 `scrollTop` 是 **double**。系统缩放不是 100% 时，「滚到底」正好等于
//     `scrollHeight - clientHeight`，几乎必然带小数（125% / 150% 缩放是重灾区）。
//   · 这个小数原样写进会话载荷 → Rust 侧 `scroll_top` 是 `Option<u32>` →
//     **整份** `SessionState` 反序列化失败 → `save_session` 报错。
//   · `persistSession()` 的 catch 把异常**静默吞掉** → 界面上一点迹象都没有，
//     只表现为「位置再也刷不进会话」。而往回滚的滚动增量是整数、基数却还带着
//     那个小数 ⇒ 连续失败，于是「往回滚也不好使」。
//
// 修法是两道：出口**取整**（这里盯）+ Rust 侧**宽容反序列化**（`session/mod.rs`
// 的 `de_scroll_top`，由 Rust 单测盯）。外加把静默吞掉的失败留一条日志。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sessionAll } from "./static";
import { sessionStore } from "../src/session/store";

// ⚠️ B288⑤-1c：**像素已不再落盘**（`scrollTop` 退役 —— 几何相关，换宽度就是另一行）。
//   位置只以规范游标 `syncV` 存档，所以「取整纪律」换到 `syncV` 上，且**结论反了**：
//   v 是唯一真值 ⇒ **不许取整**（取整丢行内比例 = 最多半行的真实偏差）。
//   B143 那条「double 撞裸 u32 ⇒ 整份会话反序列化失败」也随之消失：Rust 侧 `sync_v`
//   是 `Option<f64>`。旧盘上的 `scroll_top` 仍由 `de_scroll_top` 宽容读取（只读取，不参与还原）。
describe("B143 → ⑤-1c 位置落盘：syncV 原样落盘，不得丢行内比例", () => {
  it("小数 syncV 原样落盘（取整会丢行内比例，v 是唯一真值 ⇒ 就是真实偏差）", () => {
    sessionStore.reset();
    sessionStore.register(1, 1, { path: "a.md" });
    sessionStore.setPanel(0, [1], 1);

    sessionStore.setSyncV(1, 20.571);
    const up = sessionStore.toSessionState(() => true).panels[0].tabs[0];
    expect(up.syncV, "20.571 必须原样落盘（取整 21 就差 0.43 行）").toBe(20.571);
    expect(up.syncV, "不许被取整").not.toBe(21);

    // 整数行号（正好停在行首）不受影响
    sessionStore.setSyncV(1, 842);
    expect(sessionStore.toSessionState(() => true).panels[0].tabs[0].syncV).toBe(842);

    // 没同步过 / 从没显示过的标签仍是 null（「按光标定位」的信号不能被写成 0）
    sessionStore.setSyncV(1, null);
    expect(sessionStore.toSessionState(() => true).panels[0].tabs[0].syncV).toBeNull();
  });
});

/** 会话写失败那几处 warn。正则不认死措辞，只在意「到底留没留一条」。 */
const SAVE_FAIL_LOG = /logger\.warn\("session", `(?:保存失败|会话写失败)/g;
const SAVE_FAIL_LOG_NO_G = /logger\.warn\("session", `(?:保存失败|会话写失败)/;

describe("B143 静态契约", () => {
  const main =
    readFileSync("src/main.ts", "utf-8") +
    "\n" +
    sessionAll() +
    "\n" +
    readFileSync("src/core/viewport.ts", "utf-8");
  const store = readFileSync("src/session/store.ts", "utf-8");
  const rs = readFileSync("src-tauri/src/session/mod.rs", "utf-8");

  it("像素出口已删除；syncV 不许取整；旧盘小数仍要能读回", () => {
    // ⑤-1c：像素已退役 ⇒ 不许再有 `Math.round(r.scrollTop)` 这种出口。
    expect(store, "像素出口必须已删除").not.toMatch(/Math\.round\(r\.scrollTop\)/);
    // v 是唯一真值 ⇒ 落盘不许取整
    expect(store, "syncV 出口不许取整").toMatch(/syncV: r\.syncV,/);
    expect(store, "syncV 出口不许出现 Math.round").not.toMatch(/Math\.round\(r\.syncV\)/);
    // **旧盘**里已经写进去的小数 `scroll_top` 还得能被读回来（不过它已不参与还原）。
    expect(rs, "Rust 侧要挂宽容反序列化").toMatch(/deserialize_with = "de_scroll_top"/);
  });

  it("会话写失败不许静默吞掉（静默 = 这类问题永远查不到）", () => {
    // 三处：防抖落盘的 `persistSession` + 关窗的两条路径。
    // ⚠️ B144 起统一走 `logger.warn`（target = 模块名），B147 又把文案改成了中文
    // （「保存失败：…」「会话写失败（热退出收尾）：…」）—— 但「不许静默」这条
    // 契约不变，所以盯的是**这几处 warn 本身**，不去认具体措辞。
    const hits = main.match(SAVE_FAIL_LOG) ?? [];
    expect(hits.length, "三处 catch 都要留日志").toBe(3);
  });

  it("反向验证：退回「不取整 / 静默吞掉」，上面两条必须失败", () => {
    // 退化一：把 syncV 出口改回取整（丢行内比例）⇒ 上面「不许取整」两条必须落空。
    const degradedStore = store.replace(
      "syncV: r.syncV,",
      "syncV: r.syncV === null ? null : Math.round(r.syncV),",
    );
    expect(degradedStore, "退化实现应真的换了写法").not.toBe(store);
    expect(degradedStore, "退化后又开始取整（「不许取整」那条此时必须落空）").toMatch(
      /Math\.round\(r\.syncV\)/,
    );

    const degradedRs = rs.replace(/deserialize_with = "de_scroll_top"/, "");
    expect(degradedRs, "退化实现应真的换了写法").not.toBe(rs);
    // ⚠️ 只盯「挂到字段上」这一处：`de_scroll_top` 在函数定义与注释里还有两处，
    // 拿函数名当判据的话退化完照样能匹配到 ⇒ 这条断言就成了永远为真的摆设。
    expect(degradedRs, "退化后 Rust 侧退回裸 u32").not.toMatch(
      /deserialize_with = "de_scroll_top"/,
    );

    const degradedMain = main.replace(SAVE_FAIL_LOG, "// 已删除");
    expect(degradedMain, "退化实现应真的换了写法").not.toBe(main);
    expect(degradedMain, "退化后又变成静默吞掉（第二条此时必须落空）").not.toMatch(
      SAVE_FAIL_LOG_NO_G,
    );
  });
});

/**
 * B151 · 用户质疑「日志里 `viewport pin 没立住` 这条警告不太合理，滚动位置应该不需要
 * 考虑小数」。他是对的：容差。**钉上去的目标值**与**读回来的落点**差零点几 px 是
 * 缩放（125% / 150%）下的正常结果，拿精确相等判「立住了没」，小数永远对不上 ⇒
 * 每次补钉都一路重试到 `PIN_MAX_FRAMES`，甩一条 WARN；满屏都是这条，真出问题时反而看不见。
 */
describe("B151 pin 的「立住」判定要留小数容差", () => {
  const main =
    readFileSync("src/main.ts", "utf-8") +
    "\n" +
    sessionAll() +
    "\n" +
    readFileSync("src/core/viewport.ts", "utf-8");

  it("容差要同时用在「钉上了」那支；「被文档夹住」那支由 B278 改判重试", () => {
    expect(main, "容差常量要有定义").toMatch(/const PIN_EPSILON_PX = 1;/);
    expect(main, "「钉上了」那支要用容差").toMatch(/Math\.abs\(diff\) <= PIN_EPSILON_PX/);
    // ⚠️ **B278（B151 旧第二支翻案）**：旧写法把「落点比目标小 1px 以上」当场判「立住」
    //   收工 —— 缩放小数场景它确实兜住了（差零点几 px 落在第一支容差里），但它同时把
    //   「`scrollHeight` 还没撑开」（底部留白尚未 apply / 内容未渲染）的**临时**向下裁切
    //   也当成了终局：补钉链当场结束，留白涨回后 322 永久卡在 276（末行退到视口底，
    //   用户报的「尾行跳到页面底部」）。⇒ 旧第二支必须**消失**，向下裁切一律重试到窗口末。
    expect(main, "旧的「被夹住即立住」判据必须已删除").not.toMatch(/diff < -PIN_EPSILON_PX/);
    // 新语义：重试到 PIN_MAX_FRAMES 用尽；窗口末只有「真·坏掉」（landed<=0，面板 0 宽 /
    // 内容始终没撑开）才告警，落在某个合法 maxScroll（landed>0）的短文档静默收工。
    expect(main, "窗口末收工要有帧数闸").toMatch(/if \(frame \+ 1 >= PIN_MAX_FRAMES\) \{/);
    expect(main, "告警只留给 landed<=0 的真·坏掉").toMatch(/if \(landed <= 0\) \{/);
  });

  it("WARN 只在容差没兜住时出现，且带上差值（差个零点几 px 不该走到这行）", () => {
    expect(main, "失败日志要报差值").toMatch(/差 \$\{fmtPx\(diff\)\}px/);
    expect(main, "落点别把 493.3333435058594 整串塞进日志").toMatch(
      /scrollTop=\$\{fmtPx\(landed\)\}/,
    );
  });

  it("反向验证：退回精确相等的旧判据，上面几条必须全部落空", () => {
    const CURRENT = "    const withinTol = Math.abs(diff) <= PIN_EPSILON_PX;";
    expect(main, "退化串要先自证原句还在").toContain(CURRENT);

    const degraded = main.replace(CURRENT, "    const withinTol = landed === px;");
    expect(degraded, "退化实现应真的换了写法").not.toBe(main);
    expect(degraded, "退化后不再有容差比较（第一条此时必须落空）").not.toMatch(
      /Math\.abs\(diff\) <= PIN_EPSILON_PX/,
    );

    // 反向验证第二条：把「告警只留给真·坏掉」的闸拆掉（退回无条件告警），
    // 「告警只留给 landed<=0」那条契约必须落空。
    const GATE = "      if (landed <= 0) {";
    expect(main, "退化串要先自证告警闸还在").toContain(GATE);
    const degradedGate = main.replace(GATE, "      if (true) {");
    expect(degradedGate, "退化实现应真的换了写法").not.toBe(main);
  });
});
