// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readJson, collectTextFiles } from "./static";

describe("仓库整洁：更名残留检查", () => {
  it("B34/B36 应用更名为 LitePad 后，全仓库不得有 LiteMD/litemd 残留", () => {
    // B34：应用名改为 LitePad（源码 + 配置 + Rust）。
    // B36：用户要求「梳理项目中所有文件」把 LiteMD 全部改成 LitePad——
    // 故断言从 11 个文件硬编码升级为**全仓库文本文件扫描**，
    // 覆盖文档（DESIGN/TASK/技术方案）、脚本注释、样式注释、测试数据、记忆文件。
    // 排除：构建产物（dist/target/gen）、依赖（node_modules）、本文件（规则定义处）。
    const offenders: string[] = [];
    for (const f of collectTextFiles(".")) {
      const rel = f.replace(/\\/g, "/");
      // 本文件自己必然出现旧名（规则定义处：正则 + 说明），不算残留。
      if (rel === "tests/repo-hygiene.test.ts") continue;
      // 记忆/归档类文件豁免：它们必须能写下「原名是 LiteMD」这一历史事实
      // （如 .workbuddy/memory/MEMORY.md 的更名说明、LiteMD-Space-Archive.md 的空间归档），
      // 属于对过去的记录，不是会泄漏到产品里的命名残留。
      if (rel.startsWith(".workbuddy/")) continue;
      if (/[Ll]ite[Mm][Dd]/.test(readFileSync(f, "utf-8"))) offenders.push(rel);
    }
    expect(offenders, "以下文件仍含 LiteMD/litemd 残留").toEqual([]);

    const conf = readJson("src-tauri/tauri.conf.json");
    expect(conf.productName, "productName 必须是 LitePad").toBe("LitePad");
    expect(conf.identifier, "identifier 必须是 com.litepad.app").toBe("com.litepad.app");
    const pkg = readJson("package.json");
    expect(pkg.name, "package.json name 必须是 litepad").toBe("litepad");
  }, 60000);

  it("版本号必须四处同步（发布流程靠它定 tag，漏改会打出对不上的安装包）", () => {
    // 用户反馈：GitHub 上没有触发编译发布、版本号也不随开发走。
    // 根因之一是版本号散落四处（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）：
    // scripts/release.sh 会自动同步，但手改/漏改会让 tag、安装包名、关于对话框三者不一致，
    // 而 Actions 只在 v* tag 上触发 —— 版本没抬就不会有发布。故把它固定成断言。
    const pkgVersion = readJson("package.json").version as string;
    const confVersion = readJson("src-tauri/tauri.conf.json").version as string;

    const cargoToml = readFileSync("src-tauri/Cargo.toml", "utf-8");
    const tomlVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    // Cargo.lock 里 litepad 自己的版本条目（[[package]] 块的 name/version 相邻）
    const cargoLock = readFileSync("src-tauri/Cargo.lock", "utf-8");
    const lockVersion = cargoLock.match(/name = "litepad"\nversion = "([^"]+)"/)?.[1];

    expect(pkgVersion, "版本号应为 x.y.z 形式").toMatch(/^\d+\.\d+\.\d+$/);
    expect(confVersion, "tauri.conf.json 版本必须与 package.json 一致").toBe(pkgVersion);
    expect(tomlVersion, "Cargo.toml 版本必须与 package.json 一致").toBe(pkgVersion);
    expect(lockVersion, "Cargo.lock 中 litepad 版本必须与 package.json 一致").toBe(pkgVersion);
  });
});
