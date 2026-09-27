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
import { sessionStore } from "../src/session/store";

describe("B143 视口位置要按整数落盘", () => {
  it("小数 scrollTop 落盘时四舍五入（小数会让 Rust 侧整份会话反序列化失败）", () => {
    sessionStore.reset();
    sessionStore.register(1, 1, { path: "a.md" });
    sessionStore.setPanel(0, [1], 1);

    sessionStore.setScroll(1, 842.6);
    const up = sessionStore.toSessionState(() => true).panels[0].tabs[0];
    expect(up.scrollTop, "842.6 必须落成 843").toBe(843);
    expect(Number.isInteger(up.scrollTop), "落盘的 scrollTop 必须是整数").toBe(true);

    sessionStore.setScroll(1, 842.4);
    const down = sessionStore.toSessionState(() => true).panels[0].tabs[0];
    expect(down.scrollTop, "842.4 必须落成 842").toBe(842);

    // 整数那条老路径不能因为取整改动走样
    sessionStore.setScroll(1, 842);
    expect(sessionStore.toSessionState(() => true).panels[0].tabs[0].scrollTop).toBe(842);

    // 从没显示过的标签仍是 null（「按光标定位」的信号不能被取整改写成 0）
    sessionStore.setScroll(1, null);
    expect(sessionStore.toSessionState(() => true).panels[0].tabs[0].scrollTop).toBeNull();
  });

  it("取整只发生在落盘出口，内存里仍保留原值（还原精度不受影响）", () => {
    sessionStore.reset();
    sessionStore.register(2, 2, { path: "b.md" });
    sessionStore.setScroll(2, 1234.4);
    // 出口取整 ≠ 存储取整：内存这份是还原时要用到的值，不该被提前抹掉小数。
    expect(sessionStore.get(2)?.scrollTop).toBe(1234.4);
    sessionStore.setPanel(0, [2], 2);
    expect(sessionStore.toSessionState(() => true).panels[0].tabs[0].scrollTop).toBe(1234);
  });
});

/** 会话写失败那几处 warn。正则不认死措辞，只在意「到底留没留一条」。 */
const SAVE_FAIL_LOG = /logger\.warn\("session", `(?:保存失败|会话写失败)/g;
const SAVE_FAIL_LOG_NO_G = /logger\.warn\("session", `(?:保存失败|会话写失败)/;

describe("B143 静态契约", () => {
  const main = readFileSync("src/main.ts", "utf-8");
  const store = readFileSync("src/session/store.ts", "utf-8");
  const rs = readFileSync("src-tauri/src/session/mod.rs", "utf-8");

  it("落盘出口要取整，且 Rust 侧要能接住小数", () => {
    expect(store, "出口必须取整").toMatch(
      /scrollTop: r\.scrollTop === null \? null : Math\.round\(r\.scrollTop\),/,
    );
    // 只改前端不够：已经写进盘里的小数还得能被读回来，否则下次启动会话照样读不出。
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
    const degradedStore = store.replace(
      "scrollTop: r.scrollTop === null ? null : Math.round(r.scrollTop),",
      "scrollTop: r.scrollTop,",
    );
    expect(degradedStore, "退化实现应真的换了写法").not.toBe(store);
    expect(degradedStore, "退化后不再取整（第一条的 toMatch 此时必须落空）").not.toMatch(
      /Math\.round\(r\.scrollTop\)/,
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
  const main = readFileSync("src/main.ts", "utf-8");

  it("容差要同时用在「钉上了」和「被文档夹住」两支上", () => {
    expect(main, "容差常量要有定义").toMatch(/const PIN_EPSILON_PX = 1;/);
    expect(main, "「钉上了」那支要用容差").toMatch(/Math\.abs\(diff\) <= PIN_EPSILON_PX/);
    // 只给第一支加容差不够：落点比目标小一点（缩放）同样落在第二支之外，
    // 于是「被夹住」被误判成「钉不进去」，照样重试到帧数用尽。
    expect(main, "「被文档夹住」那支也要留容差").toMatch(/diff < -PIN_EPSILON_PX/);
  });

  it("WARN 只在容差没兜住时出现，且带上差值（差个零点几 px 不该走到这行）", () => {
    expect(main, "失败日志要报差值").toMatch(/差 \$\{fmtPx\(diff\)\}px/);
    expect(main, "落点别把 493.3333435058594 整串塞进日志").toMatch(
      /scrollTop=\$\{fmtPx\(landed\)\}/,
    );
  });

  it("反向验证：退回精确相等的旧判据，上面几条必须全部落空", () => {
    const CURRENT =
      "      Math.abs(diff) <= PIN_EPSILON_PX || (px > 0 && landed > 0 && diff < -PIN_EPSILON_PX);";
    expect(main, "退化串要先自证原句还在").toContain(CURRENT);

    const degraded = main
      .replace(CURRENT, "      landed === px || (px > 0 && landed > 0 && landed < px);")
      .replace("    const diff = landed - px;\n", "");
    expect(degraded, "退化实现应真的换了写法").not.toBe(main);
    expect(degraded, "退化后不再有容差比较（第一条此时必须落空）").not.toMatch(
      /Math\.abs\(diff\) <= PIN_EPSILON_PX/,
    );
    expect(degraded, "退化后「被夹住」又变回精确比较（第二条此时必须落空）").not.toMatch(
      /diff < -PIN_EPSILON_PX/,
    );
  });
});
