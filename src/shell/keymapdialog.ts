/**
 * 快捷键说明对话框（只读）。
 *
 * 原「设置与快捷键」对话框已拆散：设置项分别归入 文件 / 查看 菜单
 * （自动保存、新建默认值 → 文件；主题、预览行距、大纲宽度 → 查看），
 * 帮助菜单只保留这份只读的快捷键清单。
 */

const KEYMAP_DOC: [string, string][] = [
  ["Ctrl+N", "新建标签"],
  ["Ctrl+O", "打开文件"],
  ["Ctrl+S", "保存"],
  ["Ctrl+Shift+S", "另存为"],
  ["Ctrl+Alt+S", "全部保存"],
  ["Ctrl+W", "关闭标签"],
  ["Ctrl+Tab / Ctrl+Shift+Tab", "切换标签"],
  ["Ctrl+PgUp / Ctrl+PgDn", "切换标签"],
  ["Ctrl+F", "查找（悬浮栏）"],
  ["Ctrl+H", "替换（悬浮栏，聚焦替换框）"],
  ["F3 / Shift+F3", "查找下一个 / 上一个"],
  ["Ctrl+G", "转到行"],
  ["Ctrl+/", "Markdown 源码 / 预览切换"],
  ["Ctrl+Shift+[ / ]", "折叠全部 / 展开全部"],
  ["Ctrl+= / Ctrl+- / Ctrl+0", "放大 / 缩小 / 重置字号"],
  ["F5", "插入时间 / 日期"],
  ["Alt+F / E / V / H", "打开对应菜单"],
];

export function showKeymapDialog(): void {
  const overlay = document.createElement("div");
  overlay.className = "settings-overlay";

  const dialog = document.createElement("div");
  dialog.className = "settings-dialog keymap-dialog";

  const title = document.createElement("div");
  title.className = "settings-title";
  title.textContent = "快捷键";

  const grid = document.createElement("div");
  grid.className = "settings-keys";
  for (const [k, desc] of KEYMAP_DOC) {
    const line = document.createElement("div");
    const kbd = document.createElement("span");
    kbd.className = "settings-kbd";
    kbd.textContent = k;
    line.append(kbd, document.createTextNode(` ${desc}`));
    grid.appendChild(line);
  }

  const actions = document.createElement("div");
  actions.className = "settings-actions";
  const ok = document.createElement("button");
  ok.className = "settings-ok";
  ok.textContent = "确定";
  actions.append(ok);

  dialog.append(title, grid, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const close = (): void => overlay.remove();
  ok.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  ok.focus();
}
