export type ThemeMode = "system" | "light" | "dark";

const STORAGE_FALLBACK_KEY = "litepad.theme";

/**
 * 把主题模式落到 DOM 上。system 模式跟随系统偏好。
 * 返回最终生效的明暗值，供 CodeMirror 同步配色。
 */
export function applyTheme(mode: ThemeMode): boolean {
  const dark =
    mode === "dark" ||
    (mode === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try {
    localStorage.setItem(STORAGE_FALLBACK_KEY, mode);
  } catch {
    // localStorage 不可用时静默忽略，Rust 侧 settings.json 才是主存储
  }
  return dark;
}

export function themeLabel(mode: ThemeMode): string {
  return mode === "system" ? "跟随系统" : mode === "light" ? "亮色" : "暗色";
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
