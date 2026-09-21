// @vitest-environment jsdom
// B48 / B52：**安装包产物**层面的守卫 —— 缺了这两样，应用要么起不来，要么显示成
// NSIS 的默认图标。两者都只能在打包产物 / 打包配置上断言，运行时测不到。
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { readJson } from "./static";

describe("B52 安装程序自身必须有 LitePad 图标（否则显示 NSIS 默认图标）", () => {
  // 用户报告「生成的二进制文件的图标还是旧的」。实测 exe 是对的
  // （7 档 PNG 与 icon.ico 逐字节一致），错的是**安装程序外壳**：
  // 双击 setup.exe 时任务栏/标题栏图标、「应用和功能」里的卸载图标
  // 全是 NSIS 自带的默认图标。
  // 根因：bundle.icon 只喂给 exe 与快捷方式；NSIS 安装器图标要
  // bundle.windows.nsis.installerIcon / uninstallerIcon 单独指定，
  // 不配就被 Tauri 渲染成 INSTALLERICON ""（空串），NSIS 回落默认图标。
  const nsisOf = () => readJson("src-tauri/tauri.conf.json").bundle?.windows?.nsis;

  it("必须给 installerIcon 与 uninstallerIcon 指定图标文件", () => {
    const nsis = nsisOf();
    expect(nsis, "bundle.windows.nsis 必须存在（否则安装器用 NSIS 默认图标）").toBeTruthy();
    expect(nsis.installerIcon, "必须配置 installerIcon").toBeTruthy();
    expect(nsis.uninstallerIcon, "必须配置 uninstallerIcon（卸载项也要有图标）").toBeTruthy();
  });

  it("指定的图标文件必须真实存在，且是 ICO 格式", () => {
    const nsis = nsisOf();
    for (const key of ["installerIcon", "uninstallerIcon"] as const) {
      const rel: string = nsis[key];
      const abs = `src-tauri/${rel}`;
      expect(existsSync(abs), `${abs} 必须存在`).toBe(true);
      // ico 头：reserved=0, type=1, count>=1
      const buf = readFileSync(abs);
      expect(buf.readUInt16LE(0), "ICO 保留字段必须为 0").toBe(0);
      expect(buf.readUInt16LE(2), "类型必须是 1（ICO）").toBe(1);
      expect(buf.readUInt16LE(4), "至少含 1 档图像").toBeGreaterThan(0);
    }
  });

  it("图标不能只在 target/ 之类构建产物里（冷构建会取不到）", () => {
    const nsis = nsisOf();
    for (const key of ["installerIcon", "uninstallerIcon"] as const) {
      expect(nsis[key], `${key} 不得指向 target/`).not.toContain("target/");
    }
  });
});

describe("B48 安装包必须自带 WebView2Loader.dll（缺了应用起不来）", () => {
  // 用户报告：装好的应用双击无反应。根因是 NSIS 包里只有 litepad.exe，
  // 而它的导入表依赖 WebView2Loader.dll（Tauri 的 WebView2 加载器，必须与 exe 同目录）；
  // 该 dll 由构建生成到 target/release/，但 bundler 不会自动收进包。
  it("bundle.resources 必须把 WebView2Loader.dll 打到安装目录根", () => {
    const conf = readJson("src-tauri/tauri.conf.json");
    const res = conf.bundle?.resources;
    expect(res, "bundle.resources 必须存在（否则 WebView2Loader.dll 不会进包）").toBeTruthy();

    // 两种写法都要认：["路径"] 与 { "源": "目标" }
    const pairs: [string, string][] = Array.isArray(res)
      ? (res as string[]).map((p) => [p, p])
      : Object.entries(res as Record<string, string>);

    const hit = pairs.find(([, target]) => /WebView2Loader\.dll$/i.test(target));
    expect(hit, "必须把 WebView2Loader.dll 打进安装包").toBeTruthy();
    // 目标若带子路径（如 target/release/...），exe 仍会在同目录找不到它
    expect(hit![1], "目标必须是安装目录根下的文件名，不能带子路径").toBe("WebView2Loader.dll");

    // 源路径**不能**指向构建产物：Tauri 的 codegen 在**编译前**就校验 resources 路径存在，
    // 而 target/release/ 下的 dll 是链接阶段才生成的 —— 冷构建（CI）必然报
    // "resource path ... doesn't exist"。本地能过只是因为 target 里有上次构建的残留。
    expect(hit![0], "源路径不得指向 target/（构建产物在校验时还不存在）").not.toContain("target/");
    expect(
      existsSync(`src-tauri/${hit![0]}`),
      `源文件 src-tauri/${hit![0]} 必须存在于仓库（随包分发的运行时依赖）`,
    ).toBe(true);
  });
});

describe("发布：版本号必须四处同步", () => {
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

describe("应用配置：capabilities 必须授予关窗权限", () => {
  it("关闭窗口/最后一个面板不报 ACL 错误：capabilities 必须授予 window close/destroy", () => {
    // 用户报告：unhandledrejection: Command plugin:window|destroy not allowed by ACL。
    // onCloseRequested 未 preventDefault 时内部调 destroy()，缺权限则关闭窗口报错。
    const cap = readJson("src-tauri/capabilities/default.json");
    const perms: string[] = cap.permissions ?? [];
    expect(perms, "必须包含 core:window:allow-close").toContain("core:window:allow-close");
    expect(perms, "必须包含 core:window:allow-destroy").toContain("core:window:allow-destroy");
  });
});
