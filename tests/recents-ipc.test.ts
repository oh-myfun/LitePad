// @vitest-environment node
// B305 Task 3 · 前端 IPC 薄包装。
//
// 为什么值得单独钉：命令名与参数键是**跨语言的两端字符串**，写错任何一侧都不会有编译错误，
// 表现是「名单永远不动」。运行时也测不出来（jsdom 里没有 Rust）。所以这里断言的正是
// 「发出去的那串字」，再加一条跨语言的事件名对照。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const invokeSpy = vi.hoisted(() =>
  vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(() =>
    Promise.resolve([]),
  ),
);

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeSpy(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: () => Promise.resolve(),
  listen: () => Promise.resolve({ unlisten: () => {} }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

import {
  listRecents,
  noteOpenedPath,
  forgetRecent,
  clearRecents,
  getRecentLimit,
  setRecentLimit,
} from "../src/ipc/api";
import { EVT_RECENTS_CHANGED } from "../src/core/events";

describe("B305 前端 IPC 薄包装", () => {
  beforeEach(() => {
    invokeSpy.mockClear();
    invokeSpy.mockResolvedValue([]);
  });

  it("六个命令名与参数键逐个对齐 Rust 侧", async () => {
    await listRecents();
    expect(invokeSpy.mock.calls[0]?.[0], "Tauri 命令名写错只会静默「命令不存在」").toBe(
      "list_recents",
    );

    await noteOpenedPath("a.md");
    expect(
      invokeSpy.mock.calls[1],
      "参数是**一份**路径 + 一类，不是集合（记的是打开动作）",
    ).toEqual(["note_opened", { path: "a.md", kind: "file" }]);
    // B332：不写第二颗 = 文件；写 folder 就原样带过去（Rust 按它分桶算上限）
    await noteOpenedPath("D:\\工作\\报价", "folder");
    expect(invokeSpy.mock.calls[2]).toEqual([
      "note_opened",
      { path: "D:\\工作\\报价", kind: "folder" },
    ]);

    await forgetRecent("a.md");
    expect(invokeSpy.mock.calls[3]).toEqual(["forget_recent", { path: "a.md" }]);

    await clearRecents();
    expect(invokeSpy.mock.calls[4]?.[0]).toBe("clear_recents");

    await getRecentLimit();
    expect(invokeSpy.mock.calls[5]?.[0]).toBe("get_recent_limit");

    await setRecentLimit(50);
    expect(invokeSpy.mock.calls[6]).toEqual(["set_recent_limit", { limit: 50 }]);
  });

  it("改过名单的三条命令把 Rust 回包的完整名单原样交给调用方（视图不必再 list 一次）", async () => {
    const entries = [{ path: "a.md", name: "a.md", openedAt: 17 }];
    invokeSpy.mockResolvedValue(entries);
    await expect(noteOpenedPath("a.md")).resolves.toEqual(entries);
    await expect(forgetRecent("a.md")).resolves.toEqual(entries);
    await expect(clearRecents()).resolves.toEqual(entries);
  });

  it("setRecentLimit 回的是生效后的上限（Rust 才是权威，别的窗口可能刚写过）", async () => {
    invokeSpy.mockResolvedValue(10);
    await expect(setRecentLimit(999)).resolves.toBe(10);
  });

  it("广播事件名两侧同一串字（跨语言拼错不报错，只表现为「名单不刷新」）", () => {
    expect(EVT_RECENTS_CHANGED).toBe("recents-changed");
    const rust = readFileSync("src-tauri/src/commands/recents.rs", "utf-8");
    expect(rust, "Rust 侧没广播这个名字").toContain(`"${EVT_RECENTS_CHANGED}"`);
  });

  it("线上字段是 openedAt（camelCase），Rust 侧靠 rename_all 落同一串", () => {
    const api = readFileSync("src/ipc/api.ts", "utf-8");
    expect(api).toContain("openedAt");
    const rust = readFileSync("src-tauri/src/session/recent.rs", "utf-8");
    expect(rust).toContain('rename_all = "camelCase"');
    // B308 之前那份盘写的还是 closedAt。字段改名不迁移，老名单在升级后直接读不回来 ——
    // 用户视角是「升级把最近打开清空了」。alias 是这条盘上历史的唯一续命线。
    expect(rust).toContain('alias = "closedAt"');
  });
});
