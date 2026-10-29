// B313 · 双击关联文件（应用已在运行）⇒ 主窗口要回到前台，并切到对应标签。
//
// 静态契约测：窗口激活是 Win32 的事，vitest 里驱动不了事件循环，所以这里钉的是
// **调用序列**（少一句、或顺序错了就红），真机那一面交给日志与手工复现。
// 口径同 tests/side-resizer.test.ts 里「函数体形状 + 退化串自证」那一族。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const main = readFileSync("src-tauri/src/main.rs", "utf-8").replace(/\r\n/g, "\n");
const files = readFileSync("src/io/files.ts", "utf-8").replace(/\r\n/g, "\n");
const boot = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");

/** 单实例回调那一段（B408 起回调抽成具名函数：从 `fn on_second_instance` 到 emit 为止）。 */
function callbackBody(): string {
  const i = main.indexOf("fn on_second_instance(");
  expect(i, "单实例回调必须还在（否则装了插件也没人接路径）").toBeGreaterThan(-1);
  const j = main.indexOf('app.emit("open-file"', i);
  expect(j, "回调末尾要广播 open-file").toBeGreaterThan(i);
  return main.slice(i, j);
}

describe("B313 双击关联文件：主窗口回前台", () => {
  it("入队 → 还原 → 显示 → 排队补焦点 → 广播，五步都在且次序对", () => {
    // B408 起插件注册在「非多开」那一路：多开模式不装它（dev 构建默认多开）
    expect(main, "单实例那一路仍要装插件并接上同一个回调").toContain(
      "builder.plugin(tauri_plugin_single_instance::init(on_second_instance))",
    );
    const body = callbackBody();
    const at = (needle: string, why: string): number => {
      const k = body.indexOf(needle);
      expect(k, why).toBeGreaterThan(-1);
      return k;
    };
    const iPush = at(
      "commands::push_pending_files(",
      "路径必须先进待打开队列（事件只当「来活了」）",
    );
    const iUnmin = at("win.unminimize()", "最小化时 show/set_focus 都不还原 ⇒ 窗口留在任务栏");
    const iShow = at("win.show()", "被藏起来的窗口要放回可见态");
    const iQueued = at("win.run_on_main_thread(", "焦点要排在 unminimize 之后落地");
    const iFocus = at("later.set_focus()", "排队那一发才是真的抢前台");
    expect(iPush, "入队排在还原之前（先接住路径，窗口动作不许把它弄丢）").toBeLessThan(iUnmin);
    expect(iUnmin, "先还原再谈可见").toBeLessThan(iShow);
    expect(iShow, "可见之后才补焦点").toBeLessThan(iQueued);
    expect(iQueued, "闭包里才 set_focus（此刻缓存标记已清）").toBeLessThan(iFocus);
  });

  it("反向验证：退回「show + 同步 set_focus」的老写法必须被咬住", () => {
    // 老写法在最小化时是**空操作**（tao 的守卫要求 !minimized），这正是用户报的症状。
    // 判据先自证有鉴别力：把当前实现改回老写法，第一条必须落空。
    const body = callbackBody();
    const ORIG = "let _ = win.unminimize();\n        let _ = win.show();";
    expect(body, "退化串要先自证原句还在").toContain(ORIG);
    const oldShape = body
      .replace(ORIG, "let _ = win.show();")
      .replace(/let later = win\.clone\(\);[\s\S]*?\}\);/, "");
    const i = (s: string): number => oldShape.indexOf(s);
    expect(i("win.unminimize()"), "老写法不该还留着还原").toBe(-1);
    expect(i("win.run_on_main_thread("), "老写法不该还留着排队焦点").toBe(-1);
    expect(i("win.show()"), "show 还在（老写法就剩这一句 + 一句同步 set_focus）").toBeGreaterThan(
      -1,
    );
  });

  it("找不到主窗口时要留一行日志（「双击没反应」唯一的线索）", () => {
    const body = main.slice(main.indexOf("fn on_second_instance("));
    const tail = body.slice(0, body.indexOf('app.emit("open-file"'));
    expect(tail, "else 分支要记一条 Warn").toMatch(/Level::Warn[\s\S]{0,200}找不到主窗口/);
    expect(tail, "成功那一路也要记（Info 档在发布版可见）").toMatch(
      /Level::Info[\s\S]{0,200}单实例转发/,
    );
  });

  it("前端只由主窗口取队列，卫星窗口不许抢（广播到所有窗口）", () => {
    const i = boot.indexOf('listen("open-file"');
    expect(i, "前端要听 open-file").toBeGreaterThan(-1);
    const seg = boot.slice(i, boot.indexOf("}).catch", i));
    expect(seg, "卫星窗口必须跳过").toContain('windowKind !== "main"');
    expect(seg, "取走的是 Rust 队列里的路径（事件不带路径）").toContain("takePendingFiles()");
  });

  it("开新标签与复用已有标签都要把落点激活（「激活对应标签」那一半）", () => {
    // 新文件：attachTabToPanel 把面板的 activeTabId 指到新那枚（doc-model.ts 那一处）；
    // 已开：doOpen 的复用分支显式 setActivePanelId + switchTab。
    expect(files, "复用分支要切面板").toContain("setActivePanelId(instPanel.panelId)");
    expect(files, "复用分支要切标签").toContain("switchTab(instPanel.panelId, inst.tabId)");
    const dm = readFileSync("src/doc-model.ts", "utf-8");
    expect(dm, "新建实例要把面板的活动标签指过去").toContain("panel.activeTabId = tab.tabId;");
  });
});
