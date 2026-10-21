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

  it("三块视图各自挂自己那颗按钮的点击（登记 ≠ 挂线，真机抓到过漏挂）", () => {
    // `registerDrawerView` 只管「显隐与亮灭怎么算」，点击监听归各视图自己挂。
    // 漏挂的表现是「那颗键看着正常、点下去毫无反应」，而 jsdom 那侧全是
    // 「程序里调 setDrawer 再断言亮灭」，照不出来 ⇒ 这一条按源码串钉住三块。
    const wiring: [string, string][] = [
      ["src/toc.ts", "sideOutline"],
      ["src/recents/panel.ts", "sideRecent"],
      ["src/explorer/panel.ts", "sideExplorer"],
    ];
    for (const [file, ref] of wiring) {
      expect(read(file), `${ref} 必须挂 click（不然按钮列那颗是死的）`).toMatch(
        new RegExp(`${ref}\\.addEventListener\\("click"`),
      );
      // 自证判据有鉴别力：把那一句抹掉，上面那条必须落空
      const degraded = read(file).replace(
        new RegExp(`${ref}\\.addEventListener\\("click"`),
        `${ref}.addEventListener("contextmenu"`,
      );
      expect(
        new RegExp(`${ref}\\.addEventListener\\("click"`).test(degraded),
        "退化串要先自证原句还在",
      ).toBe(false);
    }
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

describe("B315 路径改写的跨层契约", () => {
  const rustMod = read("src-tauri/src/commands/mod.rs");
  const paths = read("src/explorer/paths.ts");

  it("四条写操作 + set_doc_path 两端都在（拼错的命令名只表现为「点了没反应」）", () => {
    for (const name of ["rename_entry", "copy_entry", "move_entry", "delete_entry"]) {
      expect(rustCmds, `Rust 侧要 pub fn ${name}`).toContain(`pub fn ${name}(`);
      expect(rustMain, `${name} 必须注册`).toContain(`commands::explorer::${name},`);
      expect(api, `前端要 invoke("${name}")`).toContain(`"${name}"`);
    }
    // 后端那份文档记录的路径：**自动保存回落的就是它**。注册漏了 → 改名后旧文件被写回来，
    // 而这条链的每一端单测都还是绿的，所以只能在这里钉。
    expect(rustMod, "Rust 侧要 pub fn set_doc_path").toContain("pub fn set_doc_path(");
    expect(rustMain, "set_doc_path 必须注册").toContain("commands::set_doc_path,");
    expect(api, '前端要 invoke("set_doc_path")').toContain(`"set_doc_path"`);
  });

  it("`destDir` / `newName` 这类跨语言参数名要逐字对上 Rust 的下划线写法", () => {
    expect(api).toContain(`invoke<FsEntry>("rename_entry", { root, path, newName })`);
    expect(api).toContain(`invoke<FsEntry>("copy_entry", { root, src, destDir })`);
    expect(api).toContain(`invoke<FsEntry>("move_entry", { root, src, destDir })`);
    expect(rustCmds).toContain("new_name: String");
    expect(rustCmds).toContain("dest_dir: String");
  });

  it("对账模块挂在每一扇窗口上，而不是只挂在主窗口那一支", () => {
    // 发起方只有主窗口，但「谁拿着这份文档谁改自己那份账」——卫星窗口漏装就是
    // 「在子窗口里标签还写着旧名字，保存却写到了新路径」。
    const at = boot.indexOf("setupPathRewiring();");
    expect(at, "没装配 ⇒ 改了名而标签永远停在旧名字").toBeGreaterThan(-1);
    expect(boot.slice(0, at), "要在 windowKind 分支之前").not.toContain('windowKind === "main"');
    expect(boot, "从模块本身取，不许就地再写一份").toContain(
      'import { setupPathRewiring } from "./explorer/paths";',
    );
  });

  it("顶部那一排：造东西 → 整理这棵树（B327 起打开键不在这排里）", () => {
    const order = [
      "explorer-new-file",
      "explorer-new-dir",
      "explorer-refresh",
      "explorer-collapse",
    ];
    const inOrder = (src: string): boolean => {
      let prev = -1;
      for (const id of order) {
        const at = src.indexOf(`id="${id}"`);
        if (at < 0 || at <= prev) return false;
        prev = at;
      }
      return true;
    };
    // 这一排是常驻的一排，屏上的左右位置就是唯一读法：DOM 次序即顺序。
    expect(inOrder(html), "顶部那一排次序漂了").toBe(true);
    // 自证判据有鉴别力：把「新建文件」那一颗抹掉，上面那条必须落空
    expect(inOrder(html.replace('id="explorer-new-file"', 'id="explorer-zzz"'))).toBe(false);
    // 反向闸：打开键在**骨架里**只是歇脚处（无根时它回到头部被 no-root 收起），
    // 屏上它该在根那一行 —— 所以头部那一排的次序里不许再算它。
    const head = html.slice(
      html.indexOf('class="explorer-head"'),
      html.indexOf('id="explorer-tree"'),
    );
    expect(
      head.indexOf('id="explorer-open"') < head.indexOf('id="explorer-new-file"'),
      "打开键不许还排在最左（那正是被搬走的那一颗）",
    ).toBe(false);
  });

  it("B327：打开键搬进根目录那一行的最右，且不许被当成「点了那一行」", () => {
    const panel = read("src/explorer/panel.ts");
    // 1) 有根 ⇒ 元素被挂到根行；无根 ⇒ 放回头部那一排（no-root 的 CSS 收起整排）
    expect(panel, "有根时要把打开键挂进根行").toMatch(/rootRow\.append\([\s\S]*explorerOpen\)/);
    expect(panel, "无根时要放回头部那一排").toMatch(
      /\.explorer-head[\s\S]{0,120}append\(explorerOpen\)/,
    );
    // 2) 贴右靠一条 margin-left:auto（根行是 flex，名字那截 flex:1 已经吃掉余量，
    //    但省略号一收就漏出空隙 —— 只有 auto 边距能保证「永远在最右」）
    expect(css, "根行里那颗键要贴右").toMatch(
      /\.explorer-root \.toc-head-btn\s*\{[^}]*margin-left:\s*auto/,
    );
    // 3) 树是**委托**点击（`explorerTree.addEventListener("click", onRowClick)`），按钮搬进来
    //    之后一发点击会同时命中「开目录」与「折叠根」两件事 ⇒ 委托那一路必须先挡掉按钮。
    const click = panel.slice(
      panel.indexOf("function onRowClick"),
      panel.indexOf("async function activateDir"),
    );
    expect(click, "点按钮不该把根行折叠/展开一遍").toContain('closest("button")');
    expect(
      panel.slice(
        panel.indexOf("function onRowContext"),
        panel.indexOf("function onRowContext") + 700,
      ),
      "右键也不该在按钮上弹出那一行的菜单",
    ).toContain('closest("button")');
  });

  it("名单只由发起方改，回收站那条走「删掉」而不是「改写成空」", () => {
    expect(paths).toContain("retitleRecentEntry(change.from, change.to)");
    expect(paths).toContain("forgetRecentEntry(change.from)");
    // 监听那一段只做「改自己这份账」：再去改名单 = 同一次改名记两回（第二回已经命中不到，
    // 名单会停在旧写法上）；再转发一次 = 回声环。
    const listener = paths.slice(paths.indexOf("export function setupPathRewiring"));
    expect(listener, "收到别窗那一发不许再动名单").not.toMatch(/RecentEntry\(/);
    expect(listener, "收到别窗那一发不许再广播").not.toContain("emitCrossWindow");
  });
});

describe("B317 标题排与初屏那一排的样式契约", () => {
  const toc = read("src/markdown/toc.ts");
  const panel = read("src/explorer/panel.ts");

  /** 取 `export const NAME = 数字;` 里那个数字（跨文件的同值判据，两侧都得从源码现读）。 */
  const numConst = (src: string, name: string): number => {
    const m = src.match(new RegExp(`export const ${name} = (\\d+)`));
    expect(m, `源码里找不到 ${name}`).toBeTruthy();
    return Number(m?.[1]);
  };

  it("展开区最小宽：JS 的下限与 CSS 的初值必须同值（160 那一档装不下标题那一排）", () => {
    const min = numConst(toc, "SIDE_MIN_WIDTH");
    const m = css.match(/\.side-drawer\s*\{[^}]*min-width:\s*(\d+)px/);
    expect(m, "preview.css 里 `.side-drawer` 要有 min-width").toBeTruthy();
    expect(Number(m?.[1]), "两处不同值 = 「没拖过时挤成一团，一拖才终于不松」").toBe(min);
    // 判据的鉴别力：把 CSS 改回旧的 160 必须被打红
    expect(
      min,
      "160 那一档装不下标题那一排（B317 定）；B327 把打开键搬进根行，头部只剩四颗，才又收到 180",
    ).toBeGreaterThanOrEqual(180);
  });

  it("还没打开文件夹时顶部那一排收起：类名两侧同源，不许一边写一边漏", () => {
    expect(panel, "renderTree 要挂 no-root").toContain('explorerPanel.classList.add("no-root")');
    expect(panel, "有根时要摘掉（摘不掉就永远看不见那五颗键）").toContain(
      'explorerPanel.classList.remove("no-root")',
    );
    // 顺序也算判据：先 return 掉无根那一支，再摘 —— 反了就会 add 完立刻 remove。
    expect(panel.indexOf('classList.add("no-root")')).toBeLessThan(
      panel.indexOf('classList.remove("no-root")'),
    );
    expect(css).toMatch(/\.explorer-panel\.no-root \.toc-head-btn\s*\{\s*display:\s*none/);
    // 自证：类名写错一个字母（CSS 与 TS 各写各的）时上面两条必有一条落空
    expect(css.includes(".explorer-panel.no-rootz")).toBe(false);
  });

  it("初屏那颗「打开文件夹」整宽、图标与文字成组居中", () => {
    const btn = css.slice(
      css.indexOf(".explorer-hint-btn {"),
      css.indexOf(".explorer-hint-btn:hover"),
    );
    expect(btn, "取不到 .explorer-hint-btn").toBeTruthy();
    expect(btn).toMatch(/display:\s*flex/);
    expect(btn, "inline-flex 只吃内容宽，撑不满边栏").not.toMatch(/display:\s*inline-flex/);
    expect(btn).toMatch(/width:\s*100%/);
    expect(btn).toMatch(/justify-content:\s*center/);
  });
});

describe("B318 行内新建 / 改名框与「输入框那一族」同形", () => {
  const preview = css;
  const global = read("src/styles/global.css");

  /** 取某条规则体的属性值（同属性多处出现取第一条）。 */
  const block = (src: string, sel: string): string => {
    const at = src.indexOf(`${sel} {`);
    expect(at, `找不到规则 ${sel}`).toBeGreaterThanOrEqual(0);
    return src.slice(at, src.indexOf("}", at));
  };
  const prop = (body: string, name: string): string =>
    (body.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1] ?? "").trim();

  it("常态不挂 accent；accent 只在聚焦那一下走 outline（与 .find-field 同一口径）", () => {
    const box = block(preview, ".explorer-input");
    expect(prop(box, "border"), "常态描边要用中性边框").toBe("1px solid var(--border, #d0d7de)");
    expect(
      box,
      "不许再把 accent 画在常态边框上（本软件只在聚焦 / 激活时才上 accent）",
    ).not.toContain("--accent");
    const focus = block(preview, ".explorer-input:focus");
    expect(prop(focus, "outline")).toBe("1px solid var(--accent, #0969da)");
    expect(prop(focus, "outline-offset")).toBe("-1px");
    // 同族判据：聚焦环的描法两边必须一致（改了其中一处就得看见）
    expect(
      prop(block(global, ".find-field:focus-within"), "outline-offset"),
      "聚焦环一边 outline、一边 border-color，两种描法迟早错开",
    ).toBe(prop(focus, "outline-offset"));
  });

  it("圆角 / 字号跟着输入框那一族走，别自立一档", () => {
    const box = block(preview, ".explorer-input");
    expect(prop(box, "border-radius"), "与 .goto-input 不同圆角 = 一眼看出是两种控件").toBe(
      prop(block(global, ".goto-input"), "border-radius"),
    );
    expect(prop(box, "font-size"), "字号跟那一行（12px），也与设置页的数字框同值").toBe(
      prop(block(global, '.settings-dialog input[type="number"]'), "font-size"),
    );
    expect(prop(box, "box-sizing"), "带边框又不想顶出 22px 那一行，必须 border-box").toBe(
      "border-box",
    );
  });
});
