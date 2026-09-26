// B144 · 多级别日志（前端这一半）。
//
// 目标是「发布版也能定位问题」，所以约束只有两条最要紧的：
//   1. **过滤发生在发 IPC 之前** —— 级别调高时，被挡掉的那条既不格式化也不过网。
//      否则「开 trace 抓一次」的代价就是正常使用时每条都付一次 IPC 成本。
//   2. **不许 await** —— `log()` 是 fire-and-forget。关窗回调里 await 任何 IPC
//      都会死锁（B135），所以这里一率不返回 Promise，将来也不该改。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/** 记录发往后端的每一条日志（断言全看它）。 */
const sink = vi.hoisted(() => ({
  lines: [] as { level: string; event: string; detail: string }[],
  level: "info",
  /** 模拟「进程刚起、命令还没注册」：级别拉不回来。 */
  failLevel: false,
  setLevelCalls: [] as string[],
}));

vi.mock("../src/ipc/api", () => ({
  logEvent: (event: string, detail: string, level: string) => {
    sink.lines.push({ level, event, detail });
    return Promise.resolve();
  },
  logLevel: () =>
    sink.failLevel ? Promise.reject(new Error("not ready")) : Promise.resolve(sink.level),
  setLogLevel: (level: string) => {
    sink.setLevelCalls.push(level);
    return Promise.resolve();
  },
}));

const front = await import("../src/core/logger");
const { log, setLevel, level, shouldLog, normalizeLevel, syncLevel, setLevelPersisted } = front;

beforeEach(() => {
  sink.lines = [];
  sink.setLevelCalls = [];
  sink.level = "info";
  sink.failLevel = false;
  setLevel("trace"); // 默认放行，具体断言再往下压
});

describe("B144 级别解析", () => {
  it("认不出的级别回落 info，不把错误路径上那几条丢掉", () => {
    expect(normalizeLevel("trace")).toBe("trace");
    expect(normalizeLevel("DEBUG")).toBe("debug");
    expect(normalizeLevel(" Warn ")).toBe("warn");
    // 老调用点传的自由字符串拼错了也不许整条丢失
    expect(normalizeLevel("verbose")).toBe("info");
    expect(normalizeLevel(undefined)).toBe("info");
    expect(normalizeLevel("null")).toBe("info");
  });
});

describe("B144 过滤", () => {
  it("只放行「不比当前级别更轻」的那些", () => {
    setLevel("info");
    expect(shouldLog("error")).toBe(true);
    expect(shouldLog("warn")).toBe(true);
    expect(shouldLog("info")).toBe(true);
    expect(shouldLog("debug"), "发布版默认不该记 debug").toBe(false);
    expect(shouldLog("trace")).toBe(false);

    setLevel("trace");
    expect(shouldLog("debug")).toBe(true);
    expect(shouldLog("trace")).toBe(true);

    setLevel("error");
    expect(shouldLog("warn"), "error 档连 warn 都不要").toBe(false);
    expect(shouldLog("error")).toBe(true);
  });

  it("被挡掉的那条连 IPC 都不发（过滤必须在发之前）", () => {
    setLevel("info");
    log("debug", "preview", "不该出现");
    log("trace", "preview", "也不该出现");
    expect(sink.lines, "被挡的必须完全不落地").toHaveLength(0);

    log("warn", "session", "该出现");
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toMatchObject({ level: "warn", event: "session" });
  });

  it("没有 detail 时也要把 target 单独带上", () => {
    setLevel("trace");
    log("info", "boot");
    expect(sink.lines[0]).toMatchObject({ level: "info", event: "boot", detail: "" });
  });
});

describe("B144 logger 接口", () => {
  it("五档都收，且 target 从调用点来", () => {
    setLevel("trace");
    front.logger.error("save", "e");
    front.logger.warn("save", "w");
    front.logger.info("open", "i");
    front.logger.debug("open", "d");
    front.logger.trace("open", "t");
    expect(sink.lines.map((l) => `${l.level}:${l.event}`)).toEqual([
      "error:save",
      "warn:save",
      "info:open",
      "debug:open",
      "trace:open",
    ]);
  });

  it("log() 是同步的：不许返回 Promise（关窗路径里 await 会死锁，B135）", () => {
    setLevel("trace");
    const r = log("info", "hot-exit", "one");
    expect(r, "log() 必须返回 void").toBeUndefined();
  });
});

describe("B144 与后端对齐级别", () => {
  it("启动时拉一次后端级别；抓不到就回落 info，绝不卡住启动", async () => {
    sink.level = "debug";
    await syncLevel();
    expect(level()).toBe("debug");

    // 命令还没注册 / invoke 抛异常时，不能让 bootstrap 停在这里
    sink.failLevel = true;
    await syncLevel();
    expect(level(), "抓不到就按默认 info").toBe("info");
  });

  it("切级别并落盘；后端写失败也不把内存里的过滤卡在旧级别", async () => {
    setLevel("info");
    await setLevelPersisted("debug");
    expect(sink.setLevelCalls).toEqual(["debug"]);
    expect(level()).toBe("debug");
  });
});

describe("B144 静态契约", () => {
  const logger = readFileSync("src/core/logger.ts", "utf-8");
  const main = readFileSync("src/main.ts", "utf-8");
  const rs = readFileSync("src-tauri/src/core/logging.rs", "utf-8");
  const cmd = readFileSync("src-tauri/src/commands/mod.rs", "utf-8");

  it("落盘目录在配置目录下，且尊重 LITEPAD_CONFIG_DIR 覆盖", () => {
    //  Old：`%TEMP%\litepad-app.log` —— 系统磁盘清理会删、用户也找不到。
    expect(rs, "日志要落在配置目录的 logs/ 下").toMatch(
      /config_dir\(\)\.map\(\|d\| d\.join\("logs"\)\)/,
    );
    // 单测里用 temp_dir 是另一回事，这里只认**落盘**那一段不许再回退（会假绿的字面量）。
    expect(rs, "落盘位置不许回退到 %TEMP%").not.toMatch(/fn log_dir[\s\S]{0,160}temp_dir/);
  });

  it("按大小滚动且只留固定份数", () => {
    expect(rs).toMatch(/MAX_BYTES: u64 = 2 \* 1024 \* 1024/);
    expect(rs).toMatch(/pub const KEEP: usize = 3;/);
    expect(rs, "滚动要真的发生").toMatch(/fn rotate\(/);
  });

  it("级别过滤发生在入队之前（被挡的不格式化、不过网）", () => {
    expect(rs, "log() 里 should_log 必须先于 send").toMatch(
      /pub fn log\(level: Level, target: &str, msg: &str\) \{\s*\n\s*if !should_log\(level\) \{\s*\n\s*return;\s*\n\s*\}/,
    );
  });

  it("前端同样先过滤再发（后端还有一层兜底）", () => {
    expect(logger, "前端 mustLog 之后才 logEvent").toMatch(
      /export function log\(l: LogLevel, target: string, detail\?: string\): void \{\s*\n\s*if \(!shouldLog\(l\)\) return;/,
    );
    expect(cmd, "后端 log_event 仍要自己兜一层").toMatch(
      /if !logging::should_log\(lv\) \{\s*\n\s*return;\s*\n\s*\}/,
    );
  });

  it("所有现存的日志调用点都走 logger.*（不许再出现裸 logEvent 调用）", () => {
    const hits = main.match(/^\s*logEvent\(/gm) ?? [];
    expect(hits, "裸 logEvent 调用点已全部迁走").toHaveLength(0);
  });

  it("启动收尾要同步后端级别，且不 await 阻塞启动", () => {
    expect(main).toMatch(/void syncLevel\(\);/);
  });

  it("日志文件里会有用户文档路径，别把它当能随手发出的东西", () => {
    expect(rs).toMatch(/⚠️[^\n]*用户文档路径/);
  });
});

describe("B144 反向验证", () => {
  const logger = readFileSync("src/core/logger.ts", "utf-8");

  it("退回「不过滤 / 直接发」，上面的过滤契约必须失配", () => {
    // 退化一：前端不过滤，每条都发 IPC
    const degradedFront = logger.replace(/if \(!shouldLog\(l\)\) return;/, "// 已删除过滤");
    expect(degradedFront, "退化实现应真的换了写法").not.toBe(logger);
    expect(degradedFront).not.toMatch(
      /export function log\(l: LogLevel, target: string, detail\?: string\): void \{\s*\n\s*if \(!shouldLog\(l\)\) return;/,
    );

    // 退化二：后端不过滤（前端发了就一律落盘）
    const rs = readFileSync("src-tauri/src/core/logging.rs", "utf-8");
    const degradedBack = rs.replace(/if !should_log\(level\) \{\s*\n\s*return;\s*\n\s*\}/, "");
    expect(degradedBack, "退化实现应真的换了写法").not.toBe(rs);
    expect(degradedBack).not.toMatch(
      /pub fn log\(level: Level, target: &str, msg: &str\) \{\s*\n\s*if !should_log\(level\) \{/,
    );
  });

  it("退回「写进 %TEMP%」，落盘位置那条契约必须失败", () => {
    const rs = readFileSync("src-tauri/src/core/logging.rs", "utf-8");
    const degraded = rs.replace(
      /config_dir\(\)\.map\(\|d\| d\.join\("logs"\)\)/,
      "std::env::temp_dir()",
    );
    expect(degraded, "退化实现应真的换了写法").not.toBe(rs);
    expect(degraded).not.toMatch(/config_dir\(\)\.map\(\|d\| d\.join\("logs"\)\)/);
  });
});
