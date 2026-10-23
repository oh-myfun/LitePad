// @vitest-environment jsdom
// B352-9 命令层：两条直达命令在册且不抢键位 · 锁态挡住程序化写的入口 · 菜单那一下点击真的接上线。
//
// 三件事各自要证的东西不同，别混成一层：
// ① 注册表（运行时读 COMMANDS 本身，不是读源码里的字）：两条命令存在且 `keys` 为空 ⇒
//    `keyHint()` 返回空串，菜单与命令面板点得到、设置里可自行绑定（B314 的先例）。
// ② 接线（静态）：`main.ts` 的 switch / `commands.ts` 的回调表 / `menubar.ts` 的菜单项，
//    三段都是「一行代码接错就永远不生效」的地方，而 `runShortcut` 在 main 的启动流里，
//    测试没法把它 import 进来（模块求值就开跑）⇒ 这一段只能静态钉。
// ③ 锁的入口闸（静态 + 顺序）：F5「插入时间/日期」与查找栏替换都是**程序化 `dispatch`**，
//    而锁的 `changeFilter` 只拒「带 `Transaction.userEvent` 的改文本」（那一发本来就不带 ⇒
//    `tests/ir-apply.test.ts` 已证它放行），所以这道闸是承重的，不是重复保险。
//    闸必须排在 `dispatch` **之前** —— 排在后面等于没闸（与 B293 那一族同一个形状）。
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import { COMMANDS, keyHint } from "../src/shell/keymap";
import { createMenuBar, type MenuBarCallbacks } from "../src/shell/menubar";
import { closePopupMenu } from "../src/shell/menu";
import {
  irEditable,
  irStateName,
  toggleIrLockState,
  toggleIrRenderState,
  type IrState,
} from "../src/markdown/ir-state";
import { fnBody, stripLineComments } from "./static";

const main = stripLineComments(readFileSync("src/main.ts", "utf-8"));
const commands = stripLineComments(readFileSync("src/commands.ts", "utf-8"));
const menubar = stripLineComments(readFileSync("src/shell/menubar.ts", "utf-8"));
const findbar = stripLineComments(readFileSync("src/find/findbar.ts", "utf-8"));

const SOURCE_LOCKED: IrState = { liveRender: "off", irLocked: true };
const RENDER_LOCKED: IrState = { liveRender: "ir", irLocked: true };
const RENDER_EDITABLE: IrState = { liveRender: "ir", irLocked: false };
const SOURCE_UNLOCKED: IrState = { liveRender: "off", irLocked: false };

/** 弹层菜单项的 `文字\t快捷键` 表示（无快捷键时只有文字）。 */
function itemTexts(): string[] {
  const menu = document.querySelector(".popup-menu");
  expect(menu, "弹层菜单应已打开").toBeTruthy();
  return [...menu!.querySelectorAll(":scope > button")].map((b) => {
    const kbd = b.querySelector(".menu-kbd");
    const label = b.querySelector(".menu-label")?.textContent ?? "";
    return kbd ? `${label}\t${kbd.textContent}` : label;
  });
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** 打开「查看」菜单。 */
async function openViewMenu(host: HTMLElement): Promise<void> {
  const btn = [...host.querySelectorAll("button.menu-btn")].find((b) =>
    b.textContent?.startsWith("查看"),
  );
  expect(btn, "菜单栏按钮「查看」应存在").toBeTruthy();
  btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flush();
}

async function clickItem(needle: string): Promise<void> {
  for (const menu of document.querySelectorAll(".popup-menu")) {
    const item = [...menu.querySelectorAll(":scope > button")].find((b) =>
      (b.querySelector(".menu-label")?.textContent ?? "").includes(needle),
    );
    if (item) {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
      return;
    }
  }
  throw new Error(`菜单项「${needle}」未找到`);
}

const noop = (): void => {};

/** 「查看」这一段菜单求值要用的回调；其余菜单位在本用例之外，故只给这一段的字段。 */
function viewCb(calls: string[]): MenuBarCallbacks {
  return {
    onToggleView: noop,
    onOutline: noop,
    tocChecked: () => false,
    onExplorer: noop,
    explorerChecked: () => false,
    onFoldAll: noop,
    onUnfoldAll: noop,
    onZoomIn: noop,
    onZoomOut: noop,
    onZoomReset: noop,
    onToggleWrap: noop,
    wrapChecked: () => true,
    onToggleStatusbar: noop,
    statusbarChecked: () => false,
    onIrRender: () => calls.push("irRender"),
    onIrLock: () => calls.push("irLock"),
    // 用真实注册表：这样「不抢键位 ⇒ 菜单右侧不显示快捷键」也是真判据
    keyHint: (id: string) => keyHint(id, {}),
  } as unknown as MenuBarCallbacks;
}

describe("B352-9 注册表：两条直达命令在册且不抢键位", () => {
  it("view.liveRender / view.toggleLock 都存在、归「视图」、默认无键位", () => {
    for (const id of ["view.liveRender", "view.toggleLock"]) {
      const cmd = COMMANDS.find((c) => c.id === id);
      expect(cmd, `${id} 应注册进命令表`).toBeTruthy();
      expect(cmd!.group, `${id} 归视图组（命令面板按组分段）`).toBe("视图");
      expect(cmd!.keys, `${id} 默认不抢键位`).toEqual([]);
      expect(keyHint(id, {}), `${id} 没键位 ⇒ keyHint 给空串，菜单自己会省略`).toBe("");
    }
  });

  it("Ctrl+Shift+E 仍只归资源管理器一条（两条新命令不许抢它）", () => {
    const owners = COMMANDS.filter((c) => c.keys.includes("Ctrl+Shift+E"));
    expect(
      owners.map((c) => c.id),
      "那颗键位只有一个主人",
    ).toEqual(["view.explorer"]);
  });

  it("两条命令的文案在注册表与菜单里是同一份（别长成两套口径）", () => {
    for (const id of ["view.liveRender", "view.toggleLock"]) {
      const label = COMMANDS.find((c) => c.id === id)!.label;
      expect(menubar, `菜单里有「${label}」`).toContain(`"${label}"`);
    }
  });
});

describe("B352-9 接线：命令 → 落地只有那一条路", () => {
  it("main.ts 的两个 case 各走一个出口，且不出现直接写状态", () => {
    expect(main, "键盘/命令面板这条路要有 view.liveRender").toMatch(
      /case\s*"view\.liveRender":[\s\S]{0,120}toggleIrRender\(/,
    );
    expect(main, "键盘/命令面板这条路要有 view.toggleLock").toMatch(
      /case\s*"view\.toggleLock":[\s\S]{0,120}toggleIrLock\(/,
    );
    // 写点唯一：状态的两个字段只能在 markdown.ts 的 applyIrState 里落地
    expect(main, "main.ts 不许直接写 tab.liveRender").not.toMatch(/tab\.liveRender\s*=/);
    expect(main, "main.ts 不许直接写 tab.irLocked").not.toMatch(/tab\.irLocked\s*=/);
  });

  it("commands.ts 的菜单回调表把两项接到真出口（不是空箭头）", () => {
    const render = commands.match(/onIrRender:\s*\([^)]*\)\s*=>\s*([\s\S]{0,120}?),\n/);
    const lock = commands.match(/onIrLock:\s*\([^)]*\)\s*=>\s*([\s\S]{0,120}?),\n/);
    expect(render, "回调表里要有 onIrRender").toBeTruthy();
    expect(lock, "回调表里要有 onIrLock").toBeTruthy();
    expect(render![1], "onIrRender 必须真调到 toggleIrRender").toMatch(/toggleIrRender\(/);
    expect(lock![1], "onIrLock 必须真调到 toggleIrLock").toMatch(/toggleIrLock\(/);
  });

  it("查看菜单挂了两项，且各点各的回调", () => {
    const block = menubar.slice(menubar.indexOf('label: "查看"'), menubar.indexOf('label: "编码"'));
    expect(block, "菜单项要接 onIrRender").toMatch(/onSelect:\s*cb\.onIrRender/);
    expect(block, "菜单项要接 onIrLock").toMatch(/onSelect:\s*cb\.onIrLock/);
    // 右侧的快捷键提示必须取自注册表（B349 那一族：显示与生效键位两处各算各的就会说谎）
    expect(block, '即时渲染那一项的键位提示要取 keyHint("view.liveRender")').toMatch(
      /keyHint\("view\.liveRender"\)/,
    );
    expect(block, '解锁那一项的键位提示要取 keyHint("view.toggleLock")').toMatch(
      /keyHint\("view\.toggleLock"\)/,
    );
  });
});

describe("B352-9 锁态写入口：闸排在派生之前", () => {
  it("F5 的 insertTimeDate 先问锁再派发（changeFilter 拦不住它：那一发不带 userEvent）", () => {
    const body = fnBody(commands, "insertTimeDate");
    const gate = body.indexOf("irEditable(");
    const dispatch = body.indexOf("dispatch(");
    expect(gate, "F5 是 force:true 的程序化写，必须问锁").toBeGreaterThan(-1);
    expect(dispatch, "派发那一发要在").toBeGreaterThan(-1);
    expect(gate, "闸必须排在派发之前（排在后面等于没闸）").toBeLessThan(dispatch);
    expect(body, "拒绝要给状态栏文案，不许静默").toContain("即时渲染已锁定");
  });

  it("查找栏替换/替换全部都在入口问锁，且只问一次（别在遍历里逐实例跳过）", () => {
    for (const name of ["replaceCurrent", "replaceAllInScope"]) {
      const body = fnBody(findbar, name);
      const gate = body.indexOf("irEditable(");
      const dispatch = body.indexOf("dispatch(");
      expect(gate, `${name} 要有锁的闸`).toBeGreaterThan(-1);
      expect(dispatch, `${name} 确实有派发`).toBeGreaterThan(-1);
      expect(gate, `${name} 的闸要排在派发之前`).toBeLessThan(dispatch);
      expect(
        body.split("irEditable(").length - 1,
        `${name} 只问一次锁：同源兄弟格的写必须放行，逐实例问就把那条一起堵死了`,
      ).toBe(1);
    }
    expect(findbar, "拒绝要给查找栏状态文案").toContain("即时渲染已锁定");
  });

  it("irEditable 的定义全仓只有一处，且写入口从叶子模块取（不给 markdown 加反向依赖）", () => {
    expect(
      readFileSync("src/markdown.ts", "utf-8"),
      "markdown.ts 只转出口，不重复定义",
    ).not.toMatch(/function\s+irEditable\(/);
    for (const [file, src] of [
      ["src/commands.ts", commands],
      ["src/find/findbar.ts", findbar],
    ] as const) {
      expect(src, `${file} 要从 markdown/ir-state 取闸`).toMatch(
        /import\s*\{[^}]*irEditable[^}]*\}\s*from\s*"\.\.?\/markdown\/ir-state"/,
      );
    }
  });
});

describe("B352-9 直达命令的状态映射（纯函数）", () => {
  it("view.liveRender 只进/出渲染，锁态一位都不动", () => {
    const r = (s: IrState) => toggleIrRenderState(s, { readonly: false });
    expect(r(SOURCE_LOCKED)).toEqual(RENDER_LOCKED);
    // 上一轮在渲染里解过锁、回源码、再进来：还是可写（「不动锁态」就是这一条）
    expect(r(SOURCE_UNLOCKED)).toEqual(RENDER_EDITABLE);
    expect(r(RENDER_LOCKED)).toEqual(SOURCE_LOCKED);
    expect(r(RENDER_EDITABLE)).toEqual(SOURCE_UNLOCKED);
  });

  it("view.toggleLock 只翻锁；源码态那一下先进渲染、且恒锁着（默认锁着）", () => {
    expect(toggleIrLockState(RENDER_LOCKED, { readonly: false })).toEqual(RENDER_EDITABLE);
    expect(toggleIrLockState(RENDER_EDITABLE, { readonly: false })).toEqual(RENDER_LOCKED);
    // 从源码态进来：irLocked 的残值（上一轮 C→A 留下的 false）不许把用户直接送进可写渲染态
    expect(toggleIrLockState(SOURCE_UNLOCKED, { readonly: false })).toEqual(RENDER_LOCKED);
    expect(toggleIrLockState(SOURCE_LOCKED, { readonly: false })).toEqual(RENDER_LOCKED);
  });

  it("只读文档：两条路都到不了 render-editable（C 对只读文档不可达）", () => {
    for (const cur of [SOURCE_LOCKED, SOURCE_UNLOCKED, RENDER_LOCKED]) {
      const opts = { readonly: true };
      expect(
        irStateName(toggleIrLockState(cur, opts)),
        `只读翻锁 ${JSON.stringify(cur)} 的后继`,
      ).not.toBe("render-editable");
      expect(
        irStateName(toggleIrRenderState(cur, opts)),
        `只读进/出渲染 ${JSON.stringify(cur)} 的后继`,
      ).not.toBe("render-editable");
    }
  });

  it("两条命令的后继都还是那三态之一，且只带这两个字段（不碰文档）", () => {
    const all = [SOURCE_LOCKED, SOURCE_UNLOCKED, RENDER_LOCKED, RENDER_EDITABLE];
    for (const cur of all) {
      for (const next of [
        toggleIrRenderState(cur, { readonly: false }),
        toggleIrLockState(cur, { readonly: false }),
        toggleIrLockState(cur, { readonly: true }),
      ]) {
        expect(Object.keys(next).sort(), "状态对象只有这两个字段").toEqual([
          "irLocked",
          "liveRender",
        ]);
        expect(["source", "render-locked", "render-editable"], "后继仍是三态之一").toContain(
          irStateName(next),
        );
      }
    }
  });

  it("与悬浮键的循环共用同一套取值：B 的后继在两条路上都是 C", () => {
    // 循环（Task 4）与直达（Task 9）作用在同一对字段上，不各存一份 ⇒ 三条边不能互相打架
    expect(toggleIrLockState(RENDER_LOCKED, { readonly: false })).toEqual(RENDER_EDITABLE);
    expect(
      irEditable(toggleIrLockState(RENDER_LOCKED, { readonly: false })),
      "翻锁后确实可写",
    ).toBe(true);
    expect(
      irEditable(toggleIrLockState(RENDER_EDITABLE, { readonly: false })),
      "再翻回来又锁上",
    ).toBe(false);
  });
});

describe("B352-9 菜单那一下点击（登记 ≠ 挂线）", () => {
  afterEach(() => {
    closePopupMenu();
    document.body.textContent = "";
  });

  it("查看菜单里两项都在、都不带快捷键后缀，点下去各走各的回调", async () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    const calls: string[] = [];
    createMenuBar(host, viewCb(calls));
    await openViewMenu(host);

    const texts = itemTexts();
    const render = COMMANDS.find((c) => c.id === "view.liveRender")!.label;
    const lock = COMMANDS.find((c) => c.id === "view.toggleLock")!.label;
    expect(texts, "菜单项不带 \t 后缀（没键位）").toContain(render);
    expect(texts, "菜单项不带 \t 后缀（没键位）").toContain(lock);

    await clickItem(render);
    expect(calls, "点「切换即时渲染」要真的走到 onIrRender 恰好一次").toEqual(["irRender"]);

    closePopupMenu();
    await flush();
    await openViewMenu(host);
    await clickItem(lock);
    expect(calls, "点「解锁 / 上锁」走的是 onIrLock，不是把两项接成同一个回调").toEqual([
      "irRender",
      "irLock",
    ]);
  });
});
