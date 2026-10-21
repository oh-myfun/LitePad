// 「各自到底」这条不变量的**闭环**判据（评审 I3 第 ② 条）。
//
// 085f64e 那两发饱和不是为了让 `getV` 报得好看，而是为了这条因果链真的走通：
//   编辑器滚到自己的底 ⇒ 共享坐标 v ⇒ 预览 setV(v) ⇒ 预览到达**它自己的**底、
//   并且两侧报出同一个 v。前面那几条只测了单侧读数，测不到「对面真的落到底」。
// 两侧高度**故意不相等**（A1 的块间节奏造成的正是这个形状），所以只能靠浏览器各自裁剪。
import { describe, expect, it } from "vitest";
import { EditorScrollAnchor, type EditorScrollSurface } from "../src/sync-scroll/anchor";
import { PreviewScrollAnchor, type PreviewScrollSurface } from "../src/sync-scroll/preview";

/** 6 行、每行 10px、视口 30px ⇒ 可滚上限 30。 */
function fakeEditor(): EditorScrollSurface {
  const lines = 6;
  const tops = Array.from({ length: lines }, (_, i) => i * 10);
  let top = 0;
  return {
    scrollDOM: {
      get scrollTop() {
        return top;
      },
      set scrollTop(v: number) {
        top = Math.max(0, Math.min(v, 60 - 30)); // 浏览器按 maxScroll 裁
      },
      clientHeight: 30,
      scrollHeight: 60,
    },
    lineBlockAtHeight(h: number) {
      const i = Math.min(lines - 1, Math.max(0, Math.floor(Math.min(h, 59) / 10)));
      return { top: tops[i], height: 10, from: i * 100 };
    },
    lineBlockAt(pos: number) {
      const i = Math.min(lines - 1, Math.max(0, Math.floor(pos / 100)));
      return { top: tops[i], height: 10, from: i * 100 };
    },
    state: {
      doc: {
        lines,
        line: (n: number) => ({ from: (n - 1) * 100 }),
        lineAt: (pos: number) => ({ number: Math.floor(pos / 100) + 1 }),
      },
    },
  };
}

/** 同一份 6 行文档的预览侧：两块，总高 100、视口 40 ⇒ 可滚上限 60（与编辑器侧不相等）。 */
function fakePreview(): PreviewScrollSurface {
  let top = 0;
  return {
    root: {
      get scrollTop() {
        return top;
      },
      set scrollTop(v: number) {
        top = Math.max(0, Math.min(v, 100 - 40));
      },
      clientHeight: 40,
      scrollHeight: 100,
    },
    blocks: () => [
      { lineStart: 1, lineEnd: 4, top: 0, height: 70 },
      { lineStart: 5, lineEnd: 6, top: 70, height: 30 },
    ],
    schedule: (fn: () => void) => setTimeout(fn, 0),
  };
}

describe("到底时的跨侧闭环（B319 节奏引出的那条饱和）", () => {
  it("编辑器到底 ⇒ 广播过去的 v 让预览落到它自己的底，两侧报同一个 v", () => {
    const edSurface = fakeEditor();
    const pvSurface = fakePreview();
    const ed = new EditorScrollAnchor(edSurface);
    const pv = new PreviewScrollAnchor(pvSurface);

    ed.setV(99); // 意图远超文档末尾 ⇒ 被编辑器自己的底裁住
    const v = ed.getV();
    expect(v, "编辑器侧到底时共享坐标应饱和成文档末行").toBe(6);

    const landed = pv.setV(v);
    expect(landed, "预览侧兑现出来的也必须是同一个末行值").toBe(6);
    expect(pv.getV()).toBe(6);
    // 关键判据：预览真的到了**它自己的**可滚上限（100 − 40），不是停在按行对齐算出的半程
    expect(pvSurface.root.scrollTop, "预览应落到自己的底").toBe(60);
  });

  it("反过来：预览到底 ⇒ 编辑器也到自己的底", () => {
    const pvSurface = fakePreview();
    const edSurface = fakeEditor();
    const pv = new PreviewScrollAnchor(pvSurface);
    const ed = new EditorScrollAnchor(edSurface);

    pv.setV(99);
    const v = pv.getV();
    expect(v).toBe(6);
    expect(ed.setV(v), "编辑器侧被底裁住后回报同一个 v").toBe(6);
    expect(ed.getV()).toBe(6);
    expect(edSurface.scrollDOM.scrollTop, "编辑器应落到自己的底").toBe(30);
  });
});
