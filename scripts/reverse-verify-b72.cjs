// B72 反向验证：把每处修复分别「还原」一次，确认对应用例真的会红。
// 用法：node scripts/reverse-verify-b72.cjs
//
// 铁律（照着做，别图省事）：
//   · 全程不碰 .git —— 备份/还原都在本进程内存里做，还原后按 sha256 自检，
//     任何一条不一致都会打印出来（本项目曾因操作 .git 丢掉过全部历史）。
//   · **红才是通过**：脚本绿灯说明那条守卫抓不到对应缺陷，必须回头改断言。
//   · Rust 那几条要跑 cargo（`runner: "cargo"`），增量编译约 1~2 min/条，能等就等 ——
//     单测夹具写对了但没人这么调、或断言只查了「函数存在」，都只有真跑才会露馅。
const { readFileSync, writeFileSync } = require("node:fs");
const { execSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf-8");
const write = (p, s) => writeFileSync(join(ROOT, p), s);
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

const CASES = [
  // ---------------------------------------------------------------- 整组影像药丸
  {
    name: "药丸锚点退回左上角（指针不再落在药丸内部）",
    file: "src/shell/splitview.ts",
    from: "const GHOST_ANCHOR_PILL = { x: 10, y: 10 };",
    to: "const GHOST_ANCHOR_PILL = { x: 0, y: 0 };",
    tests: ["tests/panel-group-drag.test.ts", "tests/regressions.test.ts"],
  },
  {
    name: "整组文案丢掉「其余数量」",
    file: "src/shell/splitview.ts",
    from: '  // 只有一个标签时不带计数（同 VS Code 的 `count > 1` 判据）\n  if (tabs.length > 1) {\n    const countEl = document.createElement("span");\n    countEl.className = "tab-drag-ghost-count";\n    countEl.textContent = ` (+${tabs.length - 1})`;\n    ghost.appendChild(countEl);\n  }\n',
    to: "",
    tests: ["tests/panel-group-drag.test.ts", "tests/regressions.test.ts"],
  },
  {
    name: "整组文案取第一个标签而不是活动标签",
    file: "src/shell/splitview.ts",
    from: '  const active = strip.querySelector<HTMLElement>(".tab.tab-active") ?? tabs[0] ?? null;\n',
    to: "  const active = tabs[0] ?? null;\n",
    tests: ["tests/panel-group-drag.test.ts"],
  },
  {
    name: "丢掉「名字读不出来」的兜底（会出现空药丸）",
    file: "src/shell/splitview.ts",
    from: "  // 名字读不出来（面板正在重建？）也别给一颗空药丸 —— 至少把数量说清楚\n  if (!name) {\n    nameEl.textContent = `${tabs.length} 个标签`;\n    return ghost;\n  }\n",
    to: "",
    tests: ["tests/panel-group-drag.test.ts"],
  },
  {
    name: "整组影像又退回「克隆整条标签栏」",
    file: "src/shell/splitview.ts",
    from: '  ghost.className = "tab-drag-ghost tab-drag-ghost-group";\n',
    to: '  ghost.className = "tab-drag-ghost tab-drag-ghost-group";\n  ghost.appendChild(strip.cloneNode(true));\n',
    tests: ["tests/panel-group-drag.test.ts", "tests/regressions.test.ts"],
  },
  {
    name: "单标签拖拽被药丸锚点带偏（收尾没复位锚点）",
    file: "src/shell/splitview.ts",
    from: "  dragGhost = null;\n  dragGhostAnchor = GHOST_ANCHOR_TAB;\n",
    to: "  dragGhost = null;\n",
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "名字 span 丢掉 min-width: 0（flex 下省略号静默不出现）",
    file: "src/styles/global.css",
    from: "  /* flex 子项默认 min-width: auto，不置 0 就不会真的收缩，省略号也不会出现 */\n  min-width: 0;\n",
    to: "",
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "计数 span 不再固定宽度（计数会被省略号一起吃掉）",
    file: "src/styles/global.css",
    // `flex: 0 0 auto;` 全文出现 16 次 → 必须连选择器一起写
    from: ".tab-drag-ghost-group .tab-drag-ghost-count {\n  flex: 0 0 auto;\n}",
    to: ".tab-drag-ghost-group .tab-drag-ghost-count {\n}",
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "名字 span 丢掉 text-overflow（超长文件名硬切）",
    file: "src/styles/global.css",
    // ⚠️ 片段必须带上下文：`overflow: hidden; text-overflow: ellipsis;` 在别处还有 2 处，
    //    只写那两行会被 replace 命中别处（判据失效 —— 脚本已把「出现多次」当失败处理）
    from: ".tab-drag-ghost-group .tab-drag-ghost-name {\n  overflow: hidden;\n  text-overflow: ellipsis;",
    to: ".tab-drag-ghost-group .tab-drag-ghost-name {\n  overflow: hidden;",
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "计数 span 挂错类名（名字与计数合流）",
    file: "src/shell/splitview.ts",
    from: '    countEl.className = "tab-drag-ghost-count";',
    to: '    countEl.className = "tab-drag-ghost-name";',
    tests: ["tests/regressions.test.ts"],
  },
  // ---------------------------------------------------------------- 卫星窗口（Rust）
  {
    name: "★建窗时不喂浏览器参数（B72 的真实根因）",
    file: "src-tauri/src/windows.rs",
    from: "    if let Some(args) = shared_browser_args(app) {\n        builder = builder.additional_browser_args(&args);\n    }\n",
    to: "",
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "把参数抄成字面量（会与 tauri.conf.json 漂移）",
    file: "src-tauri/src/windows.rs",
    from: "shared_browser_args(app)",
    to: 'Some("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu".into())',
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "取参数不看 main 条目（拿第一条就顶上去）",
    file: "src-tauri/src/windows.rs",
    from: "        .find(|w| w.label == MAIN_LABEL)\n        .or_else(|| windows.first())\n",
    to: "        .first()\n",
    runner: "cargo",
    tests: ["windows::tests::browser_args_follow_the_main_window"],
  },
  // ---------------------------------------------------------------- 失败可诊断
  {
    name: "启动自检不再记录实际生效的浏览器参数",
    file: "src-tauri/src/main.rs",
    from: '            commands::smoke_log(&format!(\n                "browser args = {:?}",\n                windows::shared_browser_args(app.handle())\n            ));\n',
    to: "",
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "失败原因又只存 label 不存 message",
    file: "src/main.ts",
    from: '    failedLabels.set(l, e.payload?.message ?? "");',
    to: "    void l;",
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "提示退回「吞掉原因」的固定文案",
    file: "src/main.ts",
    from: '      const detail = why ? `：${why}` : "：等待新窗口就绪超时";\n',
    to: '      const detail = "";\n',
    tests: ["tests/regressions.test.ts"],
  },
];

function runVitest(files) {
  try {
    execSync(`node scripts/run-vitest.cjs ${files.join(" ")}`, {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 300000,
    });
    return true; // 全绿
  } catch {
    return false; // 有红
  }
}

function runCargo(filters) {
  const path = [
    "C:/Users/maoyu/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin",
    "C:/msys64/mingw64/bin",
    "C:/Users/maoyu/.cargo/bin",
    "C:/WINDOWS/System32",
    process.env.PATH,
  ].join(";");
  try {
    execSync(`cargo test ${filters.join(" ")}`, {
      cwd: join(ROOT, "src-tauri"),
      stdio: "pipe",
      timeout: 900000,
      env: { ...process.env, PATH: path },
    });
    return true;
  } catch {
    return false;
  }
}

let bad = 0;
let n = 0;
let broken = 0;
for (const c of CASES) {
  const orig = read(c.file);
  const origHash = sha(orig);
  if (!orig.includes(c.from)) {
    console.log(`✗ ${c.name} —— 源码里找不到要替换的片段（判据失效）`);
    bad++;
    continue;
  }
  if (orig.split(c.from).length - 1 !== 1) {
    // ⚠️ 出现多次 = 判据失效（replace 只会改第一处，可能改的根本不是这条修复的地方，
    //    于是「绿」既不能证明守卫有效、也不能证明它无效）→ 直接当失败，别放过
    console.log(`✗ ${c.name} —— 替换片段出现 ${orig.split(c.from).length - 1} 次，判据失效`);
    bad++;
    continue;
  }
  try {
    write(c.file, orig.replace(c.from, c.to));
    const green = c.runner === "cargo" ? runCargo(c.tests) : runVitest(c.tests);
    n++;
    console.log(`${green ? "✗ 无效守卫" : "✓ 会变红"}  ${c.name}`);
    if (green) bad++;
  } finally {
    write(c.file, orig);
    // 还原必须**逐字节一致**，否则「验证」本身就在破坏工作区
    if (sha(read(c.file)) !== origHash) {
      console.log(`✗ ${c.name} —— 还原后与原文不一致，请手工检查 ${c.file}`);
      broken++;
    }
  }
}

console.log(
  bad === 0 && broken === 0
    ? `\n${n}/${CASES.length} 条用例都能真正抓到对应缺陷，文件均已逐字节还原。`
    : `\n有 ${bad} 条守卫无效、${broken} 处还原不一致。`,
);
process.exit(bad === 0 && broken === 0 ? 0 : 1);
