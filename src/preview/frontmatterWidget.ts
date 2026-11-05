// 移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor/widgets/frontmatter.ts:1-77
// 本机参照：E:\Project\InkNote\InkNote
//
// B407 · YAML Front Matter 块（智能体技能 SKILL.md、笔记元信息都靠它）。
// 以前这一段在装饰面里是「整段跳过、原样显示」—— lezer 会把 `title: x` + `---` 判成
// SetextHeading2，只能不装饰；用户看到的是光秃秃的 YAML 行，编辑也没有卡片感。
// 现在整段换成一块可编辑的 YAML 盒：点盒子留白进入编辑，文字区直接打字即回写。
//
// 与 InkNote 的唯一差异：没有 i18n 层，标签用固定的 "YAML Front Matter"。

import { WidgetType } from "@codemirror/view";
import { bindBlockBoundaryCursor, stampBlockRange } from "./blockRange";
import {
  attachSourceEditing,
  beginSourceEditing,
  clickedOnBlockPadding,
  makePlainTextEditable,
} from "./editableSource";

export class FrontMatterWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly body: string,
  ) {
    super();
  }

  eq(other: FrontMatterWidget): boolean {
    return other.to - other.from === this.to - this.from && other.body === this.body;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "md-frontmatter-widget";
    stampBlockRange(wrap, this.from, this.to);

    const label = document.createElement("div");
    label.className = "md-frontmatter-label";
    label.contentEditable = "false";
    label.textContent = "YAML Front Matter";

    const source = document.createElement("div");
    source.className = "md-block-source md-frontmatter-source";
    makePlainTextEditable(source);
    source.textContent = this.body;

    // 外层只留白，视觉盒子在内层（根元素的纵向 margin 会破坏 CM6 的高度测量）
    const box = document.createElement("div");
    box.className = "md-frontmatter-box";
    box.append(label, source);
    wrap.appendChild(box);
    bindBlockBoundaryCursor(wrap, box);

    attachSourceEditing(wrap, {
      source: () => source,
      toMarkdown: (text) => `---\n${text.replace(/\n+$/, "")}\n---`,
      indentOnTab: true,
    });

    wrap.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement;
      if (!box.contains(target)) return;
      if (source.contains(target) || target === source) return;
      event.preventDefault();
      beginSourceEditing(wrap, source);
    });

    return wrap;
  }

  updateDOM(dom: HTMLElement): boolean {
    const source = dom.querySelector<HTMLElement>(".md-block-source");
    if (!source) return false;
    stampBlockRange(dom, this.from, this.to);
    if (document.activeElement !== source && (source.textContent ?? "") !== this.body) {
      source.textContent = this.body;
    }
    return true;
  }

  ignoreEvent(event: Event): boolean {
    return !clickedOnBlockPadding(event, "md-frontmatter-widget");
  }
}

/** 正文里能认出至少一个 `key:` 才算 YAML 块（两条 `---` 的分割线不算）。 */
export function looksLikeFrontMatter(body: string): boolean {
  return /^[ \t]*[\w.-]+[ \t]*:/m.test(body);
}
