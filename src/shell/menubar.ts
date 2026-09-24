import { closePopupMenu, showPopupMenu, type MenuItem } from "./menu";

/**
 * 菜单栏（文件 / 编辑 / 查看 / 帮助）。
 *
 * 结构参考 Win11 记事本：点击展开下拉，hover 自动切换已打开的菜单。
 * 「文件 → 设置…」打开统一设置页（B106：把原「设置 → 首选项 / 快捷键」合并为
 *   一个三栏设置页，快捷键作为其中一个分类）。
 * 分屏不占菜单项，只保留快捷键。
 */

export interface MenuBarCallbacks {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onSaveAll: () => void;
  /**
   * 导出（B97）：原来只有顶栏那颗导出按钮有入口，按钮移除后搬进「文件 → 导出 ▸」。
   * 两项都是叶子项，`exportable()` 为假时整组置灰。
   */
  onExportHtml: () => void;
  onExportPdf: () => void;
  /** 菜单展开时求值：当前文档能不能导出（非 Markdown 时为假）。 */
  exportable: () => boolean;
  onCloseTab: () => void;
  onExit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDelete: () => void;
  onFind: () => void;
  onFindNext: () => void;
  onFindPrev: () => void;
  onReplace: () => void;
  onGoto: () => void;
  onSelectAll: () => void;
  onTimeDate: () => void;
  onToggleView: () => void;
  onOutline: () => void;
  /** 大纲抽屉展开态（勾选显示） */
  tocChecked: () => boolean;
  onFoldAll: () => void;
  onUnfoldAll: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onToggleWrap: () => void;
  /** 菜单展开时实时求值，决定 ✓ 勾选态 */
  wrapChecked: () => boolean;
  onToggleStatusbar: () => void;
  statusbarChecked: () => boolean;
  onToggleAutosave: () => void;
  autosaveChecked: () => boolean;
  /** 热退出：关窗时把未保存内容写进独立副本，于是关窗不再弹确认框（B68） */
  onToggleHotExit: () => void;
  hotExitChecked: () => boolean;
  // ---- 设置 ----
  /** 打开统一设置页（含外观 / 编辑器 / 预览 / 新建文件 / 快捷键各分类） */
  onSettings: () => void;
  // ---- 帮助 ----
  onAbout: () => void;
  /** 当前生效键位（菜单右侧提示），空串则不显示 */
  keyHint: (id: string) => string;
}

/** 拼接菜单标签：`文字\t快捷键`，快捷键为空时只留文字。 */
function withKey(label: string, hint: string): string {
  return hint ? `${label}\t${hint}` : label;
}

const MENUS: { label: string; items: (cb: MenuBarCallbacks) => MenuItem[] }[] = [
  {
    label: "文件",
    items: (cb) => [
      { label: withKey("新建", cb.keyHint("file.new")), onSelect: cb.onNew },
      { label: withKey("打开…", cb.keyHint("file.open")), onSelect: cb.onOpen },
      { separator: true },
      { label: withKey("保存", cb.keyHint("file.save")), onSelect: cb.onSave },
      { label: withKey("另存为…", cb.keyHint("file.saveAs")), onSelect: cb.onSaveAs },
      { label: withKey("全部保存", cb.keyHint("file.saveAll")), onSelect: cb.onSaveAll },
      {
        // B97：顶栏那颗导出按钮搬到了这里。子菜单每次展开时重新求值，
        // 所以「当前文档是不是 Markdown」取的是展开那一刻的状态。
        label: "导出",
        submenu: [
          {
            label: "导出 HTML（自包含单文件）",
            disabled: !cb.exportable(),
            onSelect: cb.onExportHtml,
          },
          {
            label: "导出 PDF（系统打印对话框）",
            disabled: !cb.exportable(),
            onSelect: cb.onExportPdf,
          },
        ],
      },
      { separator: true },
      { label: "自动保存", checked: cb.autosaveChecked(), onSelect: cb.onToggleAutosave },
      {
        label: "热退出（关窗不询问）",
        checked: cb.hotExitChecked(),
        onSelect: cb.onToggleHotExit,
      },
      { label: "设置…", onSelect: cb.onSettings },
      { separator: true },
      { label: withKey("关闭标签", cb.keyHint("file.close")), onSelect: cb.onCloseTab },
      { label: "退出", onSelect: cb.onExit },
    ],
  },
  {
    label: "编辑",
    items: (cb) => [
      { label: "撤销\tCtrl+Z", onSelect: cb.onUndo },
      { label: "重做\tCtrl+Y", onSelect: cb.onRedo },
      { separator: true },
      { label: "剪切\tCtrl+X", onSelect: cb.onCut },
      { label: "复制\tCtrl+C", onSelect: cb.onCopy },
      { label: "粘贴\tCtrl+V", onSelect: cb.onPaste },
      { label: "删除\tDel", onSelect: cb.onDelete },
      { separator: true },
      { label: withKey("查找…", cb.keyHint("edit.find")), onSelect: cb.onFind },
      { label: withKey("查找下一个", cb.keyHint("edit.findNext")), onSelect: cb.onFindNext },
      { label: withKey("查找上一个", cb.keyHint("edit.findPrev")), onSelect: cb.onFindPrev },
      { label: withKey("替换…", cb.keyHint("edit.replace")), onSelect: cb.onReplace },
      { label: withKey("转到…", cb.keyHint("edit.goto")), onSelect: cb.onGoto },
      { separator: true },
      { label: "全选\tCtrl+A", onSelect: cb.onSelectAll },
      { label: withKey("时间/日期", cb.keyHint("edit.timeDate")), onSelect: cb.onTimeDate },
    ],
  },
  {
    label: "查看",
    items: (cb) => [
      { label: withKey("切换 源码 / 预览", cb.keyHint("view.toggle")), onSelect: cb.onToggleView },
      {
        label: withKey("大纲 TOC", cb.keyHint("view.outline")),
        checked: cb.tocChecked(),
        onSelect: cb.onOutline,
      },
      { separator: true },
      { label: withKey("折叠全部", cb.keyHint("view.foldAll")), onSelect: cb.onFoldAll },
      { label: withKey("展开全部", cb.keyHint("view.unfoldAll")), onSelect: cb.onUnfoldAll },
      { separator: true },
      { label: withKey("放大", cb.keyHint("view.zoomIn")), onSelect: cb.onZoomIn },
      { label: withKey("缩小", cb.keyHint("view.zoomOut")), onSelect: cb.onZoomOut },
      { label: withKey("重置缩放", cb.keyHint("view.zoomReset")), onSelect: cb.onZoomReset },
      { separator: true },
      { label: "自动换行", checked: cb.wrapChecked(), onSelect: cb.onToggleWrap },
      { label: "状态栏", checked: cb.statusbarChecked(), onSelect: cb.onToggleStatusbar },
    ],
  },
  {
    label: "帮助",
    items: (cb) => [{ label: "关于 LitePad", onSelect: cb.onAbout }],
  },
];

/**
 * 菜单栏按钮的助记符字母（Alt+字母定位），与 MENUS 顺序一一对应。
 * 渲染成 VS Code 中文版的「标签(字母)」：`文件(F)` / `编辑(E)` / `查看(V)` / `设置(S)` / `帮助(H)`。
 */
const MENU_KEYS = ["F", "E", "V", "H"] as const;

export function createMenuBar(host: HTMLElement, cb: MenuBarCallbacks): void {
  host.textContent = "";
  let openBtn: HTMLElement | null = null;
  const buttons: HTMLButtonElement[] = [];

  function open(btn: HTMLElement, idx: number): void {
    closePopupMenu();
    openBtn?.classList.remove("menu-open");
    openBtn = btn;
    btn.classList.add("menu-open");
    showPopupMenu(btn, MENUS[idx].items(cb));
  }

  MENUS.forEach((m, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-btn";
    // 助记符按 VS Code 中文版的样子直接拼在标签后面：`文件(F)`。
    // ⚠️ 不再给首字加下划线、也不再往提示里挂「Alt+F」键帽：中文标签靠下划线标助记符
    //    本来就难认（「文」字下面一道线看不出指的是 F），用户明确要求换成括号 + 字母。
    btn.textContent = `${m.label}(${MENU_KEYS[idx]})`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openBtn === btn) {
        closePopupMenu();
        openBtn = null;
        btn.classList.remove("menu-open");
      } else {
        open(btn, idx);
      }
    });
    btn.addEventListener("mouseenter", () => {
      if (openBtn && openBtn !== btn) open(btn, idx);
    });
    host.appendChild(btn);
    buttons.push(btn);
  });

  // 供 Alt+字母 打开对应菜单
  (host as HTMLElement & { openMenuByIndex?: (i: number) => void }).openMenuByIndex = (
    i: number,
  ) => {
    const btn = buttons[i];
    if (btn) btn.click();
  };

  // 菜单被外部点击/Escape 关闭时清除按钮高亮
  const observer = new MutationObserver(() => {
    // 兜底：jsdom 测试环境拆除 DOM 后，MutationObserver 的微任务仍可能触发，
    // 此时 document 已不存在（ReferenceError 会让 vitest 以未捕获异常收尾）。
    // 真实 WebView2 中 document 始终存在，该分支不会命中。
    if (typeof document === "undefined") {
      observer.disconnect();
      return;
    }
    if (!document.querySelector(".popup-menu") && openBtn) {
      openBtn.classList.remove("menu-open");
      openBtn = null;
    }
  });
  observer.observe(document.body, { childList: true });
}

/** 按索引打开菜单（0=文件 … 4=帮助），供 Alt 助记符调用。 */
export function openMenuByIndex(idx: number): void {
  const host = document.getElementById("menu-bar") as
    (HTMLElement & { openMenuByIndex?: (i: number) => void }) | null;
  host?.openMenuByIndex?.(idx);
}
