// B461 · 「回退此块」的纯文本换算。
//
// 这一族用例钉的是**边界**：VS Code 的 `RevertHunkOrSelection` 走的是 TextModel 的行区间，
// 空段 / 文首 / 文末 / 末尾换行四种边界各有一种落法。把 `revertEdit` 的输出直接应用到字符串，
// 断言「改完的正文」而不是中间的 from/to —— 前者才是用户看得见的事实。

import { describe, expect, it } from "vitest";
import type { DiffBlock } from "../src/diff/blocks";
import { revertEdit } from "../src/diff/revert";

/** 只给这一族用例关心的字段；其余字段按 `blocks.ts` 的口径补零。 */
function block(over: Partial<DiffBlock>): DiffBlock {
  return {
    kind: "modify",
    originalStart: 1,
    originalEnd: 1,
    modifiedStart: 1,
    modifiedEnd: 1,
    added: 1,
    removed: 1,
    offset: 0,
    ...over,
  };
}

/** 把 `revertEdit` 的结果应用回新稿正文。 */
function applied(original: string, modified: string, b: DiffBlock): string {
  const edit = revertEdit(original, modified, b);
  if (!edit) return modified;
  return modified.slice(0, edit.from) + edit.insert + modified.slice(edit.to);
}

describe("B461 · revertEdit：把原稿这一段写回新稿", () => {
  it("改行：整段替换，块尾的换行照旧留在原处", () => {
    expect(
      applied(
        "A\nX\nY\nC",
        "A\nP\nQ\nC",
        block({ originalStart: 2, originalEnd: 3, modifiedStart: 2, modifiedEnd: 3 }),
      ),
    ).toBe("A\nX\nY\nC");
  });

  it("删行（原稿有、新稿没有）：在空段落点插入整段", () => {
    expect(
      applied(
        "A\nX\nC",
        "A\nC",
        block({ originalStart: 2, originalEnd: 2, modifiedStart: 2, modifiedEnd: 1 }),
      ),
    ).toBe("A\nX\nC");
  });

  it("增行（原稿没有、新稿有）：把新稿多出来的整段删掉", () => {
    expect(
      applied(
        "A\nC",
        "A\nP\nQ\nC",
        block({ originalStart: 2, originalEnd: 1, modifiedStart: 2, modifiedEnd: 3 }),
      ),
    ).toBe("A\nC");
  });

  it("文首插入：不会凭空多出一个前导换行", () => {
    expect(
      applied(
        "X\nA",
        "A",
        block({ originalStart: 1, originalEnd: 1, modifiedStart: 1, modifiedEnd: 0 }),
      ),
    ).toBe("X\nA");
  });

  it("文末追加（末尾无换行）：补一个分隔换行", () => {
    expect(
      applied(
        "A\nX",
        "A",
        block({ originalStart: 2, originalEnd: 2, modifiedStart: 2, modifiedEnd: 1 }),
      ),
    ).toBe("A\nX");
  });

  it("文末追加（末尾已有换行）：不补第二个换行", () => {
    expect(
      applied(
        "A\nX",
        "A\n",
        block({ originalStart: 2, originalEnd: 2, modifiedStart: 2, modifiedEnd: 1 }),
      ),
    ).toBe("A\nX");
  });

  it("空文档：直接落下原稿那一段，没有多余空行", () => {
    expect(
      applied(
        "X",
        "",
        block({ originalStart: 1, originalEnd: 1, modifiedStart: 1, modifiedEnd: 0 }),
      ),
    ).toBe("X");
  });

  it("删掉文末的增行：与 VS Code 一致，保留块前那个换行", () => {
    expect(
      applied(
        "A",
        "A\nP\nQ",
        block({ originalStart: 2, originalEnd: 1, modifiedStart: 2, modifiedEnd: 3 }),
      ),
    ).toBe("A\n");
  });

  it("两侧都空 ⇒ 没有可做的事（返回 null，不制造空编辑）", () => {
    expect(
      revertEdit(
        "A",
        "A",
        block({ originalStart: 2, originalEnd: 1, modifiedStart: 2, modifiedEnd: 1 }),
      ),
    ).toBeNull();
  });
});
