// @vitest-environment jsdom
// B107 应用内自动更新回归：
// 1) 状态机（src/shell/updater.ts，插件 API 用替身 vi.mock 驱动）——发现更新 / 下载进度 /
//    就绪重启 / 失败回退 / 防重入 / 自动检查失败静默；
// 2) 静态守卫——配置三件套（conf / capability / Rust 注册）、CI 链路（Secret 注入 +
//    latest.json 生成 + 降级）、本地构建脚本（密钥注入 + 无密钥降级）；
// 3) 红线——签名私钥绝不入库（项目内不得出现 *.key；.gitignore 必须兜底）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { initUpdater, type UpdaterHandle } from "../src/shell/updater";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import type { Update } from "@tauri-apps/plugin-updater";

type DownloadCb = (event: unknown) => void;

/** 替身 Update：可编排进度事件与失败模式；downloadAndInstall 自证「替身确实跑了」。 */
function fakeUpdate(version: string, opts: { fail?: boolean; noEvents?: boolean } = {}): Update {
  return {
    version,
    downloadAndInstall: vi.fn(async (cb?: DownloadCb) => {
      if (opts.fail) throw new Error("网络中断");
      if (!opts.noEvents) {
        cb?.({ event: "Started", data: { contentLength: 100 } });
        cb?.({ event: "Progress", data: { chunkLength: 40 } });
        cb?.({ event: "Progress", data: { chunkLength: 60 } });
        cb?.({ event: "Finished", data: {} });
      }
    }),
  } as unknown as Update;
}

function makeHost(): HTMLElement {
  const host = document.createElement("div");
  host.className = "title-actions";
  // 与真实 .title-actions 同构（index.html）：左栏开关在前、置顶键在后，
  // 更新键 B311 起要插在**最左边**（= 左栏开关的左侧）。
  const side = document.createElement("button");
  side.id = "sidebar-toggle";
  const pin = document.createElement("button");
  pin.id = "win-pin";
  host.append(side, pin);
  document.body.appendChild(host);
  return host;
}

function init(messages: string[], errs: string[]): UpdaterHandle {
  return initUpdater({
    host: makeHost(),
    showMessage: (text, isError) => (isError ? errs : messages).push(text),
    persist: vi.fn(),
    initialDelayMs: 0,
    intervalMs: 0,
  });
}

function updBtn(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(".upd-btn");
  expect(btn, "更新键应已动态创建").toBeTruthy();
  return btn!;
}

beforeEach(() => {
  vi.mocked(check).mockReset();
  vi.mocked(relaunch).mockReset();
});

afterEach(() => {
  document.body.textContent = "";
});

describe("B107 更新状态机", () => {
  it("无更新：手动检查提示「已是最新」，按钮保持不可见", async () => {
    vi.mocked(check).mockResolvedValue(null);
    const messages: string[] = [];
    const errs: string[] = [];
    const handle = init(messages, errs);
    await handle.checkNow();
    expect(messages).toEqual(["当前已是最新版本"]);
    expect(errs).toEqual([]);
    expect(updBtn().style.display).toBe("none");
  });

  it("发现更新：按钮出现（cloud-download + 提示点），状态栏报新版本号", async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate("0.14.0"));
    const messages: string[] = [];
    const handle = init(messages, []);
    await handle.checkNow();
    const btn = updBtn();
    expect(btn.style.display).not.toBe("none");
    expect(btn.innerHTML, "发现更新 = cloud-download 字形").toContain("codicon-cloud-download");
    expect(btn.classList.contains("has-update"), "提示点应点亮").toBe(true);
    expect(btn.getAttribute("aria-label")).toContain("0.14.0");
    expect(messages.join("\n")).toContain("0.14.0");
  });

  it("点击安装：进度走完进入就绪，persist 落盘后 relaunch（替身必须真的跑过）", async () => {
    const update = fakeUpdate("0.14.0");
    vi.mocked(check).mockResolvedValue(update);
    const handle = init([], []);
    await handle.checkNow();
    updBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(vi.mocked(relaunch)).toHaveBeenCalledTimes(1));
    // 反向验证前置：替身确实被调用（否则「没拦」与「拦不住」分不开）
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(updBtn().innerHTML, "就绪 = refresh 字形").toContain("codicon-refresh");
    // persist 在下载前与 relaunch 前各一次（都走 opts.persist）
    // relaunch 只由安装完成链路触发一次；就绪后再点一次会再次 relaunch（真实场景 = 用户延迟重启）
    updBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(vi.mocked(relaunch)).toHaveBeenCalledTimes(2));
  });

  it("下载中：进度圆环 + 百分比写进 aria-label 与 `--p`", async () => {
    let captured: DownloadCb | undefined;
    const update = fakeUpdate("0.14.0");
    (update.downloadAndInstall as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb?: DownloadCb) => {
        captured = cb;
        // 挂住不放：让测试在「下载中」观察中间态
        await new Promise(() => {});
      },
    );
    vi.mocked(check).mockResolvedValue(update);
    const handle = init([], []);
    await handle.checkNow();
    updBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(captured).toBeTruthy());
    captured?.({ event: "Started", data: { contentLength: 100 } });
    captured?.({ event: "Progress", data: { chunkLength: 40 } });
    const ring = updBtn().querySelector<HTMLElement>(".upd-ring");
    expect(ring, "下载中 = 进度圆环（B311 取代横进度条）").toBeTruthy();
    expect(ring!.style.getPropertyValue("--p"), "完成度写在 --p 上").toBe("40");
    expect(updBtn().innerHTML, "圆环是 CSS 画的，不许混进手绘 SVG").not.toContain("<svg");
    expect(updBtn().getAttribute("aria-label")).toContain("40%");
    // 同一发里再进一格：必须复用那个节点，不能重建（重建 = 每 1% 闪一次）
    const same = ring!;
    captured?.({ event: "Progress", data: { chunkLength: 20 } });
    expect(updBtn().querySelector(".upd-ring")).toBe(same);
    expect(same.style.getPropertyValue("--p")).toBe("60");
  });

  it("B311 位置：更新键插在 .title-actions 最左边（= 左栏开关那颗的左侧）", async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate("0.14.0"));
    const host = makeHost();
    initUpdater({
      host,
      showMessage: () => {},
      persist: vi.fn(),
      initialDelayMs: 0,
      intervalMs: 0,
    });
    const kids = [...host.children].map((el) => el.id || el.className);
    expect(kids[0], "更新键必须是第一个孩子").toContain("upd-btn");
    expect(kids[1], "紧跟其后才是左栏开关").toBe("sidebar-toggle");
    expect(kids[2], "置顶键仍在最后").toBe("win-pin");
  });

  it("手动检查在途：按钮亮起来转圆环；查完没更新就收回（自动检查不许亮）", async () => {
    let settle: (u: Update | null) => void = () => {};
    vi.mocked(check).mockImplementation(
      () => new Promise<Update | null>((r) => (settle = r)) as ReturnType<typeof check>,
    );
    const handle = init([], []);
    const p = handle.checkNow(); // 不 await：这一发还挂在检查中
    await vi.waitFor(() => expect(vi.mocked(check)).toHaveBeenCalledTimes(1));
    const btn = updBtn();
    expect(btn.style.display, "检查中按钮要出现").toBe("");
    expect(btn.classList.contains("is-spin"), "检查中 = 旋转那一档").toBe(true);
    expect(btn.querySelector(".upd-ring"), "旋转档画的也是圆环").toBeTruthy();
    expect(btn.getAttribute("aria-label")).toBe("正在检查更新");

    settle(null);
    await p;
    expect(btn.style.display, "查完没有更新 ⇒ 收回").toBe("none");
    expect(btn.classList.contains("is-spin")).toBe(false);
  });

  it("安装失败：退回 available 态可重试，状态栏报错", async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate("0.14.0", { fail: true }));
    const errs: string[] = [];
    const handle = init([], errs);
    await handle.checkNow();
    updBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(errs.join("\n")).toContain("更新安装失败"));
    const btn = updBtn();
    expect(btn.innerHTML).toContain("codicon-cloud-download");
    expect(btn.classList.contains("has-update")).toBe(true);
    expect(vi.mocked(relaunch)).not.toHaveBeenCalled();
  });

  it("防重入：检查期间再点菜单不会并发触发第二次 check", async () => {
    vi.mocked(check).mockImplementation(() => new Promise(() => {}));
    const messages: string[] = [];
    const handle = init(messages, []);
    void handle.checkNow(); // 首次检查挂住不返回（替身是永不 resolve 的 promise）
    await handle.checkNow();
    expect(vi.mocked(check), "检查期间不得并发触发第二次真实 check").toHaveBeenCalledTimes(1);
    expect(messages).toContain("更新检查正在进行，请稍候");
  });

  it("自动检查失败必须静默（只 console.warn，不写状态栏）", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(check).mockRejectedValue(new Error("离线"));
    const messages: string[] = [];
    const errs: string[] = [];
    initUpdater({
      host: makeHost(),
      showMessage: (text, isError) => (isError ? errs : messages).push(text),
      persist: vi.fn(),
      initialDelayMs: 10,
      intervalMs: 0,
    });
    const auto = vi.waitFor(() => expect(warn).toHaveBeenCalled());
    vi.advanceTimersByTime(10);
    await auto;
    expect(messages, "静默失败不得打扰用户").toEqual([]);
    expect(errs, "静默失败不得打扰用户").toEqual([]);
    vi.useRealTimers();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------- 静态守卫

/** 守卫判据做成函数，反向验证才能「挖掉 → 判红」证明咬得住。 */
function guardPubkey(src: string): boolean {
  return /"pubkey": "[A-Za-z0-9+/=]{100,}"/.test(src);
}

function readSrc(p: string): string {
  return readFileSync(p, "utf-8");
}

function findKeyFiles(dir: string, out: string[], skip: string[]): void {
  for (const name of readdirSync(dir)) {
    if (skip.includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) findKeyFiles(p, out, skip);
    else if (name.endsWith(".key")) out.push(p);
  }
}

describe("B107 更新链路静态守卫", () => {
  it("配置三件套：tauri.conf.json / capability / Rust 注册必须成对出现", () => {
    const conf = readSrc("src-tauri/tauri.conf.json");
    expect(conf, "bundle 必须开 createUpdaterArtifacts（否则构建不产出 .exe.sig）").toContain(
      '"createUpdaterArtifacts": true',
    );
    expect(conf, "updater 必须内嵌 minisign 公钥").toContain('"pubkey"');
    expect(conf, "endpoint 必须指向 GitHub Releases 静态 feed").toContain(
      "releases/latest/download/latest.json",
    );
    expect(conf, "NSIS 走 passive 静默安装").toContain('"installMode": "passive"');

    // 反向验证：把 pubkey 挖成空串，同一把尺子必须判红（否则这条守卫是恒真假绿）
    expect(guardPubkey(conf), "正向：真公钥要过").toBe(true);
    const broken = conf.replace(/"pubkey": "[^"]*"/, '"pubkey": ""');
    expect(guardPubkey(broken), "反向：空公钥必须被咬住").toBe(false);

    const cap = readSrc("src-tauri/capabilities/default.json");
    expect(cap, "updater:default 未授权 = 前端 invoke 被 ACL 静默拒绝").toContain(
      "updater:default",
    );
    expect(cap, "process:allow-restart 未授权 = relaunch 失败").toContain("process:allow-restart");

    const main = readSrc("src-tauri/src/main.rs");
    expect(main, "Rust 必须注册 updater 插件").toContain("tauri_plugin_updater::Builder");
    expect(main, "Rust 必须注册 process 插件（relaunch）").toContain("tauri_plugin_process::init");
  });

  it("前端接线：更新模块存在、菜单入口、钉在「左栏开关」左边（B311）", () => {
    expect(existsSync("src/shell/updater.ts"), "updater 模块必须存在").toBe(true);
    const upd = readSrc("src/shell/updater.ts");
    expect(upd, "自动检查失败必须静默（console.warn）").toContain("console.warn");
    expect(upd, "安装前必须 persist 落盘现场").toContain("await opts.persist()");
    expect(upd, "不得手绘 SVG（图标走 codicon，圆环走 CSS）").not.toContain("<svg");
    expect(upd, "更新键必须插成容器的第一个孩子（= 左栏开关左边），别再按 id 找置顶键").toContain(
      "opts.host.insertBefore(btn, opts.host.firstElementChild)",
    );

    const menu = readSrc("src/shell/menubar.ts");
    expect(menu, "帮助菜单必须有检查更新入口").toContain('label: "检查更新"');
    expect(menu, "回调类型必须声明").toContain("onCheckUpdate");

    const main = readSrc("src/main.ts") + "\n" + readSrc("src/commands.ts");
    expect(main, "main 必须初始化更新键").toContain("initUpdater({");
    expect(main, "菜单回调必须接到手动检查").toContain("updaterHandle?.checkNow()");
    expect(main, "persist 必须走热退出同款会话落盘").toContain("persist: () => persistSession()");
  });

  it("发布依赖必须钉死版本（字形/接口跨版本会漂移，不能给 ^）", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      dependencies: Record<string, string>;
    };
    for (const dep of ["@tauri-apps/plugin-updater", "@tauri-apps/plugin-process"]) {
      const ver = pkg.dependencies[dep];
      expect(ver, `${dep} 必须声明依赖`).toBeTruthy();
      expect(ver, `${dep} 版本必须钉死`).not.toMatch(/^[\^~]/);
    }
  });

  it("CI：Secret 注入 + latest.json 生成 + 无密钥降级，缺一不可", () => {
    const yml = readSrc(".github/workflows/release.yml");
    expect(yml, "签名私钥必须来自 GitHub Secret，绝不写死在仓库").toContain(
      "TAURI_SIGNING_PRIVATE_KEY",
    );
    expect(yml, "必须调用 latest.json 生成脚本").toContain("gen-latest-json.sh");
    expect(yml, "无密钥时必须降级关闭 createUpdaterArtifacts（CI 不因缺密钥炸掉）").toContain(
      '"createUpdaterArtifacts":false',
    );
    expect(yml, "发布资产必须直接从 tauri 构建目录上传，不得另拷贝第二份到项目根").toContain(
      "release/bundle/nsis",
    );

    const gen = readSrc("scripts/gen-latest-json.sh");
    expect(
      gen,
      "signature 必须是 .sig 原文 base64（tauri 先 base64 解码再按 minisign 解析；直接喂明文会报 Invalid symbol 10）",
    ).toContain('startsWith("untrusted comment:")');
    expect(gen, "平台键必须是 windows-x86_64").toContain('"windows-x86_64"');
    expect(gen, "url 必须指向该版本 Release 的 .exe 安装包附件").toContain("releases/download/");
  });

  it("本地构建：build-all.sh 与 pre-push 都要密钥注入 + 无密钥降级", () => {
    for (const f of ["scripts/build-all.sh", ".githooks/pre-push"]) {
      const src = readSrc(f);
      expect(src, `${f} 必须注入 TAURI_SIGNING_PRIVATE_KEY`).toContain("TAURI_SIGNING_PRIVATE_KEY");
      expect(src, `${f} 私钥只从项目外 ~/.tauri/litepad.key 读`).toContain(
        "$HOME/.tauri/litepad.key",
      );
      expect(src, `${f} 无密钥必须降级关闭 createUpdaterArtifacts`).toContain(
        '"createUpdaterArtifacts":false',
      );
    }
  });

  it("红线：签名私钥绝不入库（*.key 不得出现在仓库源码区）", () => {
    // 只扫源码区（跳过 node_modules / target / dist / .git / docs 副本等大体量目录）
    const keyFiles: string[] = [];
    for (const dir of ["src-tauri", "src", "scripts", "tests", ".github"]) {
      if (existsSync(dir)) findKeyFiles(dir, keyFiles, ["target", "gen"]);
    }
    expect(keyFiles, `发现疑似私钥入库：${keyFiles.join(", ")}`).toEqual([]);
    // 兜底：就算有人把密钥拷进项目，.gitignore 的 *.key 也必须拦住它进 git
    expect(readSrc(".gitignore"), ".gitignore 必须忽略 *.key").toContain("*.key");
    expect(
      readSrc(".gitignore"),
      ".gitignore 必须忽略 .tmp/（构建期临时文件统一收口，不在仓库留产物）",
    ).toContain(".tmp/");
  });
});
