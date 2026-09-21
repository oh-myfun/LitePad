// @vitest-environment jsdom
// 反向验证（Reverse Verification）当作**测试用例**放在 tests/ 里跑。
//
// 什么是反向验证：光有「正向用例是绿的」不能证明守卫咬得住 —— 万一那条断言是恒真的
// （怎么写都过），它就是一条**假绿**。反向验证要证明的是：**实现退化成错误写法时，
// 对应的用例必须变红**。
//
// 本文件用的是「**退化实现替身**」：把错误写法在测试里复刻成一个可安装的处理器，断言
// 它**确实坏掉**。正向用例断言的是「真实实现 → 行为正确」，两者行为不同 ⇒ 正向用例不是
// 恒真 ⇒ 守卫咬得住。
//
// 与已退役的 `scripts/reverse-verify-*.cjs` 的关系（脚本已于 09-22 测试整理时删除）：
//   · 脚本那一层是**改真实源码**再跑子进程里的用例，覆盖面含「静态契约」；代价是要临时
//     改写文件，被硬杀会留补丁（`pitfalls/0095`），过滤器写错还会假绿。
//   · 更重要的是：所有脚本都硬编码了 `tests/regressions.test.ts` 作为目标——该文件被拆掉
//     退役后，它们运行时会因「文件不存在」而 vitest 退出非零，于是 `expectRed` 的探针一律
//     报「红 ✓」= **静默假绿**，完全失去意义。
//   · 本文件**不改任何源码**、没有过滤器，随 `npm test` 一起跑、零副作用；能用退化替身表达
//     的那一半（文件拖入 / 标签拖拽 / 查找纯函数 / 静态断言工具基建）都搬到这里了。
//   · 剩下只能在「改真实源码」下证明的那一半（CSS 外观数值、Rust wire 细节等），其正向契约
//     已由对应模块的静态契约用例守着（`findbar.test.ts` / `tabdnd.test.ts` / `save-conflict.test.ts`），
//     脚本完成交付时的「一次性反向确认」使命后退役。
//
// 新增反向对照时按域加 describe：文件拖入 → `pitfalls/0096`；标签拖拽 → `0094`。

import { describe, it, expect, afterEach } from "vitest";
import { restrictToRange, preserveCase } from "../src/editor/find";
import { installFileDropTarget, isFileDrag } from "../src/shell/filedrop";
import { TAB_MIME } from "../src/shell/tabdnd";
import { fireDrag, makeDataTransfer, type FakeDataTransfer } from "./dnd";

const teardowns: (() => void)[] = [];

afterEach(() => {
  while (teardowns.length) teardowns.pop()!();
  document.body.innerHTML = "";
});

/**
 * 页面内编辑器的替身：只记录它听到了哪些拖拽事件。
 *
 * 真实环境里 CM6 的 `dragover`/`drop` 监听挂在 `view.contentDOM` 上 —— **听到就等于会动手**
 * （文件拖入时它用 `FileReader` 把内容读出来插进文档），所以「听不到」才是我们要的判据。
 */
function editorProbe(): { el: HTMLElement; heard: string[] } {
  const el = document.createElement("div");
  el.className = "cm-content";
  document.body.appendChild(el);
  const heard: string[] = [];
  for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
    el.addEventListener(type, () => heard.push(type));
  }
  return { el, heard };
}

/** 退化实现：文件拖入的处理器挂**冒泡**阶段（其余与真实实现一致）。 */
function installBubble(): void {
  const onDrop = (e: Event): void => {
    const de = e as DragEvent;
    if (!isFileDrag(de.dataTransfer)) return;
    de.preventDefault();
    de.stopPropagation(); // 到冒泡阶段再 stop 已经晚了：编辑器早就收到了
  };
  document.addEventListener("drop", onDrop);
  teardowns.push(() => document.removeEventListener("drop", onDrop));
}

/** 退化实现：挂捕获阶段，但**不** `stopPropagation`。 */
function installCaptureNoStop(): void {
  const onDrop = (e: Event): void => {
    const de = e as DragEvent;
    if (!isFileDrag(de.dataTransfer)) return;
    de.preventDefault();
  };
  document.addEventListener("drop", onDrop, true);
  teardowns.push(() => document.removeEventListener("drop", onDrop, true));
}

/** 退化实现：挂捕获 + `stopPropagation`，但**不** `preventDefault`。 */
function installCaptureNoPrevent(): void {
  const onDrop = (e: Event): void => {
    const de = e as DragEvent;
    if (!isFileDrag(de.dataTransfer)) return;
    de.stopPropagation();
  };
  document.addEventListener("drop", onDrop, true);
  teardowns.push(() => document.removeEventListener("drop", onDrop, true));
}

// ------------------------------------------------- 文件拖入（pitfalls/0096）

describe("反向验证：文件拖入的拦截必须『捕获阶段 + stopPropagation + preventDefault』", () => {
  it("基准：真实实现 → 编辑器听不到 drop，默认动作也被拦", () => {
    teardowns.push(installFileDropTarget({ preview: () => {}, clear: () => {} }, 1));
    const { el, heard } = editorProbe();
    const e = fireDrag("drop", el, makeDataTransfer(["Files"]), { clientX: 5, clientY: 6 });
    expect(heard, "编辑器一个都不该听到（听到 = CM6 会把文件内容读出来插进文档）").toEqual([]);
    expect(e.defaultPrevented, "默认动作必须由文件通道拦掉").toBe(true);
  });

  it("退化①：监听挂冒泡阶段 → 编辑器照样收到 drop", () => {
    installBubble();
    const { el, heard } = editorProbe();
    const e = fireDrag("drop", el, makeDataTransfer(["Files"]), { clientX: 5, clientY: 6 });
    // ⚠️ 先自证处理器**确实跑了**：否则「编辑器收到」可能只是因为根本没人拦 ——
    //    那这条退化用例就成了恒真，证明不了任何事（同「退出码 0 ≠ 生效」那类假象）。
    expect(e.defaultPrevented, "处理器跑了、preventDefault 也执行了，仍然拦不住").toBe(true);
    expect(
      heard,
      "冒泡阶段拦不住：等我们跑到，CM6 已经把文件内容插进正文，preventDefault 救不回来",
    ).toContain("drop");
  });

  it("退化②：挂了捕获但不 stopPropagation → 编辑器仍能收到 drop", () => {
    installCaptureNoStop();
    const { el, heard } = editorProbe();
    const e = fireDrag("drop", el, makeDataTransfer(["Files"]), { clientX: 5, clientY: 6 });
    expect(e.defaultPrevented, "同上：处理器确实跑了，只是没截断传播").toBe(true);
    expect(heard, "光 preventDefault 不够：事件还是会走到编辑器上").toContain("drop");
  });

  it("退化③：stopPropagation 但不 preventDefault → 默认动作照跑（两件事缺一不可）", () => {
    installCaptureNoPrevent();
    const { el, heard } = editorProbe();
    const e = fireDrag("drop", el, makeDataTransfer(["Files"]), { clientX: 5, clientY: 6 });
    expect(heard, "stopPropagation 这一半是有效的：编辑器确实收不到").toEqual([]);
    expect(e.defaultPrevented, "不拦默认动作 = 浏览器自己处理这次 drop").toBe(false);
  });
});

// ------------------------------------------------- 标签拖拽（pitfalls/0094）

/** 落点编辑器的替身（模拟 contenteditable / CM6：drop 上只要有可读正文就插进文档）。 */
function textEditorProbe(): { el: HTMLElement; text: () => string } {
  const el = document.createElement("div");
  el.className = "cm-content";
  document.body.appendChild(el);
  let doc = "";
  el.addEventListener("drop", (e) => {
    const dt = (e as DragEvent).dataTransfer as unknown as FakeDataTransfer | null;
    const plain = dt?.getData("text/plain") ?? "";
    if (plain) doc += plain;
  });
  return { el, text: () => doc };
}

describe("反向验证：标签拖拽的两条防线（不放可读正文 / 事件不漏下去）", () => {
  it("防线①：只放私有 MIME —— 就算事件漏到编辑器，也没有可读正文可插", () => {
    const { el, text } = textEditorProbe();
    const dt = makeDataTransfer();
    dt.setData(TAB_MIME, "tab-payload");
    fireDrag("drop", el, dt);
    expect(text(), "dataTransfer 里没有可读正文 → 正文不该被改").toBe("");
  });

  it("退化：顺手写一份 text/plain —— 漏下去就把文件名插进正文", () => {
    const { el, text } = textEditorProbe();
    const dt = makeDataTransfer();
    dt.setData(TAB_MIME, "tab-payload");
    dt.setData("text/plain", "note.md"); // ← 退化点：内部协议对外提供了可读正文
    fireDrag("drop", el, dt);
    expect(text(), "有可读正文就会被 contenteditable/CM6 当「拖进来的文本」插进正文").toContain(
      "note.md",
    );
  });
});

// ------------------------------------------------- 查找：范围过滤与保留大小写（来源 b73 探针）

describe("反向验证：查找的范围过滤与保留大小写（退化实现对照）", () => {
  const matches = [
    { from: 0, to: 2 },
    { from: 4, to: 6 },
    { from: 10, to: 12 },
  ];
  const range = { from: 4, to: 8 };

  it("基准：restrictToRange 把命中收敛到选区内", () => {
    const got = restrictToRange(matches, range);
    expect(got, "选区外的命中应被剔除").toEqual([{ from: 4, to: 6 }]);
  });

  it("退化：去掉 range 判据（一律原样返回）→ 命中数不降 ⇒ 正向断言不恒真", () => {
    const degenerate = (m: typeof matches, _r: typeof range | null) => m; // 退化点：永不过滤
    const got = degenerate(matches, range);
    // ⚠️ 先自证退化实现**确实跑了**：它得返回原始三命中，才有资格谈「没收敛」。
    expect(got, "退化实现确实返回了全部命中（没被别处吃掉）").toHaveLength(3);
    expect(got, "与基准对照：不收敛 ⇒ 收敛用例不是恒真").not.toEqual(
      restrictToRange(matches, range),
    );
  });

  it("基准：preserveCase 按命中词大小写迁移替换串", () => {
    expect(preserveCase("Foo", "baz"), "Title Case → 首字母大写").toBe("Baz");
    expect(preserveCase("FOO", "baz"), "全大写 → 全大写").toBe("BAZ");
    expect(preserveCase("foo", "BAZ"), "全小写 → 全小写").toBe("baz");
  });

  it("退化：preserveCase 原样返回 → 不迁移大小写", () => {
    const degenerate = (m: string, r: string) => r; // 退化点：永不迁移
    // ⚠️ 先自证退化实现**确实跑了**：它得把替换串原样吐出来。
    expect(degenerate("Foo", "baz"), "退化实现确实原样返回了").toBe("baz");
    expect(degenerate("Foo", "baz"), "与基准对照：不迁移 ⇒ 迁移用例不是恒真").not.toBe(
      preserveCase("Foo", "baz"),
    );
  });
});
