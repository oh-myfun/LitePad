import { closePopupMenu, showPopupMenu, type MenuItem } from "./menu";

/**
 * 菜单栏（文件 / 编辑 / 查看 / 帮助）。
 *
 * 结构参考 Win11 记事本：点击展开下拉，hover 自动切换已打开的菜单。
 * 「文件 → 设置」打开统一设置页（B106：把原「设置 → 首选项 / 快捷键」合并为
 *   一个三栏设置页，快捷键作为其中一个分类）。
 * 分屏不占菜单项，只保留快捷键。
 */

/**
 * 主菜单「编码」三组条目（B215）。
 *
 * 由 `main.ts` 的 `encodingMenuModel()` 一处生成，主菜单与状态栏那颗键同取这份——
 * 两边各抄一份列表的话，迟早差一项，而差的那一项表现就是「菜单里有、功能没接上」。
 * ⚠️ 行尾不在编码菜单里（B374）：切换 / 转换都在状态栏那颗行尾键的浮层里。
 */
export interface EncodingMenuModel {
  /** 解读方式：重新载入以该编码解读，不碰磁盘。 */
  encodedIn: MenuItem[];
  /** 转换为：立即按该编码写盘（Notepad++ 的 Convert 语义）。 */
  convertTo: MenuItem[];
  /** 添加 / 移除 BOM（就地切 UTF-8 的 BOM 位，不适用时置灰）。 */
  bom: MenuItem[];
}

export interface MenuBarCallbacks {
  onNew: () => void;
  onOpen: () => void;
  /** B314：打开文件夹（换资源管理器的根）。菜单与命令面板都有入口，默认不配键位。 */
  onOpenFolder: () => void;
  /**
   * B331：关闭文件夹（清根 + 清设置里那一格）。`hasFolderRoot()` 为假时置灰 ——
   * 判据与回调分开放，是因为置灰这件事归菜单（它知道什么时候要问），而「有没有根」归 store。
   */
  onCloseFolder: () => void;
  hasFolderRoot: () => boolean;
  /**
   * B332：「文件 ▸ 打开最近 ▸」里的那一屏。交**函数**而不是数组：子菜单每次展开时求值，
   * 才拿得到当下这份名单（数组的话，菜单建好那一刻就冻住了）。
   */
  recentSubmenu: () => MenuItem[];
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
  /** B389：跨文件那两条的落点是侧栏搜索视图，不是悬浮条（悬浮条只管当前这一份文档）。 */
  onFindInFiles: () => void;
  onReplaceInFiles: () => void;
  onGoto: () => void;
  onSelectAll: () => void;
  onTimeDate: () => void;
  onToggleView: () => void;
  /** B399：预览档（禁编辑）↔ 编辑档；与页面内悬浮键、Ctrl+E 同一动作。 */
  onToggleEdit: () => void;
  onOutline: () => void;
  /** 大纲抽屉展开态（勾选显示） */
  tocChecked: () => boolean;
  /** B314：资源管理器那一块是否正摊着（判据与 `tocChecked` 同一处：外壳的当前视图）。 */
  explorerChecked: () => boolean;
  onExplorer: () => void;
  onFoldAll: () => void;
  onUnfoldAll: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onToggleWrap: () => void;
  /** 菜单展开时实时求值，决定 ✓ 勾选态 */
  wrapChecked: () => boolean;
  onToggleStatusbar: () => void;
  /**
   * 「编码 → 解读 / 转换 / BOM」三组（B215；行尾自 B374 起归状态栏那颗行尾键）。
   *
   * 每次展开重新求值：菜单点开那一刻的文档（活动标签换了、文档改过编码了）才是
   * 要显示的那一组 ✓ —— 像 `exportable()` 那样在求值里现取，别缓存。
   */
  encodingMenu: () => EncodingMenuModel;
  statusbarChecked: () => boolean;
  // ---- 设置 ----
  /** 打开统一设置页（含外观 / 编辑器 / 预览 / 新建文件 / 快捷键各分类） */
  onSettings: () => void;
  // ---- 帮助 ----
  /** 手动检查应用内更新（B107；结果走状态栏提示，自动检查静默） */
  onCheckUpdate: () => void;
  /**
   * 切换 WebView2 开发者工具（B211；帮助 → 切换开发人员工具）。
   *
   * 单键切换：已开则关、未开则开，对齐 VS Code 的「Toggle Developer Tools」。
   * 按用户决定**不配快捷键** —— 键位表是要进设置页、会被三套预设改写的公开配置，
   * 一个纯调试用途的入口不值得占用一个 id。
   */
  onToggleDevtools: () => void;
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
      { label: withKey("打开", cb.keyHint("file.open")), onSelect: cb.onOpen },
      {
        label: withKey("打开文件夹", cb.keyHint("file.openFolder")),
        onSelect: cb.onOpenFolder,
      },
      {
        // B331：与上一颗配成一对。没开文件夹时置灰（点亮它 = 把盘上那一格写空一次）。
        label: withKey("关闭文件夹", cb.keyHint("file.closeFolder")),
        disabled: !cb.hasFolderRoot(),
        onSelect: cb.onCloseFolder,
      },
      {
        // B332：VS Code 的 File ▸ Open Recent 那一套。条目本身在 `recents/panel.ts` 里排
        //（文件夹一段、文件一段、底部「更多...」），这里只挂入口。
        label: "打开最近",
        submenu: () => cb.recentSubmenu(),
      },
      { separator: true },
      { label: withKey("保存", cb.keyHint("file.save")), onSelect: cb.onSave },
      { label: withKey("另存为", cb.keyHint("file.saveAs")), onSelect: cb.onSaveAs },
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
      { label: "设置", onSelect: cb.onSettings },
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
      { label: withKey("查找", cb.keyHint("edit.find")), onSelect: cb.onFind },
      { label: withKey("查找下一个", cb.keyHint("edit.findNext")), onSelect: cb.onFindNext },
      { label: withKey("查找上一个", cb.keyHint("edit.findPrev")), onSelect: cb.onFindPrev },
      { label: withKey("替换", cb.keyHint("edit.replace")), onSelect: cb.onReplace },
      // B389：跨文件那两条与上面两条并列（VS Code 的 Find 菜单同款次序），落点是侧栏搜索视图。
      {
        label: withKey("在文件中查找", cb.keyHint("edit.findInFiles")),
        onSelect: cb.onFindInFiles,
      },
      {
        label: withKey("在文件中替换", cb.keyHint("edit.replaceInFiles")),
        onSelect: cb.onReplaceInFiles,
      },
      { label: withKey("转到", cb.keyHint("edit.goto")), onSelect: cb.onGoto },
      { separator: true },
      { label: "全选\tCtrl+A", onSelect: cb.onSelectAll },
      { label: withKey("时间/日期", cb.keyHint("edit.timeDate")), onSelect: cb.onTimeDate },
    ],
  },
  {
    label: "查看",
    items: (cb) => [
      { label: withKey("切换 源码 / 预览", cb.keyHint("view.toggle")), onSelect: cb.onToggleView },
      // B399：源码档这一条按不动（动作只在装饰面上成立），菜单不置灰、点它不做事的成本
      // 比维护一份「这一档有没有装饰面」的勾选态低；键位分发那一侧同样不抢键。
      {
        label: withKey("切换 预览 / 编辑", cb.keyHint("view.toggleEdit")),
        onSelect: cb.onToggleEdit,
      },
      {
        label: withKey("大纲 TOC", cb.keyHint("view.outline")),
        checked: cb.tocChecked(),
        onSelect: cb.onOutline,
      },
      {
        // B314：与上面那颗同族（勾 = 这一块正摊着）。三块展开区互斥由外壳一处判，
        // 所以这两条 `checked` 不可能同时为真 —— 不是各读各的面板 hidden。
        label: withKey("资源管理器", cb.keyHint("view.explorer")),
        checked: cb.explorerChecked(),
        onSelect: cb.onExplorer,
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
    label: "编码",
    items: (cb) => {
      // 一次取回三组，省得三遍回调；每组的项在展开时才求值（cb.encodingMenu() 内部）。
      const model = cb.encodingMenu();
      return [
        { label: "解读编码", submenu: () => model.encodedIn },
        { label: "转换为", submenu: () => model.convertTo },
        { separator: true },
        // BOM 两项是叶子，直接摊开（就两条，不值得再套一层子菜单）
        ...model.bom,
      ];
    },
  },
  {
    label: "帮助",
    items: (cb) => [
      { label: "检查更新", onSelect: cb.onCheckUpdate },
      { separator: true },
      // B211：与 VS Code 一样挂在「检查更新」与「关于」之间，顺序照 VS Code 中文版。
      { label: "切换开发人员工具", onSelect: cb.onToggleDevtools },
      { label: "关于 LitePad", onSelect: cb.onAbout },
    ],
  },
];

/**
 * 菜单栏按钮的助记符字母（Alt+字母定位），与 MENUS 顺序一一对应。
 * 渲染成 VS Code 中文版的「标签(字母)」：`文件(F)` / `编辑(E)` / `查看(V)` / `编码(C)` / `帮助(H)`。
 * ⚠️ 字母互不重复：助记符是定位用的，撞了就成了「按哪个都能开菜单」。
 */
const MENU_KEYS = ["F", "E", "V", "C", "H"] as const;

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
