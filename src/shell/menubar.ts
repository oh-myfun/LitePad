import { closePopupMenu, showPopupMenu, type MenuItem } from "./menu";

/**
 * 菜单栏（文件 / 编辑 / 查看 / 帮助）：点击展开下拉，hover 自动切换已打开的菜单。
 * 结构参考 Win11 记事本：编辑菜单含 剪贴板/查找定位/全选/时间日期，
 * 查看菜单含 缩放/自动换行（勾选态）。
 */

export interface MenuBarCallbacks {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onSaveAll: () => void;
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
  onFindInFiles: () => void;
  onGoto: () => void;
  onSelectAll: () => void;
  onTimeDate: () => void;
  onToggleView: () => void;
  onOutline: () => void;
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
  onSplitH: () => void;
  onSplitV: () => void;
  onClosePanel: () => void;
  // ---- 原「设置」对话框的内容已分散到各菜单：文件（保存/新建默认值）、
  //      查看（主题/行距/大纲宽度）、帮助（快捷键说明）----
  onToggleAutosave: () => void;
  autosaveChecked: () => boolean;
  /** 新建文件的默认行尾 / 编码：以菜单按钮为锚点就地弹二级列表 */
  onDefaultEol: (anchor: HTMLElement) => void;
  onDefaultEncoding: (anchor: HTMLElement) => void;
  /** 主题三态单选 */
  themeChecked: (mode: "system" | "light" | "dark") => boolean;
  onSetTheme: (mode: "system" | "light" | "dark") => void;
  /** Markdown 预览行距（倍数） */
  lineHeightChecked: (value: number) => boolean;
  onSetLineHeight: (value: number) => void;
  /** 大纲抽屉宽度（px） */
  tocWidthChecked: (width: number) => boolean;
  onSetTocWidth: (width: number) => void;
  onKeymap: () => void;
  onAbout: () => void;
}

const MENUS: { label: string; items: (cb: MenuBarCallbacks, anchor: HTMLElement) => MenuItem[] }[] =
  [
    {
      label: "文件",
      items: (cb, anchor) => [
        { label: "新建\tCtrl+N", onSelect: cb.onNew },
        { label: "打开…\tCtrl+O", onSelect: cb.onOpen },
        { separator: true },
        { label: "保存\tCtrl+S", onSelect: cb.onSave },
        { label: "另存为…\tCtrl+Shift+S", onSelect: cb.onSaveAs },
        { label: "全部保存\tCtrl+Alt+S", onSelect: cb.onSaveAll },
        { separator: true },
        { label: "自动保存", checked: cb.autosaveChecked(), onSelect: cb.onToggleAutosave },
        { label: "新建文件默认行尾…", onSelect: () => cb.onDefaultEol(anchor) },
        { label: "新建文件默认编码…", onSelect: () => cb.onDefaultEncoding(anchor) },
        { separator: true },
        { label: "关闭标签\tCtrl+W", onSelect: cb.onCloseTab },
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
        { label: "查找…\tCtrl+F", onSelect: cb.onFind },
        { label: "查找下一个\tF3", onSelect: cb.onFindNext },
        { label: "查找上一个\tShift+F3", onSelect: cb.onFindPrev },
        { label: "替换…\tCtrl+H", onSelect: cb.onReplace },
        { label: "在文件中查找\tCtrl+Shift+F", onSelect: cb.onFindInFiles },
        { label: "转到…\tCtrl+G", onSelect: cb.onGoto },
        { separator: true },
        { label: "全选\tCtrl+A", onSelect: cb.onSelectAll },
        { label: "时间/日期\tF5", onSelect: cb.onTimeDate },
      ],
    },
    {
      label: "查看",
      items: (cb) => [
        { label: "切换 源码 / 预览\tCtrl+/", onSelect: cb.onToggleView },
        { label: "大纲 TOC", onSelect: cb.onOutline },
        { separator: true },
        {
          label: "折叠全部",
          title: "折叠当前文档全部可折叠块（Ctrl+Shift+[）",
          onSelect: cb.onFoldAll,
        },
        {
          label: "展开全部",
          title: "展开当前文档全部折叠（Ctrl+Shift+]）",
          onSelect: cb.onUnfoldAll,
        },
        { separator: true },
        { label: "放大\tCtrl+=", onSelect: cb.onZoomIn },
        { label: "缩小\tCtrl+-", onSelect: cb.onZoomOut },
        { label: "重置缩放\tCtrl+0", onSelect: cb.onZoomReset },
        { separator: true },
        { label: "自动换行", checked: cb.wrapChecked(), onSelect: cb.onToggleWrap },
        { label: "状态栏", checked: cb.statusbarChecked(), onSelect: cb.onToggleStatusbar },
        { separator: true },
        {
          label: "主题：跟随系统",
          checked: cb.themeChecked("system"),
          onSelect: () => cb.onSetTheme("system"),
        },
        {
          label: "主题：浅色",
          checked: cb.themeChecked("light"),
          onSelect: () => cb.onSetTheme("light"),
        },
        {
          label: "主题：深色",
          checked: cb.themeChecked("dark"),
          onSelect: () => cb.onSetTheme("dark"),
        },
        { separator: true },
        {
          label: "预览行距：紧凑",
          checked: cb.lineHeightChecked(1.3),
          onSelect: () => cb.onSetLineHeight(1.3),
        },
        {
          label: "预览行距：标准",
          checked: cb.lineHeightChecked(1.7),
          onSelect: () => cb.onSetLineHeight(1.7),
        },
        {
          label: "预览行距：宽松",
          checked: cb.lineHeightChecked(2.1),
          onSelect: () => cb.onSetLineHeight(2.1),
        },
        { separator: true },
        {
          label: "大纲宽度：窄",
          checked: cb.tocWidthChecked(200),
          onSelect: () => cb.onSetTocWidth(200),
        },
        {
          label: "大纲宽度：默认",
          checked: cb.tocWidthChecked(240),
          onSelect: () => cb.onSetTocWidth(240),
        },
        {
          label: "大纲宽度：宽",
          checked: cb.tocWidthChecked(320),
          onSelect: () => cb.onSetTocWidth(320),
        },
        { separator: true },
        { label: "左右分屏", onSelect: cb.onSplitH },
        { label: "上下分屏", onSelect: cb.onSplitV },
        { label: "移除分屏（标签并入相邻）", onSelect: cb.onClosePanel },
      ],
    },
    {
      label: "帮助",
      items: (cb) => [
        { label: "快捷键…", onSelect: cb.onKeymap },
        { label: "关于 LitePad", onSelect: cb.onAbout },
      ],
    },
  ];

/** 菜单栏按钮（含助记符信息），供 Alt 助记符定位。 */
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
    showPopupMenu(btn, MENUS[idx].items(cb, btn));
  }

  MENUS.forEach((m, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-btn";
    btn.title = `Alt+${MENU_KEYS[idx]}`;
    // 助记符下划线首字（Alt+字母定位）
    btn.innerHTML = `<span class="mnemonic">${m.label[0]}</span>${m.label.slice(1)}`;
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
    if (!document.querySelector(".popup-menu") && openBtn) {
      openBtn.classList.remove("menu-open");
      openBtn = null;
    }
  });
  observer.observe(document.body, { childList: true });
}

/** 按索引打开菜单（0=文件 … 3=帮助），供 Alt 助记符调用。 */
export function openMenuByIndex(idx: number): void {
  const host = document.getElementById("menu-bar") as
    (HTMLElement & { openMenuByIndex?: (i: number) => void }) | null;
  host?.openMenuByIndex?.(idx);
}
