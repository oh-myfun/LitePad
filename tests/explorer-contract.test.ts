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

  it("B331「关闭文件夹」四条入口齐全，且没开文件夹时置灰", () => {
    // 菜单位置：紧跟在「打开文件夹」后面 —— 这两颗是一对，隔开了就找不到「关掉」在哪。
    const openAt = menubar.indexOf('withKey("打开文件夹"');
    const closeAt = menubar.indexOf('withKey("关闭文件夹"');
    expect(openAt, "取不到「打开文件夹」那一条").toBeGreaterThanOrEqual(0);
    expect(closeAt, "文件菜单缺「关闭文件夹」").toBeGreaterThan(openAt);
    // 置灰判据：无根时点亮它 = 「关掉一个没开着的文件夹」，还会顺手把盘上那一格写空。
    const item = menubar.slice(closeAt, closeAt + 220);
    expect(item, "无根时不许点亮").toMatch(/disabled:\s*!cb\.hasFolderRoot\(\)/);
    expect(
      item,
      "onSelect 只许走 panel.closeFolder（换根三件事的漏斗在那边，别在菜单里再写一份）",
    ).toMatch(/onSelect:\s*cb\.onCloseFolder/);
    // 两端都要有：接口声明 + commands.ts 的实装（漏一侧 = tsc 先炸，但漏的是**判据**这一侧时
    // 只有这里看得见 —— 接口写了、实装随手 `() => {}` 也能过编译）。
    expect(menubar).toMatch(/hasFolderRoot:\s*\(\)\s*=>\s*boolean;/);
    expect(menubar).toMatch(/onCloseFolder:\s*\(\)\s*=>\s*void;/);
    const cmds = read("src/commands.ts");
    expect(cmds, "实装要读 store 的 hasRoot，不许自己判路径").toMatch(
      /hasFolderRoot:\s*\(\)\s*=>\s*hasRoot\(\)/,
    );
    expect(cmds, "关闭那颗要调 panel.closeFolder").toMatch(
      /onCloseFolder:\s*\(\)\s*=>\s*void closeFolder\(\)/,
    );
    expect(keymap, "命令表要有 file.closeFolder（命令面板与快捷键覆盖都读它）").toContain(
      `id: "file.closeFolder"`,
    );
    expect(boot, "runShortcut 要接 file.closeFolder").toContain(`case "file.closeFolder"`);
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

describe("B328/B329 侧栏那几格的下伸部（省略号那层不许切字）", () => {
  /** 取某条规则体（含结尾的 `}`），并**抹掉注释**：判据要读的是声明，不是散文
   *  —— 注释里那句「行那一族按 1 排」长得跟声明一模一样，留着它就能把这条闸喂假。 */
  const block = (sel: string): string => {
    const at = css.indexOf(sel);
    expect(at, `找不到规则 ${sel}`).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at) + 1).replace(/\/\*[\s\S]*?\*\//g, "");
  };
  const num = (body: string, name: string): number => {
    // 属性名前必须再没有一个 `-`：不然查 `height` 会一头扎进 `line-height`，
    // 读到 1 还以为量到了行高。（`px?` 是「p 加可选 x」，要写 `(?:px)?` 才是「px 可选」。）
    const m = body.match(new RegExp(`[;{\\s]${name}:\\s*(\\d+(?:\\.\\d+)?)(?:px)?`));
    expect(m, `规则里找不到 ${name}（带 px 的量）`).toBeTruthy();
    return Number(m?.[1]);
  };

  // 取证（.tmp/descender/probe-ab.html，3 倍缩放量像素）：**同一行高**下并排渲两版，
  // 唯一变量是 `overflow: hidden` / `visible`，逐点数框内墨点 —— 不等就是在切。
  //   资源管理器那一格（12px 粗体）：1.30 少 52 点（末行整条没了）、1.35 少 18 点
  //   （末行被削掉半条）、**1.40 起两版逐点相同**。取 1.5 是留一整行的余量。
  //   行盒长高时字不动（内容居中于行盒，上下各长一半）⇒ 只有裁切框在变松。
  const FLOOR = 1.45;
  /** 侧栏里带省略号的那几格统一这一档（B328 资源管理器、B329 最近打开）。 */
  const SIDE_LH = 1.5;

  it("带着 overflow:hidden 的那一格，必须同时带着撑得下下伸部的行高", () => {
    const name = block(".explorer-name {");
    // 反例排在正向之前（B219 定式）：先钉住「省略号那层还在」——它是这一格存在的理由，
    // 也是切掉下伸部的那把刀；把它删了就等于用「不切」换「长文件名顶出边栏」。
    expect(name, "省略号要靠 overflow:hidden 裁").toMatch(/overflow:\s*hidden/);
    expect(name, "text-overflow 与它配对，少一半就没有省略号").toMatch(/text-overflow:\s*ellipsis/);
    const lh = num(name, "line-height");
    expect(lh, `行盒 ${lh} ⇒ 下伸部被切（判据下限 ${FLOOR}）`).toBeGreaterThanOrEqual(FLOOR);
    // 自证判据有鉴别力：改回「跟字号同高」的 1，正是被切掉的那一版，必须落空
    const degraded = name.replace(/line-height:\s*[\d.]+/, "line-height: 1");
    expect(degraded, "退化串要先自证原句还在").not.toBe(name);
    expect(num(degraded, "line-height"), "1 那一档就是用户报的那一版").toBeLessThan(FLOOR);
  });

  it("但 clip 框也不能长过那一行（行高 22px 是树的密度，撑破它就整棵树变胖）", () => {
    const row = block(".explorer-row,");
    const rowH = num(row, "height");
    const fs = num(row, "font-size");
    expect(row, "行那一族仍按 line-height: 1 排（名字那格自己撑）").toMatch(/line-height:\s*1;/);
    const name = block(".explorer-name {");
    const box = num(name, "line-height") * fs;
    expect(box, `行盒 ${box}px 顶破 ${rowH}px 的行 ⇒ 行高被撑开`).toBeLessThanOrEqual(rowH);
    // 同一条尺子量「长过头」的替身：必须量出不一样的结论，否则上面那条是恒真的
    expect(2 * fs, "2 那一档（24px）必须被同一把尺子拒掉").toBeGreaterThan(rowH);
  });

  it("B329：最近打开那两截走同一口径（名字 12px / 目录 11px 都带着省略号那层）", () => {
    for (const sel of [".recent-name {", ".recent-path {"]) {
      const cell = block(sel);
      expect(cell, `${sel} 也在用 overflow:hidden 裁字`).toMatch(/overflow:\s*hidden/);
      expect(
        num(cell, "line-height"),
        `${sel} 与资源管理器那一格错开一档 = 两块面板的下伸部一处切一处不切`,
      ).toBe(SIDE_LH);
    }
    // 自证：目录那一截回到旧的 1.3 必须被打红（它 11px，看着像够用，边界行仍会被削）
    const dir = block(".recent-path {").replace(/line-height:\s*[\d.]+/, "line-height: 1.3");
    expect(num(dir, "line-height"), "1.3 那一档是改之前的样子").not.toBe(SIDE_LH);
  });

  it("B329：撑高两截的同时把上下 padding 收掉，整行还是 38.5px（列表不许变胖）", () => {
    const row = block(".recent-row {");
    const name = block(".recent-name {");
    const dir = block(".recent-path {");
    const pad = num(row, "padding"); // shorthand 第一颗 = 上下
    const total = 2 * pad + SIDE_LH * num(name, "font-size") + SIDE_LH * num(dir, "font-size");
    expect(total, `整行 ${total}px：两截各 +1.8/+2.2，padding 没补就是 42.5`).toBeLessThanOrEqual(
      39,
    );
    // 同一把尺子量「只撑行盒不收 padding」的替身：42.5 必须被拒掉
    expect(
      2 * 4 + SIDE_LH * num(name, "font-size") + SIDE_LH * num(dir, "font-size"),
      "padding 留在 4px 那一档 = 每一行胖 4px",
    ).toBeGreaterThan(39);
  });
});

describe("B333 拖入文件夹换根：命令名两端 + 那一发接线", () => {
  it("`is_dir` 三处都在（Rust 定义 / 注册表 / 前端包装）—— 拼错任何一处都只是「拖了没反应」", () => {
    expect(rustCmds, "Rust 侧要有 pub fn is_dir").toContain("pub fn is_dir(");
    expect(rustMain, "忘了注册 ⇒ 前端 invoke 直接 reject").toContain("commands::explorer::is_dir,");
    expect(api, '前端包装要的正是 invoke<boolean>("is_dir"').toContain('invoke<boolean>("is_dir"');
  });

  it("主窗口把拖入的落点先问一遍资源管理器，**没认领**才交给原来那一路", () => {
    expect(boot).toContain("claimExplorerDrop(p.paths, pos.x, pos.y)");
    expect(boot, "认领了就别再走一遍：那会把目录当文件去读盘").toContain("if (!taken)");
    // 反向守卫：只 claim 不落地 = 拖文件到侧栏那一块以后什么都不做（静默失效最难查）。
    const claims = (boot.match(/claimExplorerDrop\(/g) ?? []).length;
    expect(claims, "这一发只该在主窗口的 drop 分支里问一次").toBe(1);
  });

  it("悬停亮带（B333-2）三点齐：样式画它、面板切它、主窗口把它挂到拖拽悬停上", () => {
    // 少任何一点都是「代码写了但屏幕上看不见」—— B314-8 那颗死键就是这一形。
    const exPanel = read("src/explorer/panel.ts");
    expect(css, "样式里要有那条亮带").toContain(".explorer-panel.is-drop-hover");
    expect(exPanel, "面板要真的切这个类").toContain('toggle("is-drop-hover"');
    expect(boot, "悬停回调里要点亮它").toContain("markExplorerDropHover(x, y)");
    expect(boot, "清场回调里要收掉它（否则会留在屏幕上）").toContain("clearExplorerDropHover()");
  });
});
