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
import { openExternalUrl } from "../markdown/links";
import { CODICONS } from "./codicons";
import { clearTip, setTip } from "./tooltip";

/** 发布页：与 tauri.conf.json 的 updater endpoint 同仓，固定指向最新 release。 */
const RELEASES_URL = "https://github.com/oh-myfun/LitePad/releases/latest";

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
  // 下载面板要的原始量：字节总数、下载量、平滑后的速度（事件里只有 chunkLength）
  let downloaded = 0;
  let totalBytes = 0;
  let speed = 0;
  let lastSampleAt = 0;
  let lastSampleBytes = 0;

  // 键的骨架只建一次：图标 / 文字 / 底部进度线。下载时每 1% 只改文字与线宽，
  // 不重建 DOM（重建会让胶囊闪一下，也会丢掉正在进行的悬停与焦点）。
  btn.innerHTML =
    '<span class="upd-ico"></span><span class="upd-label"></span><span class="upd-track"><i></i></span>';
  const ico = btn.querySelector<HTMLElement>(".upd-ico")!;
  const label = btn.querySelector<HTMLElement>(".upd-label")!;
  const fill = btn.querySelector<HTMLElement>(".upd-track i")!;

  // 下载中的详情面板（用户 2026-11-19 选定 B 档：标题带百分比、版本一行、
  // 进度条 + 单行统计、一个发布页入口）。挂在键的**紧后面**是为了 Tab 顺序：
  // 固定定位不参与标题栏布局，但 DOM 上紧跟键，键盘用户 Tab 一下就能进到发布页按钮。
  const pop = document.createElement("div");
  pop.className = "upd-pop";
  pop.innerHTML =
    '<div class="upd-pop-head"><span class="upd-pop-title">正在下载更新</span><span class="upd-pop-pct"></span></div>' +
    '<div class="upd-pop-ver"></div>' +
    '<div class="upd-pop-bar"><i></i></div>' +
    '<div class="upd-pop-stats"><span class="upd-pop-bytes"></span><span class="upd-pop-speed"></span></div>' +
    '<button type="button" class="upd-pop-link">打开发布页</button>';
  opts.host.insertBefore(pop, btn.nextSibling);
  const popPct = pop.querySelector<HTMLElement>(".upd-pop-pct")!;
  const popVer = pop.querySelector<HTMLElement>(".upd-pop-ver")!;
  const popFill = pop.querySelector<HTMLElement>(".upd-pop-bar i")!;
  const popBytes = pop.querySelector<HTMLElement>(".upd-pop-bytes")!;
  const popSpeed = pop.querySelector<HTMLElement>(".upd-pop-speed")!;
  const popLink = pop.querySelector<HTMLButtonElement>(".upd-pop-link")!;

  let hideTimer: number | undefined;

  function setIcon(code: string): void {
    if (ico.innerHTML !== code) ico.innerHTML = code;
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const kb = n / 1024;
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
  }

  function formatSpeed(bps: number): string {
    const kb = bps / 1024;
    if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB/s`;
    return `${(kb / 1024).toFixed(1)} MB/s`;
  }

  function formatEta(sec: number): string {
    if (sec < 1) return "不到 1 秒";
    if (sec < 60) return `${Math.ceil(sec)} 秒`;
    return `${Math.ceil(sec / 60)} 分钟`;
  }

  /** 面板只在「下载中」出现；内容随每次 Progress 更新，但 DOM 不重建。 */
  function updatePanel(): void {
    const pct = `${percent}%`;
    popPct.textContent = pct;
    popFill.style.width = pct;
    const from = pending?.currentVersion;
    popVer.textContent = from ? `v${from} → v${version}` : `更新到 v${version}`;
    popBytes.textContent =
      totalBytes > 0
        ? `${formatBytes(downloaded)} / ${formatBytes(totalBytes)}`
        : formatBytes(downloaded);
    popSpeed.textContent =
      speed > 0
        ? `${formatSpeed(speed)}${
            totalBytes > downloaded ? ` · 剩余 ${formatEta((totalBytes - downloaded) / speed)}` : ""
          }`
        : "计算速度…";
  }

  /** 先亮出来再量尺寸：display:none 时 offsetWidth 为 0，量不出面板宽度。 */
  function showPanel(): void {
    if (phase !== "downloading") return;
    updatePanel();
    pop.classList.add("is-open");
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function hidePanel(): void {
    pop.classList.remove("is-open");
  }

  function cancelHide(): void {
    if (hideTimer !== undefined) window.clearTimeout(hideTimer);
    hideTimer = undefined;
  }

  function scheduleHide(): void {
    cancelHide();
    hideTimer = window.setTimeout(hidePanel, 150);
  }

  /** 按阶段渲染按钮：文字条即状态（InkNote 款，百分比 + 底部细线）。 */
  function render(): void {
    btn.classList.toggle("is-spin", phase === "checking");
    btn.dataset.phase = phase;
    if (phase !== "downloading") hidePanel();
    if (phase === "idle") {
      btn.style.display = "none";
      return;
    }
    btn.style.display = "";
    // 检查中 / 下载中没有可点的动作。⚠️ 不用原生 disabled：禁用控件不派发
    // mouseenter，下载中的悬停面板就永远弹不出来；用 .is-disabled（光标约定
    // 也认这个类）+ aria-disabled，点击由下面的处理器只认 available / ready。
    const inert = phase === "checking" || phase === "downloading";
    btn.classList.toggle("is-disabled", inert);
    btn.setAttribute("aria-disabled", String(inert));
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
      // 下载中改由详情面板承载字节/速度，普通 tooltip 会和面板叠在一起
      clearTip(btn);
      updatePanel();
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
    downloaded = 0;
    totalBytes = 0;
    speed = 0;
    lastSampleAt = 0;
    lastSampleBytes = 0;
    render();
    try {
      // 安装会杀掉当前进程：先把会话现场落盘（热退出同款），重启后靠会话恢复回原样
      await opts.persist();
      let lastPercent = -1;
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? 0;
          lastSampleAt = performance.now();
          lastSampleBytes = 0;
          updatePanel();
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          percent = totalBytes > 0 ? Math.min(100, Math.floor((downloaded / totalBytes) * 100)) : 0;
          // 速度按 200ms 以上的间隔采样并做 EMA：太密的 chunk 会让瞬时值乱跳
          const now = performance.now();
          const dt = now - lastSampleAt;
          if (dt >= 200) {
            const inst = (downloaded - lastSampleBytes) / (dt / 1000);
            speed = speed > 0 ? speed * 0.7 + inst * 0.3 : inst;
            lastSampleAt = now;
            lastSampleBytes = downloaded;
          }
          // 面板跟着每个 chunk 更新字节/速度；按钮只在整数百分比变化时重画
          updatePanel();
          if (percent !== lastPercent) {
            lastPercent = percent;
            render();
          }
        } else if (event.event === "Finished") {
          phase = "ready";
          percent = 100;
          speed = 0;
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

  // 面板的悬停/焦点闭环：离开键 150ms 后才收，给指针跨过 6px 间隙进面板留时间；
  // 焦点从键移到面板里的按钮时保持展开，Tab 出去或 Esc 才收。
  let skipFocusShow = false;
  btn.addEventListener("mouseenter", () => {
    cancelHide();
    showPanel();
  });
  btn.addEventListener("mouseleave", scheduleHide);
  pop.addEventListener("mouseenter", cancelHide);
  pop.addEventListener("mouseleave", scheduleHide);
  btn.addEventListener("focus", () => {
    if (skipFocusShow) {
      skipFocusShow = false;
      return;
    }
    showPanel();
  });
  btn.addEventListener("blur", (e) => {
    const to = e.relatedTarget as Node | null;
    if (!to || !pop.contains(to)) hidePanel();
  });
  pop.addEventListener("focusout", (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && (to === btn || pop.contains(to))) return;
    hidePanel();
  });
  const onPanelKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !pop.classList.contains("is-open")) return;
    // 收面板并把焦点还给键；这次 focus 不能再把面板弹开
    skipFocusShow = true;
    hidePanel();
    btn.focus();
    window.setTimeout(() => {
      skipFocusShow = false;
    }, 0);
  };
  btn.addEventListener("keydown", onPanelKey);
  pop.addEventListener("keydown", onPanelKey);
  popLink.addEventListener("click", () => {
    void openExternalUrl(RELEASES_URL);
    hidePanel();
  });
  window.addEventListener("resize", hidePanel);

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
