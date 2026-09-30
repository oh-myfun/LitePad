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
// body，于是 `cm-focused` 被 CM6 的失焦兜底摘掉 —— 光标闪一下就没了。修法：左键
// mousedown 拦掉默认的焦点挪动（不影响 click 触发切标签，也不影响 HTML5 拖拽）。
describe("B182 标签 mousedown 不能抢编辑器焦点", () => {
  it("左键按下要 preventDefault（否则切完标签光标一闪而过）", () => {
    const { host } = build();
    const tab = host.querySelector(".tab") as HTMLElement;
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    tab.dispatchEvent(ev);
    expect(ev.defaultPrevented, "左键 mousedown 必须拦掉默认焦点挪动").toBe(true);
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
