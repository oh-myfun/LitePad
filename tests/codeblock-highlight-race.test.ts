// @vitest-environment jsdom
// 代码块的上色是异步的：出发时拿的是那一刻的源码快照，回来时把 `<pre>` 整个换掉。
// 若这期间用户已经就地改过字，旧快照就会把新字吞掉（表现为「打字像没生效」）。
// 这条用例把上色挂起，先打字、再放行旧 html，钉住「源码变了就不许替换」。
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it, vi } from "vitest";
import { previewFace, previewLock } from "../src/preview/wysiwyg";

const highlight = vi.hoisted(() => {
  const state: {
    resolve: ((html: string) => void) | null;
    calls: number;
  } = { resolve: null, calls: 0 };
  return state;
});

vi.mock("../src/markdown/highlight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/markdown/highlight")>();
  return {
    ...actual,
    highlightCodeHtml: () => {
      highlight.calls++;
      // 第一发是组件初次渲染按旧文本发起的，挂起等测试手动放行；
      // 后续是回写后重建的组件，给空 = 不上色，免得旧 html 再掺进来。
      if (highlight.calls === 1) {
        return new Promise<string>((resolve) => {
          highlight.resolve = resolve;
        });
      }
      return Promise.resolve("");
    },
  };
});

function previewFaceView(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        previewFace(),
        previewLock(false),
        EditorView.lineWrapping,
      ],
    }),
    parent: document.body,
  });
}

describe("代码块异步上色", () => {
  it("回来时源码已被改过 ⇒ 不许拿旧文本覆盖，回写照常落地", async () => {
    const doc = ["```ts", "const x = 1;", "```", "", "乙"].join("\n");
    const view = previewFaceView(doc);
    const wrap = view.dom.querySelector<HTMLElement>(".md-codeblock-widget")!;
    const code = wrap.querySelector<HTMLElement>('[data-block-source="1"]')!;
    expect(highlight.calls, "组件初次渲染就该按旧文本发起上色").toBe(1);

    code.textContent = "const z = 3;";
    code.dispatchEvent(new InputEvent("input", { bubbles: true }));

    // 放行出发时那发上色：html 里是旧文本
    highlight.resolve?.("<pre><code>const x = 1;</code></pre>");
    await Promise.resolve();
    await Promise.resolve();

    expect(wrap.textContent, "上色不许把刚打的字换回旧文本").toContain("const z = 3;");

    // 旧上色被挡下之后，回写仍然要落进文档
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain("const z = 3;"));
    view.destroy();
  });
});
