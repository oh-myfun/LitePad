// @vitest-environment node
// B314 · 资源管理器的**跨层契约**。
//
// 这里钉的全是「跨语言 / 跨文件、jsdom 跑不到」的那几条：命令名两端要一字不差、DOM id
// 要三处同时存在、`[hidden]` 的兜底必须在样式表里（jsdom 不跑样式级联，测不出
// `display: flex` 把 `[hidden]` 压过去）。行为本身在 tests/explorer-panel.test.ts 与
// tests/explorer-store.test.ts 里用真骨架跑，不在这里重复。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fnBody, ruleBlock } from "./static";

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

// B424：`explorer-refresh` 不在这份名单里了 —— 刷新从头部搬进**每一根那一行**（由 JS 现造，
// 所以它既没有骨架 id，也不该有：头部只留「过滤 / 打开文件夹 / 全部折叠」三颗）。
// B429：新建两颗也跟着搬进根行（刷新键左边）；头部那颗过滤键开合下面那条过滤框。
const IDS = [
  "side-explorer",
  "explorer-panel",
  "explorer-title",
  "explorer-tree",
  "explorer-filter-toggle",
  "explorer-filter",
  "explorer-open",
  "explorer-collapse",
];

describe("B314 资源管理器跨层契约", () => {
  it("IPC 命令名两端都在：三条基础 + 四条写操作 + is_dir + set_doc_path", () => {
    // 拼错一个字母不会有任何报错，只会「树是空的 / 拖了没反应 / 改名后旧文件被写回来」。
    const table: [string, string][] = [
      ["list_dir", "commands::explorer::"],
      ["create_file", "commands::explorer::"],
      ["create_dir", "commands::explorer::"],
      ["rename_entry", "commands::explorer::"],
      ["copy_entry", "commands::explorer::"],
      ["move_entry", "commands::explorer::"],
      ["delete_entry", "commands::explorer::"],
      ["is_dir", "commands::explorer::"],
    ];
    for (const [name, owner] of table) {
      expect(rustCmds, `Rust 侧要 pub fn ${name}`).toContain(`pub fn ${name}(`);
      expect(rustMain, `${name} 必须注册进 generate_handler`).toContain(`${owner}${name},`);
      expect(api, `前端要 invoke("${name}")`).toContain(`"${name}"`);
    }
    // 后端那份文档记录的路径：**自动保存回落的就是它**。
    const rustMod = read("src-tauri/src/commands/mod.rs");
    expect(rustMod, "Rust 侧要 pub fn set_doc_path").toContain("pub fn set_doc_path(");
    expect(rustMain, "set_doc_path 必须注册").toContain("commands::set_doc_path,");
    expect(api, '前端要 invoke("set_doc_path")').toContain(`"set_doc_path"`);
    // 反向自证：把注册行删掉之后，上面那条判据必须落空
    const degraded = rustMain.replace("commands::explorer::list_dir,", "");
    expect(degraded, "退化串要先自证原句还在").not.toContain("commands::explorer::list_dir,");
  });

  it("模块不能叫 `fs`：commands/mod.rs 自己 `use std::fs`，同名会撞 E0255", () => {
    expect(rustCmds.includes("pub fn list_dir"), "内核在 explorer.rs").toBe(true);
    expect(read("src-tauri/src/commands/mod.rs")).toContain("pub mod explorer;");
    expect(read("src-tauri/src/commands/mod.rs")).not.toMatch(/^pub mod fs;/m);
  });

  it("`folder_roots` 两栈都有、默认空表；老单根字段只读不写（迁移一次，删掉的根不许复活）", () => {
    expect(api, "前端 Settings 要有 folder_roots").toContain("folder_roots: string[];");
    expect(rustSettings, "Rust Settings 要有 folder_roots").toContain(
      "pub folder_roots: Vec<String>",
    );
    expect(rustSettings, "缺这格必须回落空表（不许整体读失败）").toContain(
      "#[serde(default)]\n    pub folder_roots",
    );
    expect(rustSettings, "默认必须是空表（没开文件夹）").toContain("folder_roots: Vec::new()");

    expect(rustSettings, "老字段还得留着（要读得进旧配置）").toContain("pub folder_root: String");
    expect(rustSettings, "但空串时不能再落盘（否则移除全部目录会被自己写回去）").toContain(
      '#[serde(skip_serializing_if = "String::is_empty")]\n    pub folder_root',
    );
    expect(rustSettings, "load() 要过一遍迁移").toContain("return migrated(settings)");
    expect(rustSettings, "迁移是老值进表 + 清掉老字段").toContain(
      "s.folder_roots = vec![std::mem::take(&mut s.folder_root)];",
    );
    expect(api, "前端不再认识老字段（类型里没有它）").not.toContain("folder_root: string;");
  });

  it("DOM id 三处齐全：骨架里有、ui.ts 取了、也导出了", () => {
    const pairs: [string, string][] = [
      ["side-explorer", "sideExplorer"],
      ["explorer-panel", "explorerPanel"],
      ["explorer-title", "explorerTitle"],
      ["explorer-tree", "explorerTree"],
      ["explorer-filter-toggle", "explorerFilterToggle"],
      ["explorer-filter", "explorerFilter"],
      ["explorer-open", "explorerOpen"],
      ["explorer-collapse", "explorerCollapse"],
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
  });

  it("外壳认得每一块：类型、回落判据、回放都要跟着走", () => {
    // B314 加 explorer、B389 加 search、B461 加 diff：白名单漏一格的后果不是报错，而是
    // **静默回落大纲**（用户上次开着搜索，下次启动开的是大纲，而 `drawer_view` 照旧写着一串没人认的值）。
    // ⚠️ 判据按「每一员都在白名单里」的形状写，不钉整行原文：那一行会随名单增长被 prettier
    //    折行（B461 这一发就折了），钉原文的退化构造于是悄悄空转（改名单反而测不到）。
    expect(api, "DrawerViewName 要有 explorer / search / diff").toContain(
      `"toc" | "recent" | "explorer" | "search" | "diff"`,
    );
    const guard = /function viewFromSetting[\s\S]*?\n\}/.exec(drawer)?.[0] ?? "";
    for (const n of ["explorer", "search", "diff"]) {
      expect(guard, `白名单必须认 ${n}（漏一格就是静默回落大纲）`).toContain(`raw === "${n}"`);
    }
    // 反向：摘掉 search 那一格 ⇒ 上面那条必须落空。
    // ⚠️ 按**行**摘（名单一长 prettier 就把 `||` 折到下一行），不按整句原文替换 ——
    //    钉原文的退化构造会在名单增长那天悄悄空转（B461 这一发就踩到）。
    const degraded = guard.replace(/^\s*raw === "search" \|\|\n/m, "");
    expect(degraded, "退化串要先自证原句还在").not.toBe(guard);
    expect(degraded, "退化掉的白名单不认 search ⇒ 判据必须落空").not.toContain('raw === "search"');
    expect(rustSettings, "Rust 那侧 drawer_view 仍是一串，不校验枚举").toContain(
      "pub drawer_view: String",
    );
  });

  it("各块视图各自挂自己那颗按钮的点击（登记 ≠ 挂线，真机抓到过漏挂）", () => {
    // `registerDrawerView` 只管「显隐与亮灭怎么算」，点击监听归各视图自己挂。
    // 漏挂的表现是「那颗键看着正常、点下去毫无反应」，而 jsdom 那侧全是
    // 「程序里调 setDrawer 再断言亮灭」，照不出来 ⇒ 这一条按源码串钉住每一块。
    const wiring: [string, string][] = [
      ["src/toc.ts", "sideOutline"],
      ["src/recents/panel.ts", "sideRecent"],
      ["src/explorer/panel.ts", "sideExplorer"],
      // B389：搜索那颗（真机抓过 B314-8 的死键，这一条就是为了让它不能再发生一次）
      ["src/search/panel.ts", "sideSearch"],
      // B461：第五块「差异」那颗 —— 同一族的死键风险，名单跟着视图数长
      ["src/diff/panel.ts", "sideDiff"],
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

  it("B331「移除全部目录」四条入口齐全，且没开目录时置灰（B424 只改文案不改命令 id）", () => {
    // 菜单位置：紧跟在「打开文件夹」后面 —— 这两颗是一对，隔开了就找不到「关掉」在哪。
    const openAt = menubar.indexOf('withKey("打开文件夹"');
    const closeAt = menubar.indexOf('withKey("移除全部目录"');
    expect(openAt, "取不到「打开文件夹」那一条").toBeGreaterThanOrEqual(0);
    expect(closeAt, "文件菜单缺「移除全部目录」").toBeGreaterThan(openAt);
    // 置灰判据：无根时点亮它 = 「关掉一个没开着的文件夹」，还会顺手把盘上那一格写空。
    const item = menubar.slice(closeAt, closeAt + 220);
    expect(item, "无根时不许点亮").toMatch(/disabled:\s*!cb\.hasFolderRoot\(\)/);
    expect(
      item,
      "onSelect 只许走 panel.closeFolder（换根三件事的漏斗在那边，别在菜单里再写一份）",
    ).toMatch(/onSelect:\s*cb\.onCloseFolder/);
    // B424：文案可以改，命令 id 不许改 —— 用户自己配过的键位覆盖按 id 认，改了就成了哑键。
    expect(item, "菜单那一颗问的仍是 file.closeFolder 的键位").toContain(
      'cb.keyHint("file.closeFolder")',
    );
    expect(keymap, "命令表里的 label 跟着文案走").toContain(`label: "移除全部目录"`);
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
    expect(boot.indexOf("setExplorerRoots(folderRoots)"), "根要在登记之后才搬").toBeGreaterThan(at);
    expect(boot.slice(at, at + 600), "空表不发读盘").toContain("if (folderRoots.length > 0)");
    expect(boot, "启动回放走 store.setRoots，不走会落盘的 addFolder").toContain(
      "setExplorerRoots(folderRoots)",
    );
    expect(boot, "openFolder 那条才是会写设置的，启动期不许用").not.toMatch(
      /setupExplorer\(\);[\s\S]{0,400}[^p]openFolder\(/,
    );
  });

  it("打开文件夹之后要落盘、且顺手把这一块摊开（VS Code 的口径）", () => {
    const panel = read("src/explorer/panel.ts");
    expect(panel, "换根要写 settings.folder_roots").toContain("settings.folder_roots =");
    expect(panel, "写完要落盘").toContain("saveSettings(settings)");
    expect(panel, "选完文件夹就把这一块摊开").toContain(`setDrawer("explorer")`);
    expect(panel, "子窗口空转（藏在 display:none 里开一块 = 死键 + 脏落盘）").toContain(
      'if (windowKind === "satellite") return;',
    );
  });
});

describe("B315 路径改写的跨层契约", () => {
  const paths = read("src/explorer/paths.ts");

  it("`destDir` / `newName` 这类跨语言参数名要逐字对上 Rust 的下划线写法", () => {
    expect(api).toContain(`invoke<FsEntry>("rename_entry", { root, path, newName })`);
    expect(api).toContain(`invoke<FsEntry>("copy_entry", { root, src, destDir, destRoot })`);
    expect(api).toContain(`invoke<FsEntry>("move_entry", { root, src, destDir, destRoot })`);
    expect(rustCmds).toContain("new_name: String");
    expect(rustCmds).toContain("dest_dir: String");
    // B427：目标层自己那根锚点。少一端的表现是「参数是 undefined」——
    // Rust 收不到 `dest_root` 就直接按界外拒，用户只看见粘贴失败。
    expect(rustCmds).toContain("dest_root: String");
    for (const fn of ["copy_entry", "move_entry"]) {
      const at = rustCmds.indexOf(`pub fn ${fn}(`);
      expect(at, `Rust 侧要 pub fn ${fn}`).toBeGreaterThan(-1);
      expect(rustCmds.slice(at, at + 260), `${fn} 要收 dest_root`).toContain("dest_root: String");
    }
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

  it("顶部那一排：过滤 → 加一根 → 整理这棵树（B429 起新建两颗在根行，刷新同理）", () => {
    const order = ["explorer-filter-toggle", "explorer-open", "explorer-collapse"];
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
    // 自证判据有鉴别力：把过滤键抹掉，上面那条必须落空
    expect(inOrder(html.replace('id="explorer-filter-toggle"', 'id="explorer-zzz"'))).toBe(false);
    // 反向闸：头部那一排不许还挂着一颗刷新 / 新建 —— 多根之后它们的主语是某一根，
    // 长在那一行上（点哪根刷哪根、建进哪根）。一颗没有主语的键只能猜目标，猜哪根都不对。
    // ⚠️ 先抹掉 HTML 注释：上面那段散文里「新建」「刷新」都出现了，留着它这条就能被喂假。
    // B427 起头部下面多了一条过滤框（`class="explorer-filter"`）—— 切片止在它那里，
    // 否则过滤框里那六颗开关会被数进「头部那一排」。
    const head = html
      .slice(html.indexOf('class="explorer-head"'), html.indexOf('class="explorer-filter"'))
      .replace(/<!--[\s\S]*?-->/g, "");
    expect(head, "头部的刷新 / 新建键都已搬进每一根那一行").not.toMatch(/刷新|新建/);
    expect(head.match(/<button/g) ?? [], "头部就是三颗键").toHaveLength(3);
  });

  it("B424/B429：刷新与新建都搬进每一根那一行，而打开键常驻头部（键的主语各归各）", () => {
    const panel = read("src/explorer/panel.ts");
    // 1) 每根一行、每根自带一组动作：新建文件 / 新建目录 / 刷新的主语就是它所在那一根。
    expect(panel, "根行要挂右侧动作组").toMatch(
      /el\.append\(\s*rt,\s*rn,\s*rootActions\(root\)\s*\)/,
    );
    const actions = fnBody(panel, "rootActions");
    expect(actions, "动作组要取到").toContain("explorer-root-actions");
    expect(actions.indexOf('rootCreateBtn(root, "file")'), "新建文件在最左").toBeGreaterThan(-1);
    expect(actions.indexOf('rootCreateBtn(root, "dir")'), "新建目录居中").toBeGreaterThan(
      actions.indexOf('rootCreateBtn(root, "file")'),
    );
    expect(actions.indexOf("rootRefreshBtn(root)"), "刷新在最右（用户点名的位置）").toBeGreaterThan(
      actions.indexOf('rootCreateBtn(root, "dir")'),
    );
    expect(panel, "那颗键刷的是这一根（不是整棵树）").toContain("refreshRoot(root)");
    expect(panel, "新建的目标是根行自己那一根（不是当下选中的那一行）").toContain(
      "startCreate(kind, root)",
    );
    expect(panel, "逐根画行：名单顺序 = 屏幕顺序").toContain(
      "explorerTree.append(rootRow(root, open), rootChildren(root, open))",
    );
    // 2) 头部那颗「打开文件夹」从此常驻（不再被搬来搬去），且它是**多选 + 追加**。
    expect(panel, "打开键挂在头部那颗上").toContain(
      'explorerOpen.addEventListener("click", () => void promptOpenFolder())',
    );
    expect(panel, "目录选择器要开多选（一次加几根是常态）").toContain(
      "openDialog({ directory: true, multiple: true })",
    );
    // 3) 那组键贴右浮在名字上面、默认藏起来，悬停根行（或焦点在行内）才显形。
    //    不用 margin-left:auto 常驻占位：名字那截的省略号会提前一截、换档时整行文字跟着跳。
    const box = ruleBlock(css, ".explorer-root-actions");
    expect(box, "取不到根行动作组").toBeTruthy();
    expect(box).toMatch(/position:\s*absolute/);
    expect(box).toMatch(/right:\s*6px/);
    expect(box, "按钮区不自带底色（用户点名：行自己的底色已经够了）").not.toMatch(/background\s*:/);
    expect(box, "默认不显形").toMatch(/visibility:\s*hidden/);
    expect(css, "悬停根行 / 焦点在行内才显形").toMatch(
      /\.explorer-root:hover \.explorer-root-actions,\s*\.explorer-root:focus-within \.explorer-root-actions\s*\{[^}]*visibility:\s*visible/,
    );
    // 4) 树是**委托**点击（`explorerTree.addEventListener("click", onRowClick)`），按钮搬进来
    //    之后一发点击会同时命中「刷新这一根」与「折叠根」两件事 ⇒ 委托那一路必须先挡掉按钮。
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
    // 5) 根行右键菜单的两条新增项：刷新这一根 + 从名单里摘掉这一根。
    const rootMenu = panel.slice(
      panel.indexOf('label: "刷新该文件夹"'),
      panel.indexOf('label: "刷新该文件夹"') + 400,
    );
    expect(rootMenu, "「移除目录」紧跟着「刷新该文件夹」").toContain('label: "移除目录"');
    expect(rootMenu, "移除走的是 panel.removeFolder，不在菜单里另写一份").toContain(
      "removeFolder(path)",
    );
  });

  it("B429：头部过滤键开合过滤框，收起时清空（不留看不见的过滤）", () => {
    const panel = read("src/explorer/panel.ts");
    expect(panel, "头部那颗要挂点击").toContain(
      'explorerFilterToggle.addEventListener("click", () => setFilterShown(explorerFilter.hidden))',
    );
    expect(panel, "装配时就按收起态同步一次").toContain("setFilterShown(false)");
    // 收起 = 写 hidden + aria-expanded + 清字：三件缺一条都会留下「看得见树、但树是假的」。
    const body = fnBody(panel, "setFilterShown");
    expect(body).toContain("explorerFilter.hidden = !shown");
    expect(body).toContain('explorerFilterToggle.setAttribute("aria-expanded", String(shown))');
    expect(body, "收起时清空文字（否则过滤仍生效、框却藏了）").toContain('setFilterText("")');
    // 作者样式表的 display:flex 会压过 UA 的 [hidden]，必须显式兜底（jsdom 跑不出级联）。
    const hidden = ruleBlock(css, ".explorer-filter[hidden]");
    expect(hidden, "过滤框收起要有 display:none 兜底").toMatch(/display:\s*none/);
    // 从根行新建时先收起过滤：命中树里没有输入框的容身之处，否则点下去毫无反应。
    const create = fnBody(panel, "startCreate");
    expect(create, "过滤态里点新建要先收起过滤").toContain("setFilterShown(false)");
    expect(create, "根行按钮带进来的目标是根自己").toContain("dirOverride ?? targetDir()");
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
  const panel = read("src/explorer/panel.ts");

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
});

// B328/B329 的省略号下伸部、B318 输入框同形都属于纯 CSS 版式口径（不影响跨层契约），
// 已按仓库既定口径从本文件删除；输入框的那几条视觉规则由样式真机验收覆盖。

describe("B370/B373 资源管理器行对齐 VS Code 的 Seti 树", () => {
  // Seti 的像素量（8px 缩进、22px 槽、行高、选中底色、引导线）属于纯 CSS 版式口径，
  // 已从本文件删除；这里只留「行内结构怎么搭」这条跨层契约。

  it("目录行不再写 codicon 文件夹；文件行仍走 Seti，且不再垫空箭头槽", () => {
    const panel = read("src/explorer/panel.ts");
    expect(panel, "目录行 / 根行的 folder 字形已撤").not.toMatch(/CODICONS\.folder\b/);
    expect(panel, "根行只剩箭头 + 名字 + 右侧动作组（B424/B429）").toContain(
      "el.append(rt, rn, rootActions(root))",
    );
    // B427：画行抽成了 `rowOf(path, name, …)`（常规树与过滤结果共用一份几何）。
    // 图标解析改走 `fileIconHtmlOfFile`：VS Code 先查 Seti 的 fileNames / fileExtensions，
    // 查不到才按语言检测回落 —— 资源管理器里图片/视频/音频与 package/锁文件才有专属字形。
    expect(panel, "文件行按文件名走 Seti 两档解析").toContain("fileIconHtmlOfFile(name)");
    // 一行只放一格 22px 槽：目录行是箭头、文件行是图标 —— 文件行不再垫空箭头槽。
    expect(panel, "文件行与目录行各自只放一格 22px 槽").toContain(
      'slot.className = kind === "dir" ? "explorer-twisty" : "explorer-glyph"',
    );
    // 缩进引导线的数量口径由面板决定：深度 d 画 d-1 根（顶层没有线，根不画）。
    expect(panel).toContain("for (let i = 0; i < depth - 1; i++)");
    expect(panel).toContain("if (depth <= 1) return null");
  });
});

describe("B333 拖入文件夹换根：命令名两端 + 那一发接线", () => {
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

// B428 · 用户三条：过滤框只留一颗「排除设置与忽略文件」、输入框要看得见边框、
// 过滤态顶部那颗折叠键要真的收/开命中树。行为在 panel 测试里走真事件，这里钉样式与静态接线。
describe("B428 过滤框：一颗排除键 + 看得见的边框 + 折叠键按命中树算", () => {
  const panel = read("src/explorer/panel.ts");

  it("「跟随 .gitignore / .ignore」那颗并进了「使用排除设置与忽略文件」，三处一起消失", () => {
    expect(html, "骨架里不许再有第二颗").not.toContain('id="explorer-filter-ignores"');
    expect(ui, "ui refs 不许再交出来").not.toContain("explorerFilterIgnores");
    expect(panel, "面板不许再接线").not.toContain("explorerFilterIgnores");
    // 留下的那颗仍写着**完整语义**（提示与 aria 同文；「包含了右边跟随 ignore」是用户点名的）
    const start = html.indexOf('id="explorer-filter-excludes"');
    const btn = html.slice(start, html.indexOf('id="explorer-filter-clear"', start));
    expect(btn, "取不到那颗排除键").toContain('data-tip="使用排除设置与忽略文件"');
    expect(btn).toContain('aria-label="使用排除设置与忽略文件"');
  });

  it("过滤态那颗折叠键走 `filterCollapsed` 那一册（不许去动常规树的 expand 缓存）", () => {
    const body = fnBody(panel, "collapseAllHere");
    expect(body, "没找到 collapseAllHere").toContain("filterOn()");
    expect(body, "过滤态收的是命中树").toContain("filterCollapsed");
  });
});
