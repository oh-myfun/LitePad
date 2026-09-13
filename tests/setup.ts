// 共享 jsdom 环境桩（在 vite.config.ts 的 test.setupFiles 注册，对所有测试文件生效）。
//
// 目的：把「jsdom 24 与真实 WebView2(Chromium) 的差距」集中收口到一处，
// 避免每个测试文件各抄一份贴片。此前 smoke.bootstrap / view-switch-noedit 各自
// 本地打了 Range 桩，而 toc-follows-panel 漏打 → 用例虽全过，jsdom 却在
// mousedown 处理里抛出未捕获异常，使 vitest 以非 0 退出、pre-push 钩子误拦推送。
// 新增测试文件不再需要自行打桩。

type RangeLikeProto = { getClientRects?: unknown; getBoundingClientRect?: unknown };

if (typeof window !== "undefined") {
  // 1) matchMedia：jsdom 未实现，主题/深浅色代码依赖
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as unknown as typeof window.matchMedia;
  }

  // 2) requestAnimationFrame / cancelAnimationFrame：**无条件覆盖**。
  //    jsdom 自带的实现走 16 ms 视觉时钟且在测试里不可靠，会让「等一帧」的用例
  //    逼近 5 s 默认超时（view-switch-noedit 曾因此稳定超时）。统一换成
  //    setTimeout(0)，与既有可稳定通过的配置一致。
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(
      () => cb(performance.now()),
      0,
    ) as unknown as number) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id)) as typeof window.cancelAnimationFrame;

  // 3) Range.getClientRects / getBoundingClientRect：jsdom 24 未实现，
  //    而 CodeMirror 在 mousedown 处理里会调用 → 「getClientRects is not a function」。
  const rangeProto = window.Range?.prototype as unknown as RangeLikeProto | undefined;
  if (rangeProto && typeof rangeProto.getClientRects !== "function") {
    rangeProto.getClientRects = () => [] as unknown as DOMRectList;
    rangeProto.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
  }
}
