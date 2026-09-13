// @vitest-environment jsdom
// B46 首选项弹窗运行时测试：
// 1) 打开后渲染全部分组与控件，且控件初值取自 opts 的 getter；
// 2) 任何控件 change 立即回调对应 setter（即时生效 + 持久化由 main 负责）；
// 3) 「快捷键…」先关本窗再回调 onKeymap；确定/Esc/点蒙层关窗。
import { describe, it, expect, afterEach } from "vitest";
import {
  showPreferencesDialog,
  type PreferencesDialogOptions,
} from "../src/shell/preferencesdialog";

const noop = (): void => {};

function makeOpts(): PreferencesDialogOptions {
  return {
    theme: () => "system",
    onTheme: noop,
    fontFamily: () => "",
    onFontFamily: noop,
    fontSize: () => 14,
    onFontSize: noop,
    editorLineHeight: () => 1.5,
    onEditorLineHeight: noop,
    previewLineHeight: () => 1.7,
    onPreviewLineHeight: noop,
    tocWidth: () => 240,
    onTocWidth: noop,
    wordWrap: () => true,
    onWordWrap: noop,
    autosave: () => false,
    onAutosave: noop,
    defaultEol: () => "CRLF",
    eolOptions: () => ["CRLF", "LF", "CR"],
    onDefaultEol: noop,
    defaultEncoding: () => "UTF-8",
    encodingOptions: () => ["UTF-8", "GB18030"],
    onDefaultEncoding: noop,
    onKeymap: noop,
  };
}

function dialog(): HTMLElement {
  const dlg = document.querySelector(".preferences-dialog");
  expect(dlg, "首选项弹窗应已打开").toBeTruthy();
  return dlg!;
}

/** 按标签文本找到行内控件。 */
function rowControl(label: string): HTMLSelectElement | HTMLInputElement {
  const row = [...dialog().querySelectorAll(".settings-row")].find(
    (r) => r.querySelector(".settings-label")?.textContent === label,
  );
  expect(row, `行「${label}」应存在`).toBeTruthy();
  const ctl = row!.querySelector("select, input");
  expect(ctl, `行「${label}」应有控件`).toBeTruthy();
  return ctl as HTMLSelectElement | HTMLInputElement;
}

function groups(): string[] {
  return [...dialog().querySelectorAll(".preferences-group")].map((g) => g.textContent ?? "");
}

afterEach(() => {
  document.body.textContent = "";
});

describe("B46 首选项弹窗", () => {
  it("打开后渲染全部分组，控件初值取自 getter", () => {
    showPreferencesDialog(makeOpts());
    for (const g of ["外观", "字体与行距", "编辑器", "Markdown 预览", "新建文件"]) {
      expect(groups(), `应有分组「${g}」`).toContain(g);
    }
    expect((rowControl("主题") as HTMLSelectElement).value).toBe("system");
    expect((rowControl("编辑器字体") as HTMLSelectElement).value).toBe("");
    expect((rowControl("字号（px）") as HTMLSelectElement).value).toBe("14");
    expect((rowControl("编辑器行距") as HTMLSelectElement).value).toBe("1.5");
    expect((rowControl("自动换行") as HTMLInputElement).checked).toBe(true);
    expect((rowControl("自动保存") as HTMLInputElement).checked).toBe(false);
    expect((rowControl("预览行距") as HTMLSelectElement).value).toBe("1.7");
    expect((rowControl("大纲宽度") as HTMLSelectElement).value).toBe("240");
    expect((rowControl("默认行尾") as HTMLSelectElement).value).toBe("CRLF");
    expect((rowControl("默认编码") as HTMLSelectElement).value).toBe("UTF-8");
    // 行尾/编码候选来自 main 预取的列表
    const eolOpts = [...(rowControl("默认行尾") as HTMLSelectElement).options].map((o) => o.value);
    expect(eolOpts).toEqual(["CRLF", "LF", "CR"]);
  });

  it("任何控件 change 立即回调对应 setter", () => {
    const opts = makeOpts();
    const calls: string[] = [];
    opts.onTheme = (m) => calls.push(`theme:${m}`);
    opts.onFontFamily = (f) => calls.push(`font:${f}`);
    opts.onFontSize = (px) => calls.push(`size:${px}`);
    opts.onEditorLineHeight = (v) => calls.push(`elh:${v}`);
    opts.onWordWrap = (on) => calls.push(`wrap:${on}`);
    opts.onAutosave = (on) => calls.push(`autosave:${on}`);
    opts.onPreviewLineHeight = (v) => calls.push(`plh:${v}`);
    opts.onTocWidth = (w) => calls.push(`toc:${w}`);
    opts.onDefaultEol = (e) => calls.push(`eol:${e}`);
    opts.onDefaultEncoding = (e) => calls.push(`enc:${e}`);
    showPreferencesDialog(opts);

    const fire = (label: string, value: string): void => {
      const ctl = rowControl(label);
      if (ctl instanceof HTMLInputElement) {
        ctl.checked = value === "true";
      } else {
        ctl.value = value;
      }
      ctl.dispatchEvent(new Event("change"));
    };

    fire("主题", "dark");
    fire("编辑器字体", "Consolas");
    fire("字号（px）", "18");
    fire("编辑器行距", "1.8");
    fire("自动换行", "false");
    fire("自动保存", "true");
    fire("预览行距", "2.1");
    fire("大纲宽度", "320");
    fire("默认行尾", "LF");
    fire("默认编码", "GB18030");

    expect(calls).toEqual([
      "theme:dark",
      "font:Consolas",
      "size:18",
      "elh:1.8",
      "wrap:false",
      "autosave:true",
      "plh:2.1",
      "toc:320",
      "eol:LF",
      "enc:GB18030",
    ]);
    // 即时生效模式：弹窗不因修改而关闭
    expect(document.querySelector(".preferences-dialog")).toBeTruthy();
  });

  it("「快捷键…」先关本窗再回调；确定/Esc/点蒙层都能关窗", () => {
    const opts = makeOpts();
    let keymapOpened = false;
    opts.onKeymap = () => {
      // 回调触发时本窗必须已关闭（避免两层蒙层叠放）
      keymapOpened = document.querySelector(".preferences-dialog") === null;
    };
    showPreferencesDialog(opts);
    const btn = [...dialog().querySelectorAll("button")].find((b) => b.textContent === "快捷键…");
    expect(btn, "应有快捷键按钮").toBeTruthy();
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(keymapOpened, "回调时本窗应已关闭").toBe(true);

    // Esc 关窗
    showPreferencesDialog(opts);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".preferences-dialog"), "Esc 应关窗").toBeNull();

    // 蒙层点击关窗（点弹窗内部不关）
    showPreferencesDialog(opts);
    const overlay = document.querySelector(".settings-overlay")!;
    (overlay as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".preferences-dialog"), "点蒙层应关窗").toBeNull();

    // 确定按钮关窗
    showPreferencesDialog(opts);
    const ok = dialog().querySelector(".settings-ok")!;
    (ok as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".preferences-dialog"), "确定应关窗").toBeNull();
  });
});
