/**
 * 应用内自动更新（B107，方案 A：官方 tauri-plugin-updater）。
 *
 * 链路：启动后延迟静默检查一次 → 之后按间隔静默轮询；「帮助 → 检查更新」走手动检查。
 * 更新键钉在标题栏 `.title-actions` 的**第一个孩子**（= 「左栏开关」那颗键的左边，B311），
 * 一颗键按阶段换画法（2026-11-19 用户在三套样例里选了 InkNote 文字条）：
 *   checking    = 胶囊 + 旋转图标「正在检查更新…」（**只有手动检查才亮**，自动检查不打扰）
 *   available   = 填 accent 的胶囊「更新到 vX」，点击开始下载安装；
 *   downloading = 胶囊「下载中 42%」+ 底部 2px 进度线；
 *   ready       = 填 accent 的胶囊「重启以更新」，点击保存现场后 relaunch。
 * 文字条比原来的 24px 圆环多说得清「多少百分比」；图标仍一律走 codicon，不许手绘 SVG，
 * 这条守卫在 `tests/updater.test.ts` 里钉着。
 *
 * 与 InkNote 同款的关键纪律：
 *   · **自动检查失败一律静默**（console.warn）——断网 / 404 是常态，不能打扰写作；
 *     手动检查失败才写状态栏。
 *   · 防重入：检查与安装各自一把 busy 锁，菜单连点/轮询重叠都不会双跑。
 *   · 安装会杀进程：动手前先 `persist()` 落盘会话现场（热退出同款），重启后靠
 *     会话恢复回到原样。
 *
 * 更新源与签名见 `src-tauri/tauri.conf.json` 的 `plugins.updater`（GitHub Releases 静态
 * feed `latest.json`，minisign 验签）；私钥在项目外 `~/.tauri/litepad.key`，绝不入库。
 */

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { CODICONS } from "./codicons";
import { setTip } from "./tooltip";

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready";

export interface UpdaterOptions {
  /** 标题栏工具键容器（.title-actions）：更新键动态创建，插在**最左边**。 */
  host: HTMLElement;
  /** 状态栏提示出口（main.ts 的 showMessage）。 */
  showMessage: (text: string, isError?: boolean) => void;
  /** 重启 / 安装前保存现场（热退出同款 persistSession）。 */
  persist: () => void | Promise<void>;
  /** 启动后首次静默检查的延迟（ms）；0 表示只由手动触发。 */
  initialDelayMs?: number;
  /** 静默轮询间隔（ms）；0 表示不轮询。 */
  intervalMs?: number;
}

export interface UpdaterHandle {
  /** 手动检查（帮助 → 检查更新…）：结果写状态栏。 */
  checkNow: () => Promise<void>;
}

export function initUpdater(opts: UpdaterOptions): UpdaterHandle {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "title-btn upd-btn";
  btn.style.display = "none"; // .title-btn 的 inline-flex 会压掉 [hidden]，直接控 display
  btn.setAttribute("aria-label", "检查更新");
  // B311：插在容器的**第一个孩子**前面 ⇒ 落在「左栏开关」那颗键的左边（用户点名）。
  // 不写死 id：生产里第一个孩子是 #sidebar-toggle，测试宿主里是别的键，都插到最前。
  opts.host.insertBefore(btn, opts.host.firstElementChild);

  let phase: UpdatePhase = "idle";
  let pending: Update | null = null;
  let version = "";
  let percent = 0;
  let busy = false; // 检查/安装共用的防重入锁

  // 键的骨架只建一次：图标 / 文字 / 底部进度线。下载时每 1% 只改文字与线宽，
  // 不重建 DOM（重建会让胶囊闪一下，也会丢掉正在进行的悬停与焦点）。
  btn.innerHTML =
    '<span class="upd-ico"></span><span class="upd-label"></span><span class="upd-track"><i></i></span>';
  const ico = btn.querySelector<HTMLElement>(".upd-ico")!;
  const label = btn.querySelector<HTMLElement>(".upd-label")!;
  const fill = btn.querySelector<HTMLElement>(".upd-track i")!;

  function setIcon(code: string): void {
    if (ico.innerHTML !== code) ico.innerHTML = code;
  }

  /** 按阶段渲染按钮：文字条即状态（InkNote 款，百分比 + 底部细线）。 */
  function render(): void {
    btn.classList.toggle("is-spin", phase === "checking");
    btn.dataset.phase = phase;
    if (phase === "idle") {
      btn.style.display = "none";
      return;
    }
    btn.style.display = "";
    // 检查中 / 下载中没有可点的动作：用原生 disabled，光标自然回到箭头，
    // 也免得连点触发第二轮。点击处理器只认 available 与 ready 两档。
    btn.disabled = phase === "checking" || phase === "downloading";
    if (phase === "available") {
      setIcon(CODICONS.cloudDownload);
      label.textContent = `更新到 v${version}`;
      setTip(btn, `发现新版本 v${version}`, { detail: "点击下载并安装" });
      btn.setAttribute("aria-label", `发现新版本 v${version}，点击下载安装`);
    } else if (phase === "checking") {
      setIcon(CODICONS.refresh);
      label.textContent = "正在检查更新…";
      setTip(btn, "正在检查更新…", { detail: "手动检查" });
      btn.setAttribute("aria-label", "正在检查更新");
    } else if (phase === "downloading") {
      setIcon(CODICONS.cloudDownload);
      label.textContent = `下载中 ${percent}%`;
      fill.style.width = `${percent}%`;
      setTip(btn, `正在下载 v${version}…`, { detail: `${percent}%` });
      btn.setAttribute("aria-label", `正在下载更新 v${version}，已完成 ${percent}%`);
    } else {
      setIcon(CODICONS.refresh);
      label.textContent = "重启以更新";
      setTip(btn, `v${version} 已就绪`, { detail: "点击重启以完成更新" });
      btn.setAttribute("aria-label", `更新 v${version} 已就绪，点击重启完成更新`);
    }
  }

  async function checkNow(silent: boolean): Promise<void> {
    if (busy) {
      if (!silent) opts.showMessage("更新检查正在进行，请稍候");
      return;
    }
    if (pending) {
      if (!silent) opts.showMessage(`已有可用更新：v${version}（标题栏那颗更新键）`);
      return;
    }
    busy = true;
    // 只有手动检查才亮旋转环；静默自动检查（启动一次 + 每 6 小时轮询）照旧什么都不显示
    if (!silent) {
      phase = "checking";
      render();
    }
    try {
      const update = await check();
      if (!update) {
        if (!silent) opts.showMessage("当前已是最新版本");
        return;
      }
      pending = update;
      version = update.version;
      phase = "available";
      render();
      opts.showMessage(`发现新版本 v${version}，点击更新键下载安装`);
    } catch (err) {
      // ⚠️ 自动检查（silent）失败必须静默：断网 / 404 / 源不可达都是常态
      if (silent) console.warn("自动检查更新失败", err);
      else opts.showMessage(`检查更新失败：${String(err)}`, true);
    } finally {
      // 查完还是「检查中」⇒ 说明没有可用更新（或失败），文字条收回去；
      // 查到更新的分支已把 phase 改成 available，这里不该再动它。
      if (phase === "checking") {
        phase = "idle";
        render();
      }
      busy = false;
    }
  }

  async function install(): Promise<void> {
    if (busy || !pending) return;
    busy = true;
    phase = "downloading";
    percent = 0;
    render();
    try {
      // 安装会杀掉当前进程：先把会话现场落盘（热退出同款），重启后靠会话恢复回原样
      await opts.persist();
      let downloaded = 0;
      let total = 0;
      let lastPercent = -1;
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          percent = total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : 0;
          if (percent !== lastPercent) {
            lastPercent = percent;
            render();
          }
        } else if (event.event === "Finished") {
          phase = "ready";
          percent = 100;
          render();
        }
      });
      // 走到这里 = 安装器已执行完（passive 模式）；再保险落一次现场，然后重启上新版
      await opts.persist();
      await relaunch();
    } catch (err) {
      // 下载/安装失败：退回 available 态（按钮还在，可重试），状态栏说明原因
      phase = pending ? "available" : "idle";
      percent = 0;
      render();
      opts.showMessage(`更新安装失败：${String(err)}`, true);
    } finally {
      busy = false;
    }
  }

  btn.addEventListener("click", () => {
    if (phase === "available") void install();
    else if (phase === "ready")
      void (async () => {
        await opts.persist();
        await relaunch();
      })();
  });

  render();

  // 静默检查节奏（InkNote 同款）：启动后延迟一次，之后按间隔轮询；0 表示关闭
  const initialDelay = opts.initialDelayMs ?? 8000;
  const interval = opts.intervalMs ?? 6 * 60 * 60 * 1000;
  let started = false;
  if (initialDelay > 0) {
    setTimeout(() => {
      if (started) return;
      started = true;
      void checkNow(true);
    }, initialDelay);
  }
  if (interval > 0) {
    setInterval(() => void checkNow(true), interval);
  }

  return { checkNow: () => checkNow(false) };
}
