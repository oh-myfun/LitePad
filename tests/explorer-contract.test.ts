// @vitest-environment node
// B314 · 资源管理器的**跨层契约**。
//
// 这里钉的全是「跨语言 / 跨文件、jsdom 跑不到」的那几条：命令名两端要一字不差、DOM id
// 要三处同时存在、`[hidden]` 的兜底必须在样式表里（jsdom 不跑样式级联，测不出
// `display: flex` 把 `[hidden]` 压过去）。行为本身在 tests/explorer-panel.test.ts 与
// tests/explorer-store.test.ts 里用真骨架跑，不在这里重复。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(p, "utf-8").replace(/\r\n/g, "\n");

const api = read("src/ipc/api.ts");
const rustCmds = read("src-tauri/src/commands/explorer.rs");
const rustMain = read("src-tauri/src/main.rs");
const rustSettings = read("src-tauri/src/session/mod.rs");
const html = read("index.html");
const ui = read("src/ui.ts");
const css = read("src/styles/preview.css");
const drawer = read("src/shell/drawer.ts");
const keymap = read("src/shell/keymap.ts");
const menubar = read("src/shell/menubar.ts");
const boot = read("src/main.ts");

const IDS = [
  "side-explorer",
  "explorer-panel",
  "explorer-title",
  "explorer-tree",
  "explorer-open",
  "explorer-refresh",
  "explorer-collapse",
  "explorer-new-file",
  "explorer-new-dir",
];

describe("B314 资源管理器跨层契约", () => {
  it("三条 IPC 命令名在两端都在（跨语言拼错不会有任何报错，只会「树是空的」）", () => {
    for (const name of ["list_dir", "create_file", "create_dir"]) {
      expect(rustCmds, `Rust 侧要 pub fn ${name}`).toContain(`pub fn ${name}(`);
      expect(rustMain, `${name} 必须注册进 generate_handler`).toContain(
        `commands::explorer::${name},`,
      );
      expect(api, `前端要 invoke("${name}")`).toContain(`invoke<`);
      expect(api, `前端调用点的命令名要一致`).toContain(`"${name}"`);
    }
    // 反向自证：把注册行删掉之后，上面那条判据必须落空
    const degraded = rustMain.replace("commands::explorer::list_dir,", "");
    expect(degraded, "退化串要先自证原句还在").not.toContain("commands::explorer::list_dir,");
  });

  it("模块不能叫 `fs`：commands/mod.rs 自己 `use std::fs`，同名会撞 E0255", () => {
    expect(rustCmds.includes("pub fn list_dir"), "内核在 explorer.rs").toBe(true);
    expect(read("src-tauri/src/commands/mod.rs")).toContain("pub mod explorer;");
    expect(read("src-tauri/src/commands/mod.rs")).not.toMatch(/^pub mod fs;/m);
  });

  it("`folder_root` 两栈都有、默认为空串（旧配置缺这格也要能读出来）", () => {
    expect(api, "前端 Settings 要有 folder_root").toContain("folder_root: string;");
    expect(rustSettings, "Rust Settings 要有 folder_root").toContain("pub folder_root: String");
    expect(rustSettings, "默认必须是空串（没开文件夹）").toContain("folder_root: String::new()");
  });

  it("DOM id 三处齐全：骨架里有、ui.ts 取了、也导出了", () => {
    const pairs: [string, string][] = [
      ["side-explorer", "sideExplorer"],
      ["explorer-panel", "explorerPanel"],
      ["explorer-title", "explorerTitle"],
      ["explorer-tree", "explorerTree"],
      ["explorer-open", "explorerOpen"],
      ["explorer-refresh", "explorerRefresh"],
      ["explorer-collapse", "explorerCollapse"],
      ["explorer-new-file", "explorerNewFile"],
      ["explorer-new-dir", "explorerNewDir"],
    ];
    expect(
      pairs.map(([id]) => id),
      "名单与 IDS 常量不许分叉",
    ).toEqual(IDS);
    for (const [id, name] of pairs) {
      expect(html, `index.html 缺 #${id}`).toContain(`id="${id}"`);
      expect(ui, `ui.ts 没取 #${id}`).toContain(`("${id}")`);
      expect(ui, `ui.ts 要有 const ${name}`).toContain(`const ${name} = el`);
      expect(ui, `ui.ts 要导出 ${name}`).toContain(`  ${name},`);
    }
  });

  it("样式：面板与子层都要 `[hidden]` 兜底（jsdom 测不出级联把 hidden 压过去）", () => {
    for (const sel of [".explorer-panel", ".explorer-children"]) {
      const block = css.match(new RegExp(`${sel}\\[hidden\\]\\s*\\{[^}]*\\}`))?.[0] ?? "";
      expect(block, `${sel}[hidden] 必须显式 display: none`).toContain("display: none");
    }
    expect(css, "缩进只有一处口径：按 --depth 算").toMatch(
      /\.explorer-row,[^}]*\.explorer-root,[^}]*\.explorer-note\s*\{[^}]*--depth/,
    );
  });

  it("外壳认得第三块：类型、回落判据、回放都要跟着走", () => {
    expect(api, "DrawerViewName 要有 explorer").toContain(`"toc" | "recent" | "explorer"`);
    expect(drawer, "盘上未知值回落大纲，但 explorer 必须认").toContain(
      `raw === "recent" || raw === "explorer"`,
    );
    // 反向：只认 recent 的那一版必须被现在的判据拒掉
    const degraded = drawer.replace(
      'raw === "recent" || raw === "explorer" ? raw : "toc"',
      'raw === "recent" ? raw : "toc"',
    );
    expect(degraded, "退化串要先自证原句还在").toContain('raw === "recent" ? raw : "toc"');
    expect(rustSettings, "Rust 那侧 drawer_view 仍是一串，不校验枚举").toContain(
      "pub drawer_view: String",
    );
  });

  it("命令、菜单、快捷键三条入口都接上了同一个动作", () => {
    expect(keymap, "命令表要有打开文件夹").toContain(`id: "file.openFolder"`);
    expect(keymap, "命令表要有资源管理器开合").toContain(`id: "view.explorer"`);
    expect(menubar, "文件菜单要有那一条").toContain("打开文件夹");
    expect(menubar, "查看菜单那条的勾选态问的是外壳那一块").toContain("explorerChecked()");
    expect(boot, "runShortcut 要接 file.openFolder").toContain(`case "file.openFolder"`);
    expect(boot, "runShortcut 要接 view.explorer").toContain(`case "view.explorer"`);
  });

  it("只给主窗口装配，且启动回放不许反写盘", () => {
    const at = boot.indexOf("setupExplorer();");
    expect(at, "没装配 ⇒ 那颗键点了没东西").toBeGreaterThan(-1);
    expect(boot.slice(at - 600, at), "子窗口没有左边栏").toContain('windowKind === "main"');
    expect(boot.indexOf("setExplorerRoot(folderRoot)"), "根要在登记之后才搬").toBeGreaterThan(at);
    expect(boot.slice(at, at + 600), "空串不发读盘").toContain("if (folderRoot)");
    expect(boot, "启动回放走 store.setRoot，不走会落盘的 openFolder").toContain(
      "setExplorerRoot(folderRoot)",
    );
    expect(boot, "openFolder 那条才是会写设置的，启动期不许用").not.toMatch(
      /setupExplorer\(\);[\s\S]{0,400}[^p]openFolder\(/,
    );
  });

  it("打开文件夹之后要落盘、且顺手把这一块摊开（VS Code 的口径）", () => {
    const panel = read("src/explorer/panel.ts");
    expect(panel, "换根要写 settings.folder_root").toContain("settings.folder_root = path");
    expect(panel, "写完要落盘").toContain("saveSettings(settings)");
    expect(panel, "选完文件夹就把这一块摊开").toContain(`setDrawer("explorer")`);
    expect(panel, "子窗口空转（藏在 display:none 里开一块 = 死键 + 脏落盘）").toContain(
      'if (windowKind === "satellite") return;',
    );
  });
});
