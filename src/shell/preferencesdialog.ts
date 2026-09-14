/**
 * 首选项对话框：把原先「设置 → 首选项」子菜单散落的偏好收拢成一个弹窗，
 * 并补上更精细的选项（编辑器字体、字号、编辑器行距）。
 *
 * - 与快捷键对话框同一套模态骨架（settings-overlay / settings-dialog）。
 * - 每个控件 change 即回调 main 里的 setter：立即生效 + 立即持久化，
 *   不需要「保存」按钮（「确定」只负责关窗）。
 * - **不放「自动换行 / 自动保存 / 快捷键」**：这三项是高频开关，
 *   分别由「查看」菜单、「设置」菜单的勾选项与「设置 → 快捷键…」直接给出，
 *   放进弹窗只会让「改一个开关要多点三层」。
 */

export type ThemeChoice = "system" | "light" | "dark";

export interface PreferencesDialogOptions {
  theme: () => ThemeChoice;
  onTheme: (mode: ThemeChoice) => void;
  /** 空串 = 内置默认字体栈 */
  fontFamily: () => string;
  onFontFamily: (family: string) => void;
  fontSize: () => number;
  onFontSize: (px: number) => void;
  editorLineHeight: () => number;
  onEditorLineHeight: (value: number) => void;
  previewLineHeight: () => number;
  onPreviewLineHeight: (value: number) => void;
  tocWidth: () => number;
  onTocWidth: (px: number) => void;
  defaultEol: () => string;
  eolOptions: () => string[];
  onDefaultEol: (value: string) => void;
  defaultEncoding: () => string;
  encodingOptions: () => string[];
  onDefaultEncoding: (value: string) => void;
}

/** 编辑器等宽字体候选（第一个是「默认」占位，value 为空串）。 */
export const FONT_FAMILY_OPTIONS: { label: string; value: string }[] = [
  { label: "默认（Cascadia Code / Consolas…）", value: "" },
  { label: "Cascadia Code", value: "Cascadia Code" },
  { label: "JetBrains Mono", value: "JetBrains Mono" },
  { label: "Consolas", value: "Consolas" },
  { label: "Courier New", value: "Courier New" },
];

/** 编辑器行距候选（倍数）。 */
export const EDITOR_LINE_HEIGHT_OPTIONS = [1.2, 1.5, 1.8, 2.1];

/** 预览行距候选（倍数），沿用原菜单三档。 */
export const PREVIEW_LINE_HEIGHT_OPTIONS = [1.3, 1.7, 2.1];

/** 大纲宽度候选（px），沿用原菜单三档。 */
export const TOC_WIDTH_OPTIONS = [200, 240, 320];

export function showPreferencesDialog(opts: PreferencesDialogOptions): void {
  const overlay = document.createElement("div");
  overlay.className = "settings-overlay";

  const dialog = document.createElement("div");
  dialog.className = "settings-dialog preferences-dialog";

  const title = document.createElement("div");
  title.className = "settings-title";
  title.textContent = "首选项";

  const body = document.createElement("div");
  body.className = "preferences-body";

  const actions = document.createElement("div");
  actions.className = "settings-actions";
  const ok = document.createElement("button");
  ok.className = "settings-ok";
  ok.textContent = "确定";
  actions.append(ok);

  dialog.append(title, body, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  /** 分组标题（外观 / 字体与行距 / 编辑器 / 预览 / 新建文件）。 */
  function group(label: string): void {
    const head = document.createElement("div");
    head.className = "preferences-group";
    head.textContent = label;
    body.appendChild(head);
  }

  /** 下拉行：label + select。返回 select 供调用方填选项。 */
  function selectRow(label: string, onPick: (value: string) => void): HTMLSelectElement {
    const row = document.createElement("div");
    row.className = "settings-row";
    const lab = document.createElement("span");
    lab.className = "settings-label";
    lab.textContent = label;
    const sel = document.createElement("select");
    sel.addEventListener("change", () => onPick(sel.value));
    row.append(lab, sel);
    body.appendChild(row);
    return sel;
  }

  function fillSelect(
    sel: HTMLSelectElement,
    items: { label: string; value: string }[],
    current: string,
  ): void {
    sel.textContent = "";
    for (const it of items) {
      const opt = document.createElement("option");
      opt.value = it.value;
      opt.textContent = it.label;
      opt.selected = it.value === current;
      sel.appendChild(opt);
    }
  }

  /** 数字选择行：label + select（数字档位）。 */
  function numberSelectRow(
    label: string,
    values: number[],
    current: number,
    format: (v: number) => string,
    onPick: (v: number) => void,
  ): void {
    const sel = selectRow(label, (v) => onPick(Number(v)));
    fillSelect(
      sel,
      values.map((v) => ({ label: format(v), value: String(v) })),
      String(current),
    );
  }

  // ---- 外观 ----
  group("外观");
  const themeSel = selectRow("主题", (v) => opts.onTheme(v as ThemeChoice));
  fillSelect(
    themeSel,
    [
      { label: "跟随系统", value: "system" },
      { label: "浅色", value: "light" },
      { label: "深色", value: "dark" },
    ],
    opts.theme(),
  );

  // ---- 字体与行距 ----
  group("字体与行距");
  const fontSel = selectRow("编辑器字体", (v) => opts.onFontFamily(v));
  fillSelect(fontSel, FONT_FAMILY_OPTIONS, opts.fontFamily());

  numberSelectRow(
    "字号（px）",
    [10, 11, 12, 13, 14, 16, 18, 20, 24, 28],
    opts.fontSize(),
    (v) => `${v}px`,
    (v) => opts.onFontSize(v),
  );

  numberSelectRow(
    "编辑器行距",
    EDITOR_LINE_HEIGHT_OPTIONS,
    opts.editorLineHeight(),
    (v) => `${v} 倍`,
    (v) => opts.onEditorLineHeight(v),
  );

  // ---- 预览 ----
  group("Markdown 预览");
  numberSelectRow(
    "预览行距",
    PREVIEW_LINE_HEIGHT_OPTIONS,
    opts.previewLineHeight(),
    (v) => `${v} 倍`,
    (v) => opts.onPreviewLineHeight(v),
  );
  numberSelectRow(
    "大纲宽度",
    TOC_WIDTH_OPTIONS,
    opts.tocWidth(),
    (v) => `${v}px`,
    (v) => opts.onTocWidth(v),
  );

  // ---- 新建文件 ----
  group("新建文件");
  const eolSel = selectRow("默认行尾", (v) => opts.onDefaultEol(v));
  fillSelect(
    eolSel,
    opts.eolOptions().map((e) => ({ label: e, value: e })),
    opts.defaultEol(),
  );
  const encSel = selectRow("默认编码", (v) => opts.onDefaultEncoding(v));
  fillSelect(
    encSel,
    opts.encodingOptions().map((e) => ({ label: e, value: e })),
    opts.defaultEncoding(),
  );

  const close = (): void => {
    document.removeEventListener("keydown", onDocKeyDown, true);
    overlay.remove();
  };

  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };

  ok.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onDocKeyDown, true);
}
