// @vitest-environment node
// B427 · 资源管理器过滤框的**纯模型**（`src/explorer/filter.ts`）。
//
// 后端 `filter_tree` 回的是一串「命中名字」的相对路径（posix）。这一层只做两件事：
//   ① 把命中补成**一棵树**（祖先链按 rel 同步造出来，不为每一层再发一次 `list_dir`）；
//   ② 折叠时把某一目录的**整棵子孙**一起藏掉。
// 两条都是纯函数：不碰 DOM、不发 IPC —— 面板只管把结果画出来。
import { describe, it, expect } from "vitest";
import type { NameHit } from "../src/ipc/api";
import {
  DEFAULT_FILTER,
  filterActive,
  treeOf,
  visibleOf,
  type FilterNode,
} from "../src/explorer/filter";

const R = "E:\\根";

/** 造一条后端形状的命中（path 与 rel 的关系与 Rust 那边逐字一致）。 */
function hit(rel: string, isDir = false): NameHit {
  return {
    name: rel.split("/").pop() ?? rel,
    path: `${R}\\${rel.split("/").join("\\")}`,
    rel,
    isDir,
  };
}

/** 拍平成 `["depth name", …]`，判据读起来就是屏幕上的顺序。 */
const shape = (nodes: FilterNode[]): string[] => nodes.map((n) => `${n.depth} ${n.name}`);

describe("B427 · 过滤结果的树形合成", () => {
  it("深层命中把祖先链补出来（命中在第三层也看得见路径）", () => {
    const nodes = treeOf(R, [hit("子/孙/深处的命中.md")]);
    expect(shape(nodes)).toEqual(["1 子", "2 孙", "3 深处的命中.md"]);
    expect(nodes.map((n) => n.matched)).toEqual([false, false, true]);
    expect(nodes[0].dir, "祖先层的父亲 = 根").toBe(R);
    expect(nodes[2].dir).toBe(`${R}\\子\\孙`);
    expect(nodes[2].path).toBe(`${R}\\子\\孙\\深处的命中.md`);
    expect(nodes[0].isDir).toBe(true);
    expect(nodes[2].isDir).toBe(false);
  });

  it("自己命中的目录不会被祖先补齐再画一遍（同一条只出现一次，且标成命中）", () => {
    const nodes = treeOf(R, [hit("子", true), hit("子/命中.md")]);
    expect(shape(nodes)).toEqual(["1 子", "2 命中.md"]);
    expect(nodes.map((n) => n.matched)).toEqual([true, true]);
  });

  it("同层目录在前，再按自然序（`第2` 在 `第10` 前头，大小写无关）", () => {
    const nodes = treeOf(R, [
      hit("b.md"),
      hit("a10.md"),
      hit("a2.md"),
      hit("Zdir", true),
      hit("adir", true),
    ]);
    expect(shape(nodes)).toEqual(["1 adir", "1 Zdir", "1 a2.md", "1 a10.md", "1 b.md"]);
  });

  it("相邻命中共享同一段祖先（不画两棵 `子`）", () => {
    const nodes = treeOf(R, [hit("子/a/x.md"), hit("子/b/y.md"), hit("子/c.md")]);
    expect(shape(nodes)).toEqual(["1 子", "2 a", "3 x.md", "2 b", "3 y.md", "2 c.md"]);
  });

  it("根那一层直接命中：父亲就是根，深度 1", () => {
    const nodes = treeOf(R, [hit("笔记.md")]);
    expect(shape(nodes)).toEqual(["1 笔记.md"]);
    expect(nodes[0].dir).toBe(R);
  });

  it("根带反斜杠（`E:\\`）也不拼出双反斜杠", () => {
    const root = "E:\\";
    const nodes = treeOf(root, [{ name: "a.md", path: "E:\\a.md", rel: "a.md", isDir: false }]);
    expect(nodes[0].path, "路径一律用后端回的 path，不自己拼").toBe("E:\\a.md");
    expect(nodes[0].dir).toBe("E:\\");
  });

  it("折叠一个目录 ⇒ 它的整棵子孙都藏掉，别的枝不动", () => {
    const nodes = treeOf(R, [hit("a/x.md"), hit("a/b/y.md"), hit("c.md")]);
    expect(shape(visibleOf(nodes, new Set<string>()))).toEqual([
      "1 a",
      "2 b",
      "3 y.md",
      "2 x.md",
      "1 c.md",
    ]);
    const collapsedA = visibleOf(nodes, new Set([`${R}\\a`]));
    expect(shape(collapsedA), "收起 a ⇒ 只剩 a 自己和 c").toEqual(["1 a", "1 c.md"]);
    const collapsedB = visibleOf(nodes, new Set([`${R}\\a\\b`]));
    expect(shape(collapsedB), "收起 a/b ⇒ a 下的 x 还在").toEqual([
      "1 a",
      "2 b",
      "2 x.md",
      "1 c.md",
    ]);
  });

  it("小写盘符与尾部分隔符不同写法仍认作同一个祖先（Windows 路径不分大小写）", () => {
    const nodes = treeOf(R, [hit("子/a.md"), hit("子/b.md")]);
    expect(shape(nodes)).toEqual(["1 子", "2 a.md", "2 b.md"]);
    const same = visibleOf(nodes, new Set([`${R}\\子`.toLowerCase()]));
    expect(shape(same), "折叠集合按大小写无关比较").toEqual(["1 子"]);
  });
});

describe("B427 · 过滤是否生效", () => {
  it("空串 / 纯空白 = 没在过滤（常规树照旧）", () => {
    expect(filterActive(DEFAULT_FILTER)).toBe(false);
    expect(filterActive({ ...DEFAULT_FILTER, text: "   " })).toBe(false);
    expect(filterActive({ ...DEFAULT_FILTER, text: " md " })).toBe(true);
  });

  it("缺省值：三档匹配全关、排除打开（「排除」一颗就包含忽略文件）", () => {
    expect(DEFAULT_FILTER).toEqual({
      text: "",
      case: false,
      word: false,
      regex: false,
      excludes: true,
    });
    expect(
      "ignores" in DEFAULT_FILTER,
      "「忽略」那颗独立开关已删（用户：包含在「排除设置与忽略文件」里了），配置里不许再留这一格",
    ).toBe(false);
  });
});
