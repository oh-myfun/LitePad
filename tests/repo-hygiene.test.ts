import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname } from "node:path";
import { readJson } from "./static";

/** 只扫**已入库**的文本文件：未跟踪的草稿/构建产物不可能随提交带进产品。 */
const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".ico",
  ".exe",
  ".woff",
  ".woff2",
  ".tt",
  ".pdf",
  ".zip",
]);
function trackedTextFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .filter((p) => !BINARY_EXT.has(extname(p).toLowerCase()));
}

describe("仓库整洁：更名残留检查", () => {
  it("B34/B36 应用更名为 LitePad 后，全仓库不得有 LiteMD/litemd 残留", () => {
    // B34：应用名改为 LitePad（源码 + 配置 + Rust）。
    // B36：用户要求「梳理项目中所有文件」把 LiteMD 全部改成 LitePad——
    // 故断言从 11 个文件硬编码升级为**全仓库文本文件扫描**，
    // 覆盖文档（DESIGN/TASK/技术方案）、脚本注释、样式注释、测试数据、记忆文件。
    // 用 `git ls-files` 而不是递归读盘：排除规则由 git 保证（构建产物/依赖本就不入库），
    // 也避免每次跑测试都遍历 node_modules 之外的整棵树。
    const offenders: string[] = [];
    for (const f of trackedTextFiles()) {
      const rel = f.replace(/\\/g, "/");
      // 本文件自己必然出现旧名（规则定义处：正则 + 说明），不算残留。
      if (rel === "tests/repo-hygiene.test.ts") continue;
      // 记忆/归档类文件豁免：它们必须能写下「原名是 LiteMD」这一历史事实
      // （如 .agents/ 里的历史说明），属于对过去的记录，不是会泄漏到产品里的命名残留。
      if (rel.startsWith(".agents/")) continue;
      if (/[Ll]ite[Mm][Dd]/.test(readFileSync(f, "utf-8"))) offenders.push(rel);
    }
    expect(offenders, "以下文件仍含 LiteMD/litemd 残留").toEqual([]);

    const conf = readJson("src-tauri/tauri.conf.json");
    expect(conf.productName, "productName 必须是 LitePad").toBe("LitePad");
    expect(conf.identifier, "identifier 必须是 com.litepad.app").toBe("com.litepad.app");
    const pkg = readJson("package.json");
    expect(pkg.name, "package.json name 必须是 litepad").toBe("litepad");
  }, 60000);
});
