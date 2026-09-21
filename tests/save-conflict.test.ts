// @vitest-environment jsdom
// B88：保存时的**脏写检查** —— 磁盘上的版本比我们读取时更新时，选择权必须交回用户
// （对齐 VS Code 的 FILE_MODIFIED_SINCE）。
//
// 从 `tests/regressions.test.ts` 按模块拆出（09-22）：根因横跨 Rust 写盘前比对、
// IPC 回包契约、前端四个分支与冲突框兜底，无法在运行时端到端断言，故用源码文本断言。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripLineComments, topLevelFnBody } from "./static";

describe("B88 保存时的脏写检查：磁盘版本更新要把选择权交回用户（VS Code FILE_MODIFIED_SINCE）", () => {
  // 需求：用户**主动保存**的瞬间，磁盘上的版本可能已经变了（事件还在防抖窗口里 /
  // 保存与别人的写入撞在一起 / 那一刻根本没在监听）。此时若照旧写盘，就是把别人
  // 刚写进去的内容无声盖掉 —— 而 B87 那条监听器路径覆盖不到这个时刻。
  //
  // VS Code 的做法：写操作自带「期望的版本号」（mtime+size），落盘前比对，不一致就
  // 抛 FILE_MODIFIED_SINCE —— **一个字节都不写**，弹框让用户选「对照 / 覆盖 / 载入」。
  // 本项目照此实现，并把检查放在 Rust 的 save_file **内、atomic_write 之前**：
  //   · 不能前端先查版本再调保存 —— 那会有「查完被改、写完盖掉」的窗口；
  //   · 冲突是**预期分支**（要弹框）而非异常，所以用 tagged enum 回传，不走 Err(String)。
  //
  // ⚠️ 所有断言都跑在 stripLineComments 之后：本段说明里就写着 expectMtimeMs 这类
  //    标识符，整份文件比对会让「挖掉真代码」也照样通过（假绿，B79 已踩过一次）。
  const main = stripLineComments(readFileSync("src/main.ts", "utf-8"));
  const api = stripLineComments(readFileSync("src/ipc/api.ts", "utf-8"));
  const rustCmds = stripLineComments(readFileSync("src-tauri/src/commands/mod.rs", "utf-8"));
  const dialog = stripLineComments(readFileSync("src/shell/conflictdialog.ts", "utf-8"));

  const saveFileRs = topLevelFnBody(rustCmds, "pub async fn save_file(");
  const saveCore = topLevelFnBody(
    main,
    "async function saveDocCore(doc: Doc, inst: Tab, forceDialog: boolean)",
  );
  const resolveSave = topLevelFnBody(main, "async function resolveSaveConflict(");
  const autosave = topLevelFnBody(main, "function scheduleAutosave()");
  const saveDialogFn = topLevelFnBody(dialog, "export function showSaveConflictDialog(");

  describe("A 档：Rust 写盘前的版本比对（不许先写后说）", () => {
    it("save_file 收「期望版本」并在写盘前比对，不一致就返回冲突", () => {
      expect(saveFileRs, "取不到 save_file").toBeTruthy();
      expect(saveFileRs, "必须收 expect_mtime_ms").toContain("expect_mtime_ms: Option<i64>,");
      expect(saveFileRs, "必须收 expect_size").toContain("expect_size: Option<u64>,");

      // ⚠️ 顺序是这条需求的命门：检查必须早于 atomic_write。
      // 写在后面就成了「先盖掉别人的内容，再报告冲突」—— 等于没有保护。
      const checkAt = saveFileRs.indexOf("is_stale(expect, current)");
      const writeAt = saveFileRs.indexOf("atomic_write::atomic_write");
      expect(checkAt, "找不到版本比对").toBeGreaterThan(-1);
      expect(writeAt, "找不到写盘调用").toBeGreaterThan(-1);
      expect(checkAt, "版本比对必须早于写盘").toBeLessThan(writeAt);
    });

    it("撞冲突时一个字节都不写：直接 return Conflict，不落到 atomic_write", () => {
      const conflictAt = saveFileRs.indexOf("return Ok(SaveOutcome::Conflict(");
      const writeAt = saveFileRs.indexOf("atomic_write::atomic_write");
      expect(conflictAt, "必须有冲突分支").toBeGreaterThan(-1);
      expect(conflictAt, "冲突必须提前返回（早于写盘）").toBeLessThan(writeAt);
    });

    it("只在目标存在时检查，force 为 true 时跳过（覆盖保存是用户的明确选择）", () => {
      // 文件被外部删掉时 disk_version 是 (0,0)，会被误判成「版本变了」；
      // 而正确行为是重建文件（用户的内容还在编辑器里）。
      const guard = saveFileRs.slice(saveFileRs.indexOf("force != Some(true)"));
      expect(guard.slice(0, 200), "检查必须限定在目标存在时").toContain("target.exists()");
      expect(saveFileRs, "force 时不检查").toContain("force != Some(true)");
    });

    it("半份基线不算基线：缺 mtime 或缺 size 都得退回不检查", () => {
      // 抽成纯函数是为了能单测（真实 save_file 依赖 AppState 与文件系统，测不动）
      expect(rustCmds, "expected_version 必须存在").toContain("fn expected_version(");
      expect(rustCmds, "is_stale 必须存在").toContain("fn is_stale(");
      expect(rustCmds, "没有已知版本时不做判断").toMatch(/None => false,/);
    });
  });

  describe("B 档：冲突是预期分支，不是异常（回包契约）", () => {
    it("SaveOutcome 用 tagged enum 区分 saved / conflict，不走 Err(String)", () => {
      // 走 Err 的话，前端只能靠匹配错误文案来分辨「冲突」与「真的写盘失败」，
      // 那种写法一改文案就断。
      expect(rustCmds, "必须是 tagged enum").toMatch(/#\[serde\(tag = "kind", content = "value"/);
      expect(rustCmds, "必须有 Saved 分支").toContain("Saved(SavedFile),");
      expect(rustCmds, "必须有 Conflict 分支").toContain("Conflict(SaveConflict),");
      expect(rustCmds, "save_file 的返回类型必须是 SaveOutcome").toMatch(
        /-> Result<SaveOutcome, String>/,
      );
    });

    it("前端按 kind 分派，且冲突字段名是 camelCase", () => {
      expect(api, "saved 分支").toMatch(/kind: "saved"; value: SavedFile/);
      expect(api, "conflict 分支").toMatch(/kind: "conflict"; value: SaveConflict/);
      const conflict = api.slice(api.indexOf("export interface SaveConflict"));
      expect(conflict.slice(0, 400), "diskMtimeMs 必须是 camelCase").toContain(
        "diskMtimeMs: number;",
      );
      expect(conflict.slice(0, 400), "diskSize 必须是 camelCase").toContain("diskSize: number;");
    });
  });

  describe("C 档：手动保存撞冲突 → 四个分支都不能自作主张", () => {
    it("保存时带上已知磁盘版本作为基线", () => {
      expect(saveCore, "必须传 expectMtimeMs").toContain("expectMtimeMs:");
      expect(saveCore, "必须传 expectSize").toContain("expectSize:");
    });

    it("只有原地保存才带基线：另存为不能拿旧文件的版本号去比对", () => {
      // 否则「另存为」到另一个文件时，会拿 A 的版本号去比对 B —— 凭空报一次冲突。
      expect(saveCore, "必须判定是否原地保存").toMatch(
        /const inPlace = !forceDialog && !!doc\.path && target === doc\.path;/,
      );
      expect(saveCore, "基线只在原地保存时启用").toMatch(
        /const hasBaseline = inPlace && doc\.diskMtimeMs > 0;/,
      );
    });

    it("撞冲突先问用户；只有选了覆盖才用 force 重存一次", () => {
      expect(saveCore, "必须识别 conflict").toMatch(/if \(outcome\.kind === "conflict"\)/);
      expect(saveCore, "必须把选择交回用户").toContain("resolveSaveConflict(doc, outcome.value)");
      // ⚠️ 关键：除「覆盖保存」外一律不写盘
      expect(saveCore, "除覆盖外都不写盘").toMatch(/!== "overwrite"\) return false;/);
      expect(saveCore, "覆盖时必须 force（否则会被自己的检查再拦一次）").toMatch(/force: true,/);
    });

    it("取消：既没写盘也没丢改动", () => {
      expect(resolveSave, "取不到 resolveSaveConflict").toBeTruthy();
      expect(resolveSave, "cancel 分支必须给出提示").toContain("已取消保存");
      expect(resolveSave, "cancel 返回 abort（调用方据此不写盘）").toContain('return "abort";');
    });

    it("载入磁盘版本：走 applyDiskContent（内容以磁盘为准），且不写盘", () => {
      const revertBranch = resolveSave.slice(resolveSave.indexOf('if (choice === "revert")'));
      // 与 B87 那条路径共用同一个函数 → 同样会清脏、清 external、作废热退出副本
      // ⚠️ 用正则而不是整串：prettier 会把超宽的多参数调用拆成多行，
      //    写死 "applyDiskContent(doc, file" 会在格式化之后假红（本条已实测踩过）。
      expect(revertBranch, "必须替换内容").toMatch(/applyDiskContent\(\s*doc,\s*file,/);
      expect(revertBranch, "revert 之后不写盘").toContain('return "abort";');
    });

    it("对照比较：开磁盘副本对照并刷新已知版本，当前文档一字不动", () => {
      const compareBranch = resolveSave.slice(resolveSave.indexOf('if (choice === "compare")'));
      expect(compareBranch, "必须开对照").toContain("openDiskCopyForCompare(doc, file)");
      expect(
        compareBranch,
        "刷新已知版本 → 之后保存是「看过之后的有意覆盖」，不该再弹一次",
      ).toContain("markDiskVersion(doc,");
    });
  });

  describe("D 档：自动保存既不能弹框，也不能替用户盖掉外部版本", () => {
    it("自动保存带基线，撞冲突静默跳过（不弹框、不写盘）", () => {
      expect(autosave, "必须传基线").toContain("expectMtimeMs:");
      // ⚠️ 本档命门：自动保存**不得**调 resolveSaveConflict —— 用户正打字时弹模态框
      //    是体验灾难，而替他盖掉外部的新版本是数据灾难。
      expect(autosave, "自动保存绝不弹冲突框").not.toContain("resolveSaveConflict");
      expect(autosave, "撞冲突就跳过这个文档").toMatch(
        /if \(outcome\.kind === "conflict"\) continue;/,
      );
    });
  });

  describe("E 档：保存冲突框的按钮与兜底", () => {
    it("给出覆盖 / 载入 / 对照三选一，Esc 兜底是取消（既不写盘也不丢改动）", () => {
      expect(saveDialogFn, "取不到 showSaveConflictDialog").toBeTruthy();
      expect(saveDialogFn, "覆盖保存").toContain('textContent = "覆盖保存"');
      expect(saveDialogFn, "载入磁盘版本").toContain('textContent = "载入磁盘版本"');
      expect(saveDialogFn, "对照比较").toContain('textContent = "对照比较"');
      expect(saveDialogFn, "Esc 必须取消（唯一既不写盘也不丢改动的一支）").toMatch(
        /e\.key === "Escape"[\s\S]{0,200}close\("cancel"\)/,
      );
    });

    it("焦点给「对照比较」：误触 Enter 也不能盖掉磁盘上的新版本", () => {
      expect(saveDialogFn, "焦点必须是非破坏性的那一支").toContain("compare.focus();");
      expect(saveDialogFn, "不得把焦点给覆盖保存").not.toContain("overwrite.focus();");
    });
  });
});
