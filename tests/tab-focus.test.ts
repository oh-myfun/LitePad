// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderTabstrip } from "../src/shell/tabstrip";

function build() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const tabs = [{ tabId: 1, name: "a.md", dirty: false, readonly: false, active: true }];
  renderTabstrip(host, tabs, { onActivate, onClose });
  return { host, onActivate, onClose };
}

// B182：切标签时「光标一闪而过」的根因是标签 mousedown 把编辑器焦点抢到了 body，
// 我们虽然在 click 里把焦点还回编辑器，但 WebView2 在整次手势结束后把焦点重新定到
// body，于是 `cm-focused` 被 CM6 的失焦兜底摘掉 —— 光标闪一下就没了。
//
// ⚠️ 但「拦掉左键 mousedown 的默认焦点挪动」这个修法**不能要**：Chromium 桌面端（含
// WebView2）一旦取消 mousedown 的默认动作，**原生 HTML5 拖拽也会被一并取消**（拖拽由
// mousedown→mousemove 阈值触发，默认动作被取消即起不来）—— 结果是标签完全拖不动，连
// 「拖到卫星窗口」都失效。所以这里只锁「左键 mousedown 不得 preventDefault」（保拖拽），
// 焦点副作用改由 `main.ts` 的 `switchTab` 延迟一拍补焦点来化解（见 cursor-keep.test.ts
// 的 B182 续契约）。
describe("B182 标签 mousedown 必须保住原生拖拽", () => {
  it("左键按下不能 preventDefault（否则标签完全拖不动，含拖到卫星窗口）", () => {
    const { host } = build();
    const tab = host.querySelector(".tab") as HTMLElement;
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    tab.dispatchEvent(ev);
    expect(ev.defaultPrevented, "左键 mousedown 不得拦默认动作，否则原生拖拽被一并取消").toBe(
      false,
    );
  });

  it("preventDefault 不挡 click：点击仍触发 onActivate", () => {
    const { host, onActivate } = build();
    const tab = host.querySelector(".tab") as HTMLElement;
    tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onActivate, "click 必须仍能切标签").toHaveBeenCalledWith(1);
  });

  it("关闭按钮的 mousedown 不被拦（关闭仍可用）", () => {
    const { host, onClose } = build();
    const close = host.querySelector(".tab-close") as HTMLElement;
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    close.dispatchEvent(ev);
    expect(ev.defaultPrevented, "关闭按钮不应被拦").toBe(false);
    close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose, "关闭按钮 click 仍能关").toHaveBeenCalledWith(1);
  });

  it("中键仍可关闭标签", () => {
    const { host, onClose } = build();
    const tab = host.querySelector(".tab") as HTMLElement;
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 }));
    expect(onClose, "中键 mousedown 仍能关").toHaveBeenCalledWith(1);
  });
});
