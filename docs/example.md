# LitePad 示例文档

> 轻量，但不将就。

这是一份用于演示 LitePad 渲染能力的样例文档：**左侧源码、右侧实时预览**，
配合大纲 TOC 与同步滚动，写完即可见。

## 特性一览

| 能力 | 说明 | 快捷键 |
| --- | --- | --- |
| 自由分屏 | 侧边分屏，各面板独立标签 | `Alt+Shift+→` |
| 源码 ↔ 预览 | 同一份 Markdown 一键切换 | `Ctrl+/` |
| 大纲 TOC | 左侧抽屉，点击跳转 | `Ctrl+Shift+O` |
| 代码块折叠 | 折叠光标处 / 全部 | `Ctrl+Shift+[` |
| 查找替换 | 悬浮查找栏，支持跨文档 | `Ctrl+F` / `Ctrl+H` |

- [x] 多标签、自由分屏、会话恢复
- [x] 自动保存、外部修改监听
- [ ] 插件商店（**明确不做**）

## 代码高亮

代码按需加载高亮器，不用的语言不进首屏体积：

```ts
// 同步滚动：编辑 ↔ 预览按 block 锚点对齐
export function syncPreview(line: number): void {
  const block = findBlockBySourceLine(line);
  if (!block) return;
  preview.scrollTo({ top: block.offsetTop, behavior: "smooth" });
}
```

## 行内元素

支持 **加粗**、*斜体*、~~删除线~~、[链接](https://github.com/oh-myfun/LitePad)
与 `行内代码`；数学公式 $E = mc^2$ 由 KaTeX 懒加载渲染。

## 引用

> 编辑器只做一件事：把字写顺。
> 其余的交给预览。
