export type ThemeMode = "system" | "light" | "dark";

/**
 * VS Code 默认主题族（B377）。每一族都有深/浅两档，由 `ThemeMode` 决定用哪一档：
 *   · 2026    —— VS Code 2026 Dark / Light（**默认**，新版配色）
 *   · modern  —— Dark Modern / Light Modern
 *   · plus    —— Dark+ / Light+
 *   · classic —— Visual Studio Dark / Light
 *   · hc      —— Default High Contrast / High Contrast Light
 * 取值存 `settings.theme_family`；未知值一律回落到 2026，方便日后增删族名。
 */
export type ThemeFamily = "2026" | "modern" | "plus" | "classic" | "hc";

export const DEFAULT_THEME_FAMILY: ThemeFamily = "2026";

const STORAGE_FALLBACK_KEY = "litepad.theme";
const STORAGE_FAMILY_KEY = "litepad.themeFamily";

/**
 * 把主题模式与主题族落到 DOM 上。system 模式跟随系统偏好。
 * 返回最终生效的明暗值，供 CodeMirror 同步配色。
 */
export function applyTheme(mode: ThemeMode, family: ThemeFamily): boolean {
  const dark =
    mode === "dark" ||
    (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themeFamily = family;
  try {
    localStorage.setItem(STORAGE_FALLBACK_KEY, mode);
    // 首帧镜像：index.html 的内联脚本在模块脚本之前读它，先把 data-theme-family 定下来。
    localStorage.setItem(STORAGE_FAMILY_KEY, family);
  } catch {
    // localStorage 不可用时静默忽略，Rust 侧 settings.json 才是主存储
  }
  return dark;
}

export function themeLabel(mode: ThemeMode): string {
  return mode === "system" ? "跟随系统" : mode === "light" ? "亮色" : "暗色";
}

export function themeFamilyLabel(family: ThemeFamily): string {
  switch (family) {
    case "modern":
      return "VS Code Modern";
    case "plus":
      return "VS Code Plus";
    case "classic":
      return "VS Code 经典";
    case "hc":
      return "VS Code 高对比度";
    default:
      return "VS Code 2026";
  }
}

/**
 * 仅在 system 模式下监听系统主题变化。返回一个取消监听的函数。
 */
export function watchSystemTheme(
  getMode: () => ThemeMode,
  onDarkChanged: (dark: boolean) => void,
): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (e: MediaQueryListEvent) => {
    if (getMode() === "system") {
      onDarkChanged(e.matches);
    }
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

export function normalizeMode(raw: string | undefined | null): ThemeMode {
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function normalizeFamily(raw: string | undefined | null): ThemeFamily {
  return raw === "modern" || raw === "plus" || raw === "classic" || raw === "hc" ? raw : "2026";
}
