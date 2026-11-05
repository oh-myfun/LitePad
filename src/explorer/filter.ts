// B427 · 资源管理器顶部过滤框的**纯模型**。
//
// 后端 `filter_tree` 回的是一串「名字命中的相对路径」（posix）。这一层把它补成一棵树：
// 祖先链按 `rel` 同步造出来（不为每层再发 `list_dir`），同层目录在前、再按自然序排；
// 折叠只看一个路径集合、把被收起那一层的整棵子孙藏掉。
//
// 不碰 DOM、不发 IPC —— 面板只管把结果画出来（口径同 `src/search/store.ts` 的纯逻辑那一半）。
import type { NameHit } from "../ipc/api";

export interface FilterOpts {
  text: string;
  /** 区分大小写 */
  case: boolean;
  /** 全词匹配 */
  word: boolean;
  /** 用正则表达式（无效的正则由 Rust 报错，前端不另抄一份判据） */
  regex: boolean;
  /**
   * 「排除」那颗键 = **排除设置 + 忽略文件**一起管（与侧栏搜索的总闸同义）。
   * B428（用户点名）：原先旁边还有一颗独立的「跟随 .gitignore / .ignore」，语义被这一颗
   * 完全包含 ⇒ 删掉，`useIgnoreFiles` 跟随本值。
   */
  excludes: boolean;
}

export const DEFAULT_FILTER: FilterOpts = {
  text: "",
  case: false,
  word: false,
  regex: false,
  excludes: true,
};

/** 框里有没有东西 —— 空串 / 纯空白都算「没在过滤」，常规树照旧。 */
export function filterActive(opts: FilterOpts): boolean {
  return opts.text.trim() !== "";
}

/** 一行：要么是真命中，要么是为撑出祖先链补出来的容器（`matched = false`）。 */
export interface FilterNode {
  path: string;
  name: string;
  isDir: boolean;
  /** 根那一层是 1（与常规树的 `--depth` 同口径） */
  depth: number;
  /** 父亲（根那一层的命中 = 根） */
  dir: string;
  /** 自己命中了吗（false = 只是路径上的一层） */
  matched: boolean;
}

/** 拼一层路径。根可能带尾部分隔符（`E:\`），不能拼出双反斜杠。 */
export function joinPath(dir: string, name: string): string {
  return /[\\/]$/.test(dir) ? `${dir}${name}` : `${dir}\\${name}`;
}

const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/**
 * 自然序（与 Rust `explorer.rs` 的 `natural_cmp` 同口径）：数字段按数值比、
 * 其余按大小写无关的字符序比。`第2篇` 要排在 `第10篇` 前头 —— 否则用户读作「排序坏了」。
 */
export function naturalCompare(a: string, b: string): number {
  const ax = [...a.toLowerCase()];
  const bx = [...b.toLowerCase()];
  let i = 0;
  let j = 0;
  while (i < ax.length && j < bx.length) {
    const ca = ax[i];
    const cb = bx[j];
    if (isDigit(ca) && isDigit(cb)) {
      const si = i;
      const sj = j;
      while (i < ax.length && isDigit(ax[i])) i++;
      while (j < bx.length && isDigit(bx[j])) j++;
      const da = ax.slice(si, i).join("");
      const db = bx.slice(sj, j).join("");
      const na = Number.parseInt(da, 10);
      const nb = Number.parseInt(db, 10);
      if (na !== nb) return na - nb;
      if (da.length !== db.length) return da.length - db.length;
    } else {
      if (ca !== cb) return ca < cb ? -1 : 1;
      i++;
      j++;
    }
  }
  return ax.length - i - (bx.length - j);
}

interface Branch {
  node: FilterNode;
  kids: Map<string, Branch>;
}

/** 把一个根的命中拍平成「树序」的行：祖先补齐、同层去重、目录在前自然序。 */
export function treeOf(root: string, hits: NameHit[]): FilterNode[] {
  // Windows 路径不分大小写 ⇒ 去重键一律折成小写（否则换个盘符大小写就画成两棵）
  const keyOf = (path: string): string => path.toLowerCase();
  const top = new Map<string, Branch>();

  for (const h of hits) {
    const parts = h.rel.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let dir = root;
    let siblings = top;
    let depth = 1;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const path = joinPath(dir, parts[i]);
      const key = keyOf(path);
      let branch = siblings.get(key);
      if (!branch) {
        branch = {
          node: { path, name: parts[i], isDir: last ? h.isDir : true, depth, dir, matched: false },
          kids: new Map(),
        };
        siblings.set(key, branch);
      }
      if (last) {
        branch.node.matched = true;
        branch.node.isDir = h.isDir;
        // 后端那条路径是权威（祖先那几层才是自己拼的）
        branch.node.path = h.path;
      }
      dir = branch.node.path;
      siblings = branch.kids;
      depth++;
    }
  }

  const out: FilterNode[] = [];
  const walk = (siblings: Map<string, Branch>): void => {
    const list = [...siblings.values()].sort((x, y) =>
      x.node.isDir === y.node.isDir
        ? naturalCompare(x.node.name, y.node.name)
        : x.node.isDir
          ? -1
          : 1,
    );
    for (const b of list) {
      out.push(b.node);
      walk(b.kids);
    }
  };
  walk(top);
  return out;
}

/**
 * 收起的目录把它的**整棵子孙**一起藏掉。
 * 树序是 DFS ⇒ 只记「当前被藏起来的这一层有多深」，比深度更深的一律跳过即可。
 */
export function visibleOf(nodes: FilterNode[], collapsed: ReadonlySet<string>): FilterNode[] {
  if (collapsed.size === 0) return nodes;
  const lower = new Set([...collapsed].map((p) => p.toLowerCase()));
  const out: FilterNode[] = [];
  let hiddenBelow: number | null = null;
  for (const n of nodes) {
    if (hiddenBelow !== null && n.depth > hiddenBelow) continue;
    hiddenBelow = null;
    out.push(n);
    if (n.isDir && lower.has(n.path.toLowerCase())) hiddenBelow = n.depth;
  }
  return out;
}
