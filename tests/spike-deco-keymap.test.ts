// @vitest-environment jsdom
// B397-4b · 编辑模式的键位（移植自 InkNote editor.ts:1019-1122 / 1429-1435）。
//
// 这一片的判据全部落在**文档真的变了什么**上：装饰面把行画成了组件，
// 回车与方向键的含义就与源码面不同 —— 只判「键被处理了」证明不了这一点。
//
// ⚠️ 两条对照臂是必须的：
//   ① 同一份文档在**源码面**（不装 decoFace）按回车，列表不续 —— 证明判据分得清两档；
//   ② 同一份文档在**只读锁**下按回车，一个字都不写 —— 证明这一片没绕过锁。

import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import { currentBlockRange } from "../src/spike/deco/blockRange";
import { decoFace, decoLock } from "../src/spike/deco/wysiwyg";

interface Opts {
  readonly?: boolean;
  /** 源码面：不装装饰档（对照组）。 */
  source?: boolean;
}

function view(doc: string, opts: Opts = {}): EditorView {
  const extensions = [markdown({ base: markdownLanguage }), EditorView.lineWrapping];
  if (!opts.source) {
    extensions.push(decoFace(), decoLock(opts.readonly ?? false));
  }
  return new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent: document.body,
  });
}

function caret(view: EditorView, pos: number): void {
  view.dispatch({ selection: { anchor: pos } });
}

function press(view: EditorView, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  view.focus();
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("B397-4b 续列表 / 删标记：markdown() 自带的那条键位在两档都得生效", () => {
  it("列表项末尾回车 → 续出 `- `（装饰档与源码档一致）", () => {
    const doc = "- 甲";
    for (const opts of [{}, { source: true }]) {
      const v = view(doc, opts);
      caret(v, doc.length);
      press(v, "Enter");
      expect(v.state.doc.toString(), JSON.stringify(opts)).toBe("- 甲\n- ");
    }
  });

  it("列表项正文开头退格 → 去掉标记（装饰档与源码档一致）", () => {
    const doc = "- 甲";
    for (const opts of [{}, { source: true }]) {
      const v = view(doc, opts);
      caret(v, 2); // `- ` 之后
      press(v, "Backspace");
      expect(v.state.doc.toString(), JSON.stringify(opts)).toBe("甲");
    }
  });
});

describe("B397-4b 回车开门：``` / $$ 行尾回车把组件补齐", () => {
  it("敲完 ``` 再回车 → 补上中间空行与闭合围栏，并画出代码块组件", async () => {
    const v = view("甲\n\n");
    // 模拟逐字敲围栏：draftFences 只在 `input.type` 且光标落行尾时记账
    const from = v.state.doc.length;
    v.dispatch({
      changes: { from, insert: "```" },
      selection: { anchor: from + 3 },
      userEvent: "input.type",
    });
    press(v, "Enter");
    expect(v.state.doc.toString()).toBe("甲\n\n```\n\n```");

    await tick();
    expect(v.dom.querySelector(".md-codeblock-widget")).toBeTruthy();
  });

  it("`$$` 行尾回车 → 补齐公式块", () => {
    const v = view("甲\n\n");
    const from = v.state.doc.length;
    v.dispatch({
      changes: { from, insert: "$$" },
      selection: { anchor: from + 2 },
      userEvent: "input.type",
    });
    press(v, "Enter");
    expect(v.state.doc.toString()).toBe("甲\n\n$$\n\n$$");
  });

  it("对照（内存里的退化替身）：没有回车那道闸时，围栏行回车只换一行", () => {
    // 替身 = markdown + 裸 defaultKeymap，与真键位表的差**正好**是那三闸回车。
    // 这条证明上面两条判据有鉴别力：不是「怎么按都会得到闭合围栏」。
    const v = new EditorView({
      state: EditorState.create({
        doc: "甲\n\n",
        extensions: [markdown({ base: markdownLanguage }), keymap.of([...defaultKeymap])],
      }),
      parent: document.body,
    });
    const from = v.state.doc.length;
    v.dispatch({
      changes: { from, insert: "```" },
      selection: { anchor: from + 3 },
      userEvent: "input.type",
    });
    press(v, "Enter");
    expect(v.state.doc.toString()).toBe("甲\n\n```\n");
    expect(v.state.doc.toString()).not.toContain("```\n\n```");
  });
});

describe("B397-4b 边界回车：组件边上造一个真能落光标的空段落", () => {
  // 两条是**回归钉**：结论与默认回车相同（LitePad 的空行不折叠），钉的是「这一档
  // 不许因为换了键位表把回车弄丢」—— 例如某一闸 return true 却没 dispatch。
  it("标题行首回车 → 上方多一个空行", () => {
    const doc = "甲\n\n## 乙";
    const v = view(doc);
    const headingFrom = doc.indexOf("##");
    caret(v, headingFrom);
    press(v, "Enter");
    expect(v.state.doc.toString()).toBe("甲\n\n\n## 乙");
    expect(v.state.selection.main.head).toBe(headingFrom);
  });

  it("表格末尾回车 → 表格后面真的多出一行", () => {
    const doc = ["| 甲 | 乙 |", "| --- | --- |", "| 1 | 2 |", "", "尾"].join("\n");
    const v = view(doc);
    const wrap = v.dom.querySelector<HTMLElement>(".md-table-widget");
    expect(wrap, "表格组件没画出来，这条判据就是空转").toBeTruthy();
    const range = currentBlockRange(v, wrap!)!;
    caret(v, range.to);
    press(v, "Enter");
    const out = v.state.doc.toString();
    expect(out.startsWith(["| 甲 | 乙 |", "| --- | --- |", "| 1 | 2 |", "", ""].join("\n"))).toBe(
      true,
    );
    expect(v.state.selection.main.head).toBe(range.to + 1);
  });

  it("只读锁下按回车不写文档（这一片没绕过锁）", () => {
    const doc = "甲\n\n## 乙";
    const v = view(doc, { readonly: true });
    caret(v, doc.indexOf("##"));
    press(v, "Enter");
    expect(v.state.doc.toString()).toBe(doc);
  });
});
