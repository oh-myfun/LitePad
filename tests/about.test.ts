import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { ask } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { showAbout } from "../src/shell/about";

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));

const askMock = ask as unknown as ReturnType<typeof vi.fn>;
const getVersionMock = getVersion as unknown as ReturnType<typeof vi.fn>;

describe("关于页版本号（B107 修复回归）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    askMock.mockResolvedValue(true);
  });

  it("显示运行时真实版本（getVersion），不写死旧版本号", async () => {
    getVersionMock.mockResolvedValue("0.12.0");
    await showAbout();
    expect(askMock).toHaveBeenCalledTimes(1);
    const msg = askMock.mock.calls[0][0] as string;
    expect(msg).toContain("LitePad v0.12.0");
    expect(msg).not.toContain("v0.1.0");
  });

  it("getVersion 失败时降级为「未知」而非崩溃", async () => {
    getVersionMock.mockRejectedValue(new Error("no tauri"));
    await expect(showAbout()).resolves.toBeUndefined();
    const msg = askMock.mock.calls[0][0] as string;
    expect(msg).toContain("LitePad v未知");
  });

  it("逆向验证：关于页源码不得硬编码版本号字面（防再次写死）", () => {
    const about = readFileSync("src/shell/about.ts", "utf-8");
    const main = readFileSync("src/main.ts", "utf-8");
    for (const src of [about, main]) {
      expect(src, "不得再出现写死的 v0.1.0").not.toContain("v0.1.0");
      expect(src, "版本必须来自 getVersion，不得出现其它硬编码版本号").not.toMatch(
        /LitePad v\d+\.\d+/,
      );
    }
  });
});
