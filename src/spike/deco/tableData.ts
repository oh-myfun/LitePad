// 壳移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor/widgets/table.ts:16-183, 289-372
// 本机参照：E:\Project\InkNote\InkNote
//
// B397-3b · 表格的「源码 ↔ 数据」这一半：纯函数，一个字节都不碰 DOM。
//
// 为什么不借语法树拆格：lezer 的 GFM `Table` 节点只给整张表的 from/to，单元格内容它不拆。
// 而装饰面要把一张表换成可编辑 DOM **并写回源码**，读写都得按格处理 ⇒ InkNote 手写这一对
// 解析/序列化。三条口径是它那边踩过才定下来的，一条都不许改：
//
//   · 只按**未转义**的 `|` 拆格，`\|` 要还原成字面竖线（`splitTableCells`）。
//   · 手写的表格常有残缺行，必须补齐成矩形 —— 否则「第 r 行第 c 格」的索引全乱，
//     写回去就是把内容写到别的列上。
//   · 对齐是**整列**属性（住在分隔行的 `:---:`），所以序列化按 `aligns` 逐列出档位；
//     单元格自己不携带对齐（InkNote 在源码里埋 `<!--inknote-align:x-->` 干这件事，
//     那会把 InkNote 专有的注释写进用户文档，LitePad 不搬 —— 见 tableWidget.ts 文件头）。

import type { Text } from "@codemirror/state";

export type TableAlign = "left" | "center" | "right";

export interface TableRange {
  from: number;
  to: number;
}

export interface TableData {
  header: string[];
  rows: string[][];
  aligns: TableAlign[];
}

/** 工具栏/命令能施加的每一种改动（`delete` 是整张表，走 widget 那条路，这里只回 null）。 */
export type TableEditAction =
  | "row-below"
  | "row-above"
  | "row-delete"
  | "col-left"
  | "col-right"
  | "col-delete"
  | "align-left"
  | "align-center"
  | "align-right"
  | "delete";

export interface CellPosition {
  row: number;
  col: number;
}

/** 按未转义的 | 拆分单元格，支持 \| */
function splitTableCells(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      current += "|";
      i++;
    } else if (inner[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += inner[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

function isDelimiterLine(line: string): boolean {
  return /^\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?\|?\s*$/.test(line.trim());
}

function parseAlignments(line: string): TableAlign[] {
  let inner = line.trim();
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  return inner.split("|").map((cell) => {
    const s = cell.trim();
    if (s.startsWith(":") && s.endsWith(":")) return "center";
    if (s.endsWith(":")) return "right";
    return "left";
  });
}

/** 把 Table 节点那一段源码拆成矩阵（语法树只负责「这段是表」，格内容在这里拆）。 */
export function parseTable(node: TableRange, doc: Text): TableData {
  const text = doc.sliceString(node.from, node.to);
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return { header: [], rows: [], aligns: [] };
  }

  const header = splitTableCells(lines[0]);
  let aligns: TableAlign[] = [];
  let bodyStart = 1;
  if (isDelimiterLine(lines[1])) {
    aligns = parseAlignments(lines[1]);
    bodyStart = 2;
  }

  const rows: string[][] = [];
  for (let i = bodyStart; i < lines.length; i++) {
    rows.push(splitTableCells(lines[i]));
  }

  // 手写表格常有残缺行，必须补齐成矩形，否则单元格索引全乱
  const colCount = Math.max(header.length, aligns.length, ...rows.map((r) => r.length), 1);
  while (header.length < colCount) header.push("");
  while (aligns.length < colCount) aligns.push("left");
  for (const row of rows) while (row.length < colCount) row.push("");

  return { header, rows, aligns };
}

function escapeCell(text: string): string {
  return text
    .replace(/\|/g, "\\|")
    .replace(/\r\n?|\n/g, "<br>")
    .trim();
}

function delimCell(align: TableAlign): string {
  switch (align) {
    case "center":
      return ":---:";
    case "right":
      return "---:";
    default:
      return "---";
  }
}

/** 矩阵 → Markdown（每格都补齐成 `| x |` 形状；换行写成 `<br>`，竖线转义）。 */
export function serializeTable(
  header: string[],
  rows: string[][],
  aligns: TableAlign[] = [],
): string {
  const cols = Math.max(
    header.length,
    rows.reduce((max, row) => Math.max(max, row.length), 0),
    aligns.length,
    1,
  );
  const padRow = (cells: string[]) => {
    const row = cells.map(escapeCell);
    while (row.length < cols) row.push("");
    return row;
  };
  const line = (cells: string[]) => `| ${padRow(cells).join(" | ")} |`;
  const alignRow = [...aligns];
  while (alignRow.length < cols) alignRow.push("left");
  const delim = `| ${alignRow.map(delimCell).join(" | ")} |`;

  const headerRow = header.length ? header : Array(cols).fill("");
  const lines = [line(headerRow), delim];
  for (const row of rows) lines.push(line(row));
  return lines.join("\n");
}

export function colCount(data: TableData): number {
  return Math.max(
    data.header.length,
    data.aligns.length,
    data.rows.reduce((max, row) => Math.max(max, row.length), 0),
    1,
  );
}

function emptyRow(cols: number): string[] {
  return Array(cols).fill("");
}

/**
 * 施加一种改动，返回新矩阵与「焦点该落在哪一格」。
 *
 * 纯函数：不改入参（回写那一发要拿它算 `serializeTable`，改坏入参等于把表改花）。
 * 表头那几支是 InkNote 的原语义：在表头上插行 = 表头整行下移成数据行、上面空出一行新表头；
 * 删表头 = 第一条数据行升格成表头（Markdown 的表不许没有表头行）。
 */
export function mutateTableData(
  data: TableData,
  row: number,
  col: number,
  action: TableEditAction,
): { data: TableData; focus: CellPosition } | null {
  const next: TableData = {
    header: [...data.header],
    rows: data.rows.map((r) => [...r]),
    aligns: [...data.aligns],
  };
  const cols = colCount(next);
  const empty = emptyRow(cols);
  const isHeader = row === 0;

  switch (action) {
    case "row-above": {
      // 两个分支各定一次焦点行，所以这里只声明不赋初值（InkNote 原样是 `= row`，
      // 本仓 lint 的 no-useless-assignment 会把那个初值判成死赋值）
      let focusRow: number;
      if (isHeader) {
        next.rows.unshift([...next.header]);
        next.header = empty;
        focusRow = 0;
      } else {
        next.rows.splice(row - 1, 0, empty);
        focusRow = row;
      }
      return { data: next, focus: { row: focusRow, col } };
    }
    case "row-below": {
      let focusRow: number;
      if (isHeader) {
        next.rows.splice(0, 0, empty);
        focusRow = 1;
      } else {
        next.rows.splice(row, 0, empty);
        focusRow = row + 1;
      }
      return { data: next, focus: { row: focusRow, col } };
    }
    case "row-delete": {
      if (isHeader) {
        if (next.rows.length === 0) return null;
        next.header = [...next.rows[0]];
        next.rows.shift();
        return { data: next, focus: { row: 0, col } };
      }
      next.rows.splice(row - 1, 1);
      return { data: next, focus: { row: Math.min(row, next.rows.length), col } };
    }
    case "col-left": {
      const at = col;
      next.header.splice(at, 0, "");
      next.aligns.splice(at, 0, "left");
      for (const r of next.rows) r.splice(at, 0, "");
      return { data: next, focus: { row, col: at } };
    }
    case "col-right": {
      const at = col + 1;
      next.header.splice(at, 0, "");
      next.aligns.splice(at, 0, "left");
      for (const r of next.rows) r.splice(at, 0, "");
      return { data: next, focus: { row, col: at } };
    }
    case "col-delete": {
      if (cols <= 1) return null;
      next.header.splice(col, 1);
      next.aligns.splice(col, 1);
      for (const r of next.rows) r.splice(col, 1);
      return { data: next, focus: { row, col: Math.min(col, colCount(next) - 1) } };
    }
    case "align-left":
    case "align-center":
    case "align-right": {
      const align = action.slice("align-".length) as TableAlign;
      while (next.aligns.length <= col) next.aligns.push("left");
      next.aligns[col] = align;
      return { data: next, focus: { row, col } };
    }
    case "delete":
      return null;
    default:
      return null;
  }
}
