// B147：会话「改 → 存 → 恢复」这条链的**可观测性**契约。
//
// 起因是用户报的「加上足够多的 debug 日志，然后详细排查会话修改、保存、恢复的流程」。
// 逐行走下来，最刺眼的一处是：`restoreSession` 里有 6 处 `catch {}`，而「我的文件
// 怎么重启后没了」只有那么几种成因 —— 文件被删了、副本读不了、建不出空白文档，
// 全都是「消失了」，一个字都分不出来。这正是 B143 / B144 反复复现的那一类帮凶。
//
// 日志本身在 jsdom 里抓不住（logger 走 console，级别也压在 debug/trace），所以这里
// 盯的是**代码形态**：每个 catch 都得留下痕迹、每个关键时机都得有埋点。退化验证
// 照旧 —— 把日志删掉，这些用例必须变红。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { topLevelFnBody } from "./static";

/** 剥掉注释，免得注释里的字样（「跳过」「恢复」等）被当成代码。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 从 `catch` 那个词起做花括号配对，取出它的**块体**。 */
function catchBody(code: string, from: number): string {
  const open = code.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return "";
}

describe("B147 会话链路的可观测性", () => {
  const src = readFileSync("src/main.ts", "utf-8");
  const restore = topLevelFnBody(src, "async function restoreSession(): Promise<boolean> {");
  const snapshot = topLevelFnBody(
    src,
    "function snapshotSession(): Parameters<typeof saveSession>[0] {",
  );
  const persist = topLevelFnBody(src, "async function persistSession(): Promise<void> {");
  const schedule = topLevelFnBody(src, "function scheduleSessionSave(): void {");

  /**
   * 扫出一段代码里所有**没留痕迹**的 catch。
   *
   * 留痕的两张脸：直接记日志，或者把「跳过了谁、为什么」攒进 `dropped` 收尾一起打。
   * 只留注释的不算 —— 注释是给自己看的，日志才是给半年后排查的人看的。
   */
  function silentCatches(code: string): string[] {
    const bare = stripComments(code);
    const silent: string[] = [];
    const re = /\bcatch\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bare)) !== null) {
      const body = catchBody(bare, m.index);
      if (!/logger\./.test(body) && !/dropped\.push/.test(body)) {
        silent.push(
          bare
            .slice(m.index, m.index + 30)
            .replace(/\s+/g, " ")
            .trim(),
        );
      }
    }
    return silent;
  }

  it("恢复路径上每一处 catch 都要留下痕迹（静默吞掉是这类 bug 的帮凶）", () => {
    expect(
      silentCatches(restore),
      `恢复路径不许再有静默 catch：${silentCatches(restore).join(" | ")}`,
    ).toEqual([]);
  });

  it("关窗收尾（保存那一段）也不许静默 catch", () => {
    // 恢复路径之外，写条的另一头是关窗：`finishAndDestroy` 里「备份整体失败」
    // 「用户放弃退出后落会话失败」两个 catch 以前都是空的。
    const body = topLevelFnBody(
      src,
      "async function finishAndDestroy(dirty: Doc[]): Promise<void> {",
    );
    expect(
      silentCatches(body),
      `关窗收尾不许再有静默 catch：${silentCatches(body).join(" | ")}`,
    ).toEqual([]);
  });

  it("改 / 存 / 恢复三个时机都要有埋点（缺一环就断成一段没有上下文的日志）", () => {
    expect(schedule, "卫星窗口跳过落盘要看得见").toMatch(/卫星窗口不写会话/);
    expect(schedule, "800ms 防抖到点要留一条").toMatch(/800ms 到，开始写/);
    expect(snapshot, "快照要打出载荷摘要").toMatch(/logger\.debug\("session", `快照 ·/);
    expect(persist, "写出前先记一份，失败时才有可对的东西").toMatch(/保存 · 写出/);
    expect(restore, "读盘结果要留一条").toMatch(/读盘 · 面板=/);
    expect(restore, "恢复完成要给整体结论").toMatch(/恢复完成/);
    expect(restore, "一个都没恢复时要给出跳过原因").toMatch(/退回空白窗口/);
    // 摘要必须限长：一行几十 KB 会把 2MB 的日志冲掉（B144 的滚动上限）。
    expect(src, "摘要要限长").toMatch(/all\.slice\(0, 8\)/);
  });

  it("「标签没进会话」必须给出理由，而不只是布尔的 false", () => {
    // 「我的标签怎么重启后没了」只有一种答案：`sessionWorthy` 拦下了它。以前判定是
    // 纯布尔的、一个字不留，于是「没开热退出」「文档正脏着」「文件没了」三种情况
    // 在日志上长得一模一样。
    expect(src, "拒绝理由要单独成函数（判断与理由分开）").toMatch(
      /function sessionRejectReason\(t: Tab\): string \| null/,
    );
    expect(src, "sessionWorthy 要复用那个理由函数").toMatch(
      /function sessionWorthy\(t: Tab\): boolean \{\s*return sessionRejectReason\(t\) === null;/,
    );
    expect(stripComments(snapshot), "快照要把被拦下的标签与理由攒下来一起打").toMatch(
      /skipped\.push\(/,
    );
  });

  it("反向验证：把日志删掉，上面几条必须变红", () => {
    // ⚠️ 一律用**字面量 replace**（整段正则一改排版就失配，退化就变成「什么都没改」）。
    const silentCatch = src.replace(
      '        dropped.push(`${st.path || "未命名"}：恢复实例失败（${String(e)}）`);',
      "",
    );
    const degradedBody = topLevelFnBody(
      silentCatch,
      "async function restoreSession(): Promise<boolean> {",
    );
    expect(
      silentCatches(degradedBody),
      "把逐个标签恢复那处 catch 里的痕迹删掉，上面那条静默 catch 契约必须抓住",
    ).not.toEqual([]);

    const noScheduleTrace = src.replace(
      '    logger.trace("session", "排程落盘 · 卫星窗口不写会话");',
      "",
    );
    expect(
      topLevelFnBody(noScheduleTrace, "function scheduleSessionSave(): void {"),
      "删掉卫星窗口那条 trace 就该红",
    ).not.toMatch(/卫星窗口不写会话/);

    const noDump = src.replace(
      '  logger.debug("session", `快照 · ${sessionSummary(s, skipped)}`);',
      "",
    );
    expect(
      topLevelFnBody(noDump, "function snapshotSession(): Parameters<typeof saveSession>[0] {"),
      "撤掉快照那条埋点就该红",
    ).not.toMatch(/`快照 ·/);

    // 退化：`sessionWorthy` 退回 B147 之前的布尔判据 —— 挡不挡得住看得见，但
    // 「为什么挡的」又没了。这正是「标签凭空消失」查不出根因的那个版本。
    const noReason = src.replace(
      "function sessionWorthy(t: Tab): boolean {\n  return sessionRejectReason(t) === null;\n}",
      "function sessionWorthy(t: Tab): boolean {\n  const d = docs.get(t.docId);\n  return !!d && !!(d.path || d.backedUp);\n}",
    );
    expect(
      topLevelFnBody(noReason, "function sessionWorthy(t: Tab): boolean {"),
      "sessionWorthy 不再复用理由函数，就该红",
    ).not.toMatch(/sessionRejectReason\(t\) === null;/);
  });
});

describe("B147 后端：读写都要留一条", () => {
  const rs = readFileSync("src-tauri/src/session/mod.rs", "utf-8");

  it("落盘成功也要记：成功不留痕，界面上和「压根没写」一模一样", () => {
    // 这一条针对的是 `session_path()` 拿不到配置目录时直接 Err 出去、一行字不写 ——
    // 前端只看到「save 没抛错」，两边一比才发现时间线上这段是空的。
    expect(rs, "成功要记一条").toMatch(/会话已落盘/);
    expect(rs, "读成功也要记一条").toMatch(/会话读盘成功/);
  });
});
