// @vitest-environment jsdom
// B24：外部文件拖入增强；B70 B 档改了「弹不弹菜单」的判据。
//  1) **落点是 Markdown 文档**且只拖了一个文件时弹菜单（打开文档 / 插入文件路径），
//     其余直接打开 —— 判据是「落到哪儿」不是「拖进来的是什么」（见 needsChoice 注释）；
//  2) 菜单两项分别驱动 onOpen / onInsert，点击后菜单关闭；
//  3) showPopupMenu 支持无锚点、按坐标弹出（拖放落点没有现成元素）。
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { needsChoice, showFileDropChoice } from "../src/shell/filedrop";

beforeAll(() => {
  if (!document.body) document.body = document.createElement("body");
  document.body.innerHTML = "";
});

describe("拖放选择菜单的判据：看落点，不看拖进来的是什么", () => {
  it("单个文件落到 Markdown 面板才问", () => {
    expect(needsChoice(["C:/docs/note.md"], true)).toBe(true);
    // 拖进来的不是 md 也要问：落点是 .md 时「插入文件路径」才有意义（图片、附件同理）
    expect(needsChoice(["C:/pics/a.png"], true), "落点是 md 就该问").toBe(true);
    expect(needsChoice(["C:/data/x.csv"], true)).toBe(true);
    // 反过来说：拖进来的是 md 而落点不是 md 文档时，用户要的是**打开**它，不该拦下来问
    expect(needsChoice(["a.md"], false), "落点不是 md 就不问").toBe(false);
    expect(needsChoice(["a.png"], false)).toBe(false);
    // 多文件不弹（菜单只处理一个文件）
    expect(needsChoice(["a.md", "b.md"], true), "多文件不弹菜单").toBe(false);
    expect(needsChoice([], true)).toBe(false);
  });
});

describe("落点选择菜单（打开文档 / 插入文件路径）", () => {
  it("渲染两个选项并分别触发回调，选择后菜单关闭", () => {
    let opened = 0;
    let inserted = 0;
    showFileDropChoice(
      "note.md",
      { x: 120, y: 80 },
      {
        onOpen: () => opened++,
        onInsert: () => inserted++,
      },
    );

    const menu = document.querySelector(".popup-menu");
    expect(menu, "应弹出菜单").toBeTruthy();
    const btns = Array.from(menu!.querySelectorAll("button"));
    expect(btns.length, "应有两项").toBe(2);
    expect(btns[0].textContent).toContain("打开");
    expect(btns[0].textContent).toContain("note.md");
    expect(btns[1].textContent).toContain("插入文件路径");

    btns[1].click();
    expect(inserted, "应触发插入路径回调").toBe(1);
    expect(opened, "不应触发打开回调").toBe(0);
    expect(document.querySelector(".popup-menu"), "选择后菜单应关闭").toBeNull();

    // 再验证「打开文档」分支
    showFileDropChoice(
      "note.md",
      { x: 120, y: 80 },
      {
        onOpen: () => opened++,
        onInsert: () => inserted++,
      },
    );
    (document.querySelector(".popup-menu button") as HTMLButtonElement).click();
    expect(opened, "应触发打开回调").toBe(1);
  });

  it("按坐标弹出（无锚点）时菜单仍挂到 body 且可重复打开", () => {
    showFileDropChoice("a.md", { x: 50, y: 60 }, { onOpen: () => {}, onInsert: () => {} });
    expect(document.querySelector(".popup-menu")).toBeTruthy();
    showFileDropChoice("b.md", { x: 70, y: 90 }, { onOpen: () => {}, onInsert: () => {} });
    const menus = document.querySelectorAll(".popup-menu");
    expect(menus.length, "重复弹出应先关旧菜单，只保留一个").toBe(1);
    expect(menus[0].textContent).toContain("b.md");
  });
});

describe("B24 接线（静态断言）", () => {
  const main = readFileSync("src/main.ts", "utf-8");

  it("悬停高亮落点、离开清除、落地按面板+分区打开", () => {
    expect(main, "enter/over 必须高亮落点预览").toMatch(
      /p\.type === "enter" \|\| p\.type === "over"[\s\S]{0,200}showFileDropPreview\(/,
    );
    expect(main, "leave 必须清除落点预览").toMatch(
      /p\.type === "leave"[\s\S]{0,160}clearAllDropPreviews\(\)/,
    );
    expect(main, "落地必须按面板+分区打开（边缘分屏走 splitPanelWithTab）").toMatch(
      /splitPanelWithTab\(target\.panelId, dir, tabId, newFirst, false\)/,
    );
    expect(main, "doOpen 必须支持指定落点面板").toContain(
      "async function doOpen(\n  presetPath?: string,\n  encoding?: string,\n  targetPanelId?: number,\n)",
    );
  });

  it("落到 Markdown 面板才弹选择菜单；「插入文件路径」写入活动编辑器", () => {
    // B70 B 档：判据从「拖进来的是 .md」改成「落点面板的活动文档是 .md」。
    // 写成只传 paths 是旧语义 —— 会把「拖 .md 到 .txt 上」也拦下来问一句。
    expect(main, "必须把落点面板的 md 判据传进去").toMatch(
      /needsChoice\(p\.paths, target !== null && panelDocIsMarkdown\(target\.panelId\)\)[\s\S]{0,200}showFileDropChoice\(/,
    );
    expect(main, "判据来自面板的活动文档").toMatch(
      /function panelDocIsMarkdown\(panelId: number\)[\s\S]{0,260}isMdTab\(t\)/,
    );
    expect(main, "「插入文件路径」必须插入活动编辑器光标处").toContain(
      "function insertDroppedPath(path: string)",
    );
    // 原生拖放期间系统捕获鼠标，选择菜单只能在 drop 后弹——防止改回悬停时机
    expect(main, "选择菜单不得在悬停期间弹出（那时无法点击）").not.toMatch(
      /p\.type === "over"[\s\S]{0,200}showFileDropChoice\(/,
    );
  });
});
