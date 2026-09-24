// 关于页（B107 修复：版本号必须来自运行时 getVersion，不得写死）。
// 应用经 tauri build 注入 version，更新后 relaunch 新 exe，getVersion() 即返回新版本。
import { ask } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";

const ABOUT_BODY = "轻量级 Markdown / 文本编辑器（Tauri 2 + CodeMirror 6）\n\n仅 Windows 平台。";

/** 弹出「关于 LitePad」对话框，标题栏展示当前已安装的真实版本号。 */
export async function showAbout(): Promise<void> {
  let version = "未知";
  try {
    version = await getVersion();
  } catch {
    // 非 Tauri 运行时（如纯前端开发预览）拿不到版本，降级为占位而非崩溃
  }
  await ask(`LitePad v${version}\n${ABOUT_BODY}`, {
    title: "关于 LitePad",
    kind: "info",
    okLabel: "确定",
    cancelLabel: "关闭",
  });
}
