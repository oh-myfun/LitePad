/**
 * 分级日志（B144）。
 *
 * 之前只有一条薄薄的 `logEvent(event, detail?)`：级别只是**打印出来的一串字符**，
 * 一点过滤都没有，也不区分目标。于是开发期看不到细节、发布期又记不住上下文，
 * 定位只能靠「猜 + 加一行 println 重新打包」。
 *
 * 现在：
 *   · 五档（`error` / `warn` / `info` / `debug` / `trace`），发布版默认 info；
 *   · **过滤发生在发 IPC 之前** —— 被挡掉的那条既不格式化也不过网，级别调低几乎零成本；
 *   · 落盘由后端负责（写配置目录下的 `logs/litepad.log`，按大小滚动）；
 *   · 每条都带 **target**（`session` / `save` / `preview` …），时间线上能看出是谁干的。
 *
 * ⚠️ **两条硬约束**：
 *   1. 这里**不许 await**。`logEvent` 是 fire-and-forget —— 关窗回调里 await 任何 IPC
 *      都会死锁（B135：`prevent_close` + 同步等 promise 把主线程占死，保存/确认框三路全卡）。
 *      ⚠️ 将来要在关窗路径里加日志，也只准调这个「发了就算」的接口。
 *   2. 级别以**后端为准**。启动时 `syncLevel()` 拉一次；抓不回来就按默认 info，
 *      绝不能为了记日志反过来卡住启动。
 */

import { logEvent, logLevel as ipcLogLevel, setLogLevel as ipcSetLogLevel } from "../ipc/api";

/** 级别名（与后端 `Level::as_key` 同形）。 */
export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

/** 重要程度：数值越小越严重。**过滤就是比大小**。 */
const RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const DEFAULT: LogLevel = "info";

let current: LogLevel = DEFAULT;

/** 认不出的级别回落 info（错误路径上那几条最有价值，不能因为拼错就丢）。 */
export function normalizeLevel(v: unknown): LogLevel {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return s in RANK ? (s as LogLevel) : DEFAULT;
}

/** 切级别（只改内存过滤，后端那份另说 —— 见 `setLevelPersisted`）。 */
export function setLevel(l: LogLevel): void {
  current = l;
}

/** 当前前端用的级别。 */
export function level(): LogLevel {
  return current;
}

/** 这一级发不发。 */
export function shouldLog(l: LogLevel): boolean {
  return RANK[l] <= RANK[current];
}

/**
 * 记一条。
 *
 * `target` 是**模块名**而不是一句话（`session` / `save` / `preview` / `window` …），
 * 时间线上光看它就能分出是谁。内容用 `detail` 拼，一行装完就好。
 */
export function log(l: LogLevel, target: string, detail?: string): void {
  if (!shouldLog(l)) return;
  // DEV 下顺手打控制台：调试不用去开日志文件。
  // ⚠️ 这里只准「打」，没有 await —— 见文件头第 1 条硬约束。
  if (import.meta.env.DEV) {
    const text = `${target}${detail ? `: ${detail}` : ""}`;
    if (l === "error") console.error(`[${l}]`, text);
    else if (l === "warn") console.warn(`[${l}]`, text);
    else console.debug(`[${l}]`, text);
  }
  logEvent(target, detail ?? "", l);
}

/** 启动后与后端对齐级别：后端是真正的裁决者（它决定要不要落盘）。 */
export async function syncLevel(): Promise<void> {
  try {
    setLevel(normalizeLevel(await ipcLogLevel()));
  } catch {
    // 抓不到就按默认 info。日志是配角，不许反过来影响启动。
    setLevel(DEFAULT);
  }
}

/**
 * 运行时调级别并持久化（B144）。
 *
 * 持久化是为了「临时开 debug 复现」这种场景：不存的话一重启就回到默认，
 * 而能复现的窗口期往往就那一次。
 */
export async function setLevelPersisted(l: LogLevel): Promise<void> {
  try {
    await ipcSetLogLevel(l);
  } finally {
    // 后端写盘失败也别把内存里的过滤卡在旧级别：至少这一侧接着放行新的。
    setLevel(normalizeLevel(l));
  }
}

const at = (l: LogLevel) => (target: string, detail?: string) => log(l, target, detail);

/** 按级别取记日志的函数：`logger.error("session", "save failed: …")`。 */
export const logger = {
  error: at("error"),
  warn: at("warn"),
  info: at("info"),
  debug: at("debug"),
  trace: at("trace"),
};
