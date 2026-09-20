// B88 反向验证：证明「保存时脏写检查」这批守卫真的会咬人，且不误伤。
//
// 需求的三条主线（每条至少一个探针）：
//   ① Rust 写盘前的版本比对
//        → 比对不再生效（永远不冲突 = 照旧盖掉别人的内容）判红
//        → force 不再跳过检查（用户选了覆盖又被自己拦一次）判红
//        → 去掉 target.exists() 限定（文件被删时误报冲突）判红
//        → 回包退回非 tagged enum（冲突与写盘失败又混在一起）判红
//   ② 前端四个分支都不能自作主张
//        → 保存不再带基线 判红
//        → 另存为也带基线（拿 A 的版本号去比对 B）判红
//        → 撞冲突不问用户直接写 判红
//        → 覆盖保存忘了 force 判红
//        → 自动保存改成弹框（打字时被打断）判红
//   ③ 冲突框的兜底
//        → Esc 兜底改成覆盖保存（误触 Esc 就盖掉磁盘新版本）判红
//        → 焦点给覆盖保存（误触 Enter 就盖掉）判红
//
// 反向对照（应**不**判红）：改与契约无关的文案 / 标题 → 必须仍然绿。
//
// ⚠️ 判据说明：这些守卫全是**文件内容断言**，所以探针的 `from` 片段必须**全文唯一命中**，
//    否则 String.replace 只换第一处，命中的若是无关处，判红判绿都不构成证据 → 该条硬失败。
//    每条结束立刻按字节还原，运行前后 sha256 必须一致。
//
// 铁律（同技能 litepad-reverse-verify）：不碰 .git。
//
// 用法：node scripts/reverse-verify-B88.cjs
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");

const MAIN = "src/main.ts";
const API = "src/ipc/api.ts";
const RUST = "src-tauri/src/commands/mod.rs";
const DIALOG = "src/shell/conflictdialog.ts";

const FILES = [MAIN, API, RUST, DIALOG];
const sources = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, "utf8")]));
const hashOf = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const originalHashes = Object.fromEntries(FILES.map((f) => [f, hashOf(sources[f])]));

const REG = "tests/regressions.test.ts";

function runVitest(file, filter) {
  try {
    execFileSync("node", ["scripts/run-vitest.cjs", file, "-t", filter], {
      stdio: "pipe",
      cwd: process.cwd(),
    });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

/** 唯一命中替换：命中数 ≠ 1 直接判定该探针无效（不是「绿」）。 */
function replaceOnce(src, from, to) {
  const parts = src.split(from);
  if (parts.length !== 2) {
    throw new Error(`from 片段命中 ${parts.length - 1} 次（必须恰好 1 次）：${from.slice(0, 60)}…`);
  }
  return parts.join(to);
}

const probes = [
  // ---- ① Rust 写盘前的版本比对 ----
  {
    name: "①-1 版本比对失效（永远不冲突 = 照旧盖掉别人的内容）",
    target: RUST,
    filter: "B88",
    expectRed: true,
    from: "if is_stale(expect, current) {",
    to: "if false {",
  },
  {
    name: "①-2 force 不再跳过检查（用户选了覆盖保存又被自己拦一次）",
    target: RUST,
    filter: "B88",
    expectRed: true,
    from: "if force != Some(true) && target.exists() {",
    to: "if target.exists() {",
  },
  {
    name: "①-3 去掉 target.exists() 限定（文件被外部删掉时误报冲突）",
    target: RUST,
    filter: "B88",
    expectRed: true,
    from: "if force != Some(true) && target.exists() {",
    to: "if force != Some(true) {",
  },
  {
    name: "①-4 回包退回非 tagged enum（冲突与真写盘失败又混在一起）",
    target: RUST,
    filter: "B88",
    expectRed: true,
    from: '#[serde(tag = "kind", content = "value", rename_all = "camelCase")]',
    to: '#[serde(rename_all = "camelCase")]',
  },
  {
    name: "①-5 冲突字段退回 snake_case（前端按 camelCase 读会恒为 undefined）",
    target: API,
    filter: "B88",
    expectRed: true,
    from: "  diskMtimeMs: number;",
    to: "  disk_mtime_ms: number;",
  },

  // ---- ② 前端四个分支 ----
  {
    name: "②-1 保存不再带基线（等于退回到「无脏写保护」）",
    target: MAIN,
    filter: "B88",
    expectRed: true,
    from: "      expectMtimeMs: hasBaseline ? doc.diskMtimeMs : null,\n",
    to: "",
  },
  {
    name: "②-2 另存为也带基线（拿旧文件的版本号去比对新目标，凭空报冲突）",
    target: MAIN,
    filter: "B88",
    expectRed: true,
    from: "const inPlace = !forceDialog && !!doc.path && target === doc.path;",
    to: "const inPlace = true;",
  },
  {
    name: "②-3 撞冲突不问用户直接写（把别人刚写进去的内容无声盖掉）",
    target: MAIN,
    filter: "B88",
    expectRed: true,
    from: 'if ((await resolveSaveConflict(doc, outcome.value)) !== "overwrite") return false;',
    to: "if (false) return false;",
  },
  {
    name: "②-4 覆盖保存忘了 force（重存时被自己的检查再拦一次，死循环）",
    target: MAIN,
    filter: "B88",
    expectRed: true,
    from: "        force: true,\n",
    to: "",
  },
  {
    name: "②-5 自动保存改成弹框（用户正打字时被模态框打断）",
    target: MAIN,
    filter: "B88",
    expectRed: true,
    from: 'if (outcome.kind === "conflict") continue;',
    to: 'if (outcome.kind === "conflict") { await resolveSaveConflict(doc, outcome.value); }',
  },

  // ---- ③ 冲突框的兜底 ----
  {
    name: "③-1 Esc 兜底改成覆盖保存（误触 Esc 就盖掉磁盘上的新版本）",
    target: DIALOG,
    filter: "B88",
    expectRed: true,
    from: '      if (e.key === "Escape") {\n        e.preventDefault();\n        close("cancel");\n      }',
    to: '      if (e.key === "Escape") {\n        e.preventDefault();\n        close("overwrite");\n      }',
  },
  {
    name: "③-2 焦点给覆盖保存（误触 Enter 就把外部版本盖掉）",
    target: DIALOG,
    filter: "B88",
    expectRed: true,
    from: "    compare.focus();",
    to: "    overwrite.focus();",
  },

  // ---- ④ 反向对照：与契约无关的改动不得误伤 ----
  {
    name: "④-1 反向对照：改冲突框的 Esc 提示文案（应不误伤）",
    target: DIALOG,
    filter: "B88",
    expectRed: false,
    from: 'hint.textContent = "按 Esc 取消本次保存（不会写盘，也不会丢弃你的修改）";',
    to: 'hint.textContent = "按 Esc 取消";',
  },
  {
    name: "④-2 反向对照：改冲突框标题文案（应不误伤）",
    target: DIALOG,
    filter: "B88",
    expectRed: false,
    from: 'title.textContent = "保存时发现磁盘上的内容更新了";',
    to: 'title.textContent = "保存冲突";',
  },
];

const results = [];
for (const p of probes) {
  const target = p.target;
  const original = sources[target];
  let code;
  let note = "";
  try {
    writeFileSync(target, replaceOnce(original, p.from, p.to), "utf8");
    code = runVitest(REG, p.filter);
  } catch (e) {
    code = null;
    note = `  ⚠ 探针无效：${e.message}`;
  } finally {
    writeFileSync(target, original, "utf8");
  }
  const isRed = code !== null && code !== 0;
  const ok = code !== null && isRed === p.expectRed;
  results.push(ok);
  const verdict = code === null ? "无效" : isRed ? "红" : "绿";
  console.log(
    `${ok ? "✓" : "✗"} ${p.name}: exit=${code} → ${verdict}（期望${p.expectRed ? "红" : "绿"}）${note}`,
  );
}

let restored = true;
for (const f of FILES) {
  const now = hashOf(readFileSync(f, "utf8"));
  const same = now === originalHashes[f];
  restored = restored && same;
  console.log(
    `还原校验 ${f}：sha256 ${same ? "一致" : "不一致（立即人工修！）"} ${now.slice(0, 12)}…`,
  );
}
console.log(`\n反向验证 B88: ${results.filter(Boolean).length}/${results.length} 通过`);

if (!restored) {
  console.error("✗ 文件未按字节还原，请先 git diff 检查");
  process.exit(1);
}
process.exit(results.every(Boolean) ? 0 : 1);
