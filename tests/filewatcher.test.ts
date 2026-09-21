// @vitest-environment jsdom
// B87：文件监听 —— 外部修改要真的刷新内容（VS Code 三态 + 回声抑制）。
//
// 从 `tests/regressions.test.ts` 按模块拆出（09-22）。
// 「回声抑制」指：我们自己写盘也会触发文件变更事件，必须靠**磁盘版本号**认出那是自己的回声，
// 否则会把用户刚编辑的内容用刚写出去的旧内容覆盖回去。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripLineComments, topLevelFnBody } from "./static";

describe("B87 文件监听：外部修改要真的刷新内容（VS Code 三态 + 回声抑制）", () => {
  // 事故：M2 起就有 watcher，但前端收到 `file-changed` 只置了个 `doc.external = true`
  // 加一句状态栏提示 —— **内容一个字节都不刷新**。用户要求「打开的文档在别处被修改后，
  // 编辑器里的内容也进行刷新，两处都改也要处理好」。
  //
  // 按 VS Code 的语义复刻三态判定：
  //   ① 磁盘内容 == 内存内容  → 静默（外部只是重写了同样的字节，不该惊动用户）
  //   ② 编辑器没改过（clean） → 自动以磁盘为准重新载入（保留光标）
  //   ③ 两边都改过            → 弹三选一：保留我的修改 / 载入磁盘版本 / 打开磁盘版本对照
  //
  // 另有两个必须一并解决的坑，各占一条用例：
  //   · 回声：保存也会激起 file-changed（监听的是同一个文件），不抑制就「保存完立刻弹冲突」；
  //   · 匹配：监听登记的是 `fs::canonicalize` 之后的路径，`OpenedFile.path` 却是用户给的
  //     原始写法，两端比不出来 —— 这就是以前「提示时有时无」的根因，改成认 tabId。
  //
  // ⚠️ 下面所有断言都跑在 `stripLineComments` 之后：本段说明里就写着 `markDiskVersion`
  // 这类标识符，整份文件比对会让「挖掉真代码」也照样通过（假绿，B79 已踩过一次）。
  const main = stripLineComments(readFileSync("src/main.ts", "utf-8"));
  const api = stripLineComments(readFileSync("src/ipc/api.ts", "utf-8"));
  const rustCmds = stripLineComments(readFileSync("src-tauri/src/commands/mod.rs", "utf-8"));
  const rustMain = stripLineComments(readFileSync("src-tauri/src/main.rs", "utf-8"));
  const dialog = stripLineComments(readFileSync("src/shell/conflictdialog.ts", "utf-8"));

  const core = topLevelFnBody(
    main,
    "async function resolveExternalChangeCore(doc: Doc, payload: FileChangedPayload)",
  );
  const applyDisk = topLevelFnBody(
    main,
    "function applyDiskContent(doc: Doc, file: OpenedFile, mtimeMs: number, size: number)",
  );
  const handleFn = topLevelFnBody(main, "function handleFileChanged(payload: FileChangedPayload)");

  describe("A 档：磁盘版本号（回声抑制的唯一依据）", () => {
    it("OpenedFile / SavedFile 都要带 mtime_ms（保存后必须拿得到新版本）", () => {
      // ⚠️ 只断言「文件里出现过 mtime_ms」会假绿：open_file 给了、save_file 没给也照样命中。
      // 所以既按出现次数卡，也分别断言落进了对应的结构体里。
      expect((rustCmds.match(/pub mtime_ms: i64,/g) ?? []).length, "两个结构体各一个").toBe(2);

      const opened = rustCmds.slice(
        rustCmds.indexOf("pub struct OpenedFile"),
        rustCmds.indexOf("pub struct LossyChar"),
      );
      const saved = rustCmds.slice(
        rustCmds.indexOf("pub struct SavedFile"),
        rustCmds.indexOf("fn tab_info"),
      );
      expect(opened, "OpenedFile 必须带 mtime_ms").toContain("pub mtime_ms: i64,");
      expect(saved, "SavedFile 必须带 mtime_ms（否则保存后前端拿不到新版本）").toContain(
        "pub mtime_ms: i64,",
      );

      // 前端类型同步：少一个字段，`saved.mtimeMs` 就是 undefined，已知版本会被写成 undefined
      const openedTs = api.slice(
        api.indexOf("export interface OpenedFile"),
        api.indexOf("export interface FileChangedPayload"),
      );
      expect(openedTs, "前端 OpenedFile 必须有 mtimeMs").toContain("mtimeMs: number;");
      const savedTs = api.slice(
        api.indexOf("export interface SavedFile"),
        api.indexOf("export interface Settings"),
      );
      expect(savedTs, "前端 SavedFile 必须有 mtimeMs").toContain("mtimeMs: number;");
    });

    it("读盘 / 写盘之后都要真的取一次版本号", () => {
      expect(
        (rustCmds.match(/let \(mtime_ms, _\) = disk_version\(&target\);/g) ?? []).length,
        "open_file 与 save_file 各取一次",
      ).toBe(2);
      // 取不到 / 文件被删时回落 (0,0)：下次事件必然与 0 不同，于是不会被当成回声吞掉
      const ver = topLevelFnBody(rustCmds, "pub fn disk_version(path: &Path) -> (i64, u64)");
      expect(ver, "取不到 disk_version").toBeTruthy();
      expect(ver, "元数据读失败必须回落 (0, 0)").toMatch(/Err\(_\) => \(0, 0\)/);
    });

    it("每次落盘 / 读盘后前端都要更新已知版本（漏一次就是「保存完立刻弹冲突」）", () => {
      const save = topLevelFnBody(
        main,
        "async function saveDocCore(doc: Doc, inst: Tab, forceDialog: boolean)",
      );
      expect(save, "saveDocCore 必须更新已知版本").toContain(
        "markDiskVersion(doc, saved.mtimeMs, saved.size)",
      );

      // 自动保存走的是另一条路径（不起 saveDocCore），必须自己更新
      const auto = topLevelFnBody(main, "function scheduleAutosave(): void");
      expect(auto, "自动保存也必须更新已知版本").toContain(
        "markDiskVersion(doc, saved.mtimeMs, saved.size)",
      );
      // ⚠️ B88 起 save_file 的回包是「saved / conflict」联合体，所以这里接住的是
      //    `outcome` 而不是 `saved` —— 契约没变：自动保存必须接住返回值去刷新已知版本。
      expect(auto, "自动保存要接住 saveFile 的返回值").toContain("const outcome = await saveFile(");

      const open = topLevelFnBody(main, "async function doOpen(");
      expect(open, "打开文件后必须记下已知版本").toContain(
        "markDiskVersion(doc, file.mtimeMs, file.size)",
      );
    });

    it("回声抑制：事件版本 == 已知版本 时直接早退，且不排防抖", () => {
      expect(handleFn, "取不到 handleFileChanged").toBeTruthy();
      expect(handleFn, "必须比对已知磁盘版本（mtime + size 两个都要）").toMatch(
        /if \(payload\.mtimeMs === doc\.diskMtimeMs && payload\.size === doc\.diskSize\) return;/,
      );
      const guard = handleFn.indexOf("payload.size === doc.diskSize");
      const pending = handleFn.indexOf("externalPending.set(");
      expect(pending, "比通过了才排防抖").toBeGreaterThan(-1);
      expect(guard, "版本比对必须在排防抖之前（否则回声照样读盘 / 弹框）").toBeLessThan(pending);
    });
  });

  describe("B 档：事件认文档不认路径", () => {
    it("Rust 侧按规范化路径匹配到 doc，事件里带 tabId + 版本号", () => {
      const watcher = rustMain.slice(rustMain.indexOf("notify::recommended_watcher"));
      expect(watcher, "取不到 watcher 段").toBeTruthy();
      expect(watcher, "事件路径必须规范化后再比对").toContain(
        "std::fs::canonicalize(&path).unwrap_or(path.clone())",
      );
      expect(watcher, "匹配必须在 Rust 侧做完（它持有全部 doc）").toContain("d.path == norm");
      expect(watcher, "事件必须带 tabId").toMatch(/"tabId": tab_id/);
      expect(watcher, "事件必须带 mtimeMs").toMatch(/"mtimeMs": mtime_ms/);
      expect(watcher, "事件必须带 size").toMatch(/"size": size/);
      // ⚠️ 反向验证：以前只发 path，前端拿 `doc.path` 与之字符串比对 —— 一边是
      // canonicalize 过的、一边是用户给的原始写法，永远比不上（表现为「提示时有时无」）。
      expect(watcher, "不得再只发 path（前端比不出来）").not.toMatch(/"path": path/);
    });

    it("前端 handleFileChanged 不再按路径比对", () => {
      expect(handleFn, "必须按 tabId 取文档").toContain("docs.get(payload.tabId)");
      expect(handleFn, "不得再按路径字符串比对文档").not.toContain("toLowerCase()");
      // 文档被搬到卫星窗口后，本窗口只剩隐藏实例：两边都会收到事件，必须让对面处理
      expect(handleFn, "正主在别的窗口时必须让位（否则两个窗口各弹一个冲突框）").toContain(
        "remotedTabs.has(payload.tabId)",
      );
    });
  });

  describe("C 档：三态判定与冲突处理", () => {
    it("① 内容一致 → 静默；② clean → 自动载入；③ 都改 → 弹三选一", () => {
      expect(core, "取不到 resolveExternalChangeCore").toBeTruthy();

      const equal = core.indexOf("file.text === mine");
      const clean = core.indexOf("if (!doc.dirty)");
      const conflict = core.indexOf("showExternalConflictDialog(");
      expect(equal, "缺① 内容一致的静默分支").toBeGreaterThan(-1);
      expect(clean, "缺② clean 自动载入分支").toBeGreaterThan(-1);
      expect(conflict, "缺③ 冲突弹框分支").toBeGreaterThan(-1);
      expect(equal, "① 必须在最前：内容一样就什么都不该发生").toBeLessThan(clean);
      expect(clean, "② 必须在 ③ 之前：没改过就不该问用户").toBeLessThan(conflict);

      // ① 静默 = 不弹、不提示，只更新已知版本
      const equalBranch = core.slice(equal, clean);
      expect(equalBranch, "① 更新已知版本").toContain("markDiskVersion(");
      expect(equalBranch, "① 清掉 external 标记").toContain("doc.external = false;");
      expect(equalBranch, "① 不得弹框").not.toContain("showExternalConflictDialog");

      // ② 自动载入 = 换内容 + 提示（清脏在 applyDiskContent 里）
      const cleanBranch = core.slice(clean, conflict);
      expect(cleanBranch, "② 必须真的替换内容").toContain(
        "applyDiskContent(doc, file, mtimeMs, size)",
      );
      expect(cleanBranch, "② 必须给出提示，否则用户不知道内容被换了").toContain("showMessage(");
      expect(cleanBranch, "② 不得弹框").not.toContain("showExternalConflictDialog");
    });

    it("冲突框给出三选一，且默认分支绝不丢用户的修改", () => {
      expect(dialog, "keep-mine：保留我的修改").toContain('textContent = "保留我的修改"');
      expect(dialog, "take-disk：载入磁盘版本").toContain('textContent = "载入磁盘版本"');
      expect(dialog, "compare：打开磁盘版本对照").toContain('textContent = "打开磁盘版本对照"');
      expect(dialog, "Esc 兜底必须是 keep-mine（唯一不丢数据的一支）").toMatch(
        /e\.key === "Escape"[\s\S]{0,200}close\("keep-mine"\)/,
      );

      // keep-mine 绝不能碰内容：只有 take-disk 分支才调 applyDiskContent
      const tail = core.slice(core.indexOf('if (choice === "take-disk")'));
      expect(tail, "keep-mine 必须把「磁盘上有更新版本」记下来").toContain("doc.external = true;");
      expect(tail, "keep-mine 之后不得再替换内容").not.toMatch(
        /doc\.external = true;[\s\S]{0,400}applyDiskContent\(/,
      );
    });

    it("载入磁盘版本 = 内容以磁盘为准：清脏 + 作废热退出副本", () => {
      expect(applyDisk, "取不到 applyDiskContent").toBeTruthy();
      expect(applyDisk, "必须清脏").toContain("doc.dirty = false;");
      expect(applyDisk, "必须清 external").toContain("doc.external = false;");
      // ⚠️ 不清副本的话，下次启动会拿这份「已被放弃的未保存内容」顶掉刚载入的磁盘版本
      expect(applyDisk, "必须丢弃热退出副本").toContain("discardBackupFor(doc);");
      expect(applyDisk, "必须真的替换实例内容并保留光标").toContain(
        "rebuildDocInstances(doc, file.text, true)",
      );
    });

    it("防抖 + 不重入：一次保存会连着给好几个 Modify 事件", () => {
      expect(main, "必须有防抖窗口").toMatch(/const EXTERNAL_DEBOUNCE_MS = \d+;/);
      const resolve = topLevelFnBody(main, "async function resolveExternalChange(tabId: number)");
      expect(resolve, "取不到 resolveExternalChange").toBeTruthy();
      expect(
        resolve.indexOf("externalBusy.has(tabId)"),
        "必须有不重入守卫（否则读盘 / 等选择期间会叠出好几个弹框）",
      ).toBeGreaterThan(-1);
      expect(resolve, "处理中要把文档标记上").toContain("externalBusy.add(tabId);");
      expect(resolve, "结束必须解锁").toContain("externalBusy.delete(tabId);");
      // 弹框期间又来了事件 → 处理完接着处理，不能把最后一次丢了
      expect(resolve, "期间到达的新事件必须补处理").toMatch(
        /if \(externalPending\.has\(tabId\)\) void resolveExternalChange\(tabId\);/,
      );
    });
  });

  describe("D 档：外部刷新不该顺手改掉用户的编码 / 行尾", () => {
    it("重新载入必须带上当前编码（不指定时 open_file 会重新探测，把用户选的冲掉）", () => {
      expect(core, "reloadFile 必须传 doc.encoding").toMatch(
        /reloadFile\(doc\.tabId, doc\.encoding\)/,
      );
    });

    it("applyDiskContent 保留用户选的行尾", () => {
      expect(applyDisk, "先把行尾存下来").toContain("const eol = doc.eol;");
      expect(applyDisk, "再把行尾还原回去（外部刷新不是改行尾的场合）").toContain("doc.eol = eol;");
    });
  });
});
