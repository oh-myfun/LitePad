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
    // 三处：防抖落盘的 `persistSession` + 关窗两条路径。
    const hits = main.match(/logEvent\("session-save-failed", String\(e\), "warn"\);/g) ?? [];
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

    const degradedMain = main.replace(
      /logEvent\("session-save-failed", String\(e\), "warn"\);/g,
      "// 已删除",
    );
    expect(degradedMain, "退化实现应真的换了写法").not.toBe(main);
    expect(degradedMain, "退化后又变成静默吞掉（第二条此时必须落空）").not.toMatch(
      /session-save-failed/,
    );
  });
});
