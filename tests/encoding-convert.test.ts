// @vitest-environment jsdom
// 编码完善与转换（B215 / B374 / B378）：
// 1) 运行时：菜单栏「编码」一栏承载三组条目（解读编码 / 转换为 / BOM），
//    都从 main 传进来的同一份模型渲染；行尾自 B374 起**不在编码菜单里**，
//    B378 起状态栏那颗行尾键只留一层：CRLF / LF / CR，选中即切换、保存时写盘
//    （原先末条「转换行尾符」会再弹一份同样的列表，用户报「重复嵌套」）。
// 2) 静态：编码 / BOM 的转换出口只有一个 `convertDoc`，它**先改 doc.encoding
//    再走保存**（顺序反了就等于绕过不可逆保护）；状态栏那颗编码键只铺后端
//    `common` 标注的常用几条（B219），也不再有「四项硬编码兜底」这种跟后端对不上的清单。
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fnBody, ruleBlock, topLevelFnBody } from "./static";
import { createMenuBar, type EncodingMenuModel, type MenuBarCallbacks } from "../src/shell/menubar";
import { closePopupMenu } from "../src/shell/menu";

afterEach(() => {
  closePopupMenu();
});

const main = readFileSync("src/main.ts", "utf-8") + "\n" + readFileSync("src/prefs.ts", "utf-8");
const encoding = readFileSync("src/encoding.ts", "utf-8");
const menubar = readFileSync("src/shell/menubar.ts", "utf-8");
const codec = readFileSync("src-tauri/src/core/codec.rs", "utf-8");

/** 取模型里某一组的项数（判据按组取，避免被「第几项」这种位移骗过去）。 */
function group(model: EncodingMenuModel, key: keyof EncodingMenuModel): string[] {
  return model[key].map((i) => i.label ?? "");
}

function modelOf(pick: (m: EncodingMenuModel) => EncodingMenuModel): EncodingMenuModel {
  const full: EncodingMenuModel = {
    encodedIn: [
      { label: "UTF-8", onSelect: () => {} },
      { label: "UTF-8 with BOM", onSelect: () => {} },
      { label: "ISO-2022-JP", onSelect: () => {} },
    ],
    convertTo: [{ label: "Shift-JIS", onSelect: () => {} }],
    bom: [
      { label: "添加 BOM", disabled: true, onSelect: () => {} },
      { label: "移除 BOM", disabled: true, onSelect: () => {} },
    ],
  };
  return pick(full);
}

function callbackWith(model: EncodingMenuModel): MenuBarCallbacks {
  const host = document.createElement("div");
  host.id = "menu-bar";
  document.body.appendChild(host);
  // 只填本次用得上的字段，其余留空（回调是必填的，所以补 no-op）
  const cb = {
    encodingMenu: () => model,
    encodingOptions: () => [],
    eolOptions: () => [],
    exportable: () => false,
    tocChecked: () => false,
    wrapChecked: () => false,
    statusbarChecked: () => false,
    keyHint: () => "",
  } as unknown as MenuBarCallbacks;
  createMenuBar(host, cb);
  return cb;
}

/** 点开某一栏（按钮文本是「标签(字母)」，按前缀匹配）。 */
async function openMenu(label: string): Promise<void> {
  const btn = [...document.querySelectorAll("button.menu-btn")].find((b) =>
    b.textContent?.startsWith(label),
  );
  expect(btn, `菜单栏按钮「${label}」应存在`).toBeTruthy();
  btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
}

/** 点开某个带子菜单的项，返回新展开的那一层。（锚点是**第一层**，不是上一次展开的） */
async function openSubmenu(itemLabel: string): Promise<Element> {
  const scope = document.querySelector(".popup-menu")!;
  const target = [...scope.querySelectorAll(":scope > button")].find(
    (b) => (b.querySelector(".menu-label")?.textContent ?? "") === itemLabel,
  );
  expect(target, `菜单项「${itemLabel}」应存在`).toBeTruthy();
  target!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  return [...document.querySelectorAll(".popup-menu")].at(-1)!;
}

function labelsOf(menu: Element): string[] {
  return [...menu.querySelectorAll(":scope > button")].map(
    (b) => b.querySelector(".menu-label")?.textContent ?? "",
  );
}

describe("B215：编码清单 + 转换（编码 / BOM / 行尾）", () => {
  it("菜单栏顶上多出「编码」一栏，位置在「查看」与「帮助」之间", () => {
    // 判据按出现次序取，不看「有没有这个词」—— 免得有人换个顺序加进去照样绿
    const order = [...menubar.matchAll(/^\s{4}label: "(.+?)",$/gm)].map((m) => m[1]);
    const atView = order.indexOf("查看");
    const atHelp = order.indexOf("帮助");
    expect(order[atView + 1], "「编码」应紧跟在「查看」后面").toBe("编码");
    expect(order[atHelp], "「帮助」应在「编码」之后").toBe("帮助");
  });

  it("五个助记字母互不重复（撞了就是按哪个都能开菜单）", () => {
    const head = menubar.indexOf("const MENU_KEYS = [");
    const keys = menubar.slice(head);
    const payload = keys.slice(keys.indexOf("[") + 1, keys.indexOf("]"));
    const letters = payload.split(",").map((s) => s.trim().replaceAll('"', ""));
    expect(letters).toContain("F");
    expect(letters).toContain("V");
    expect(letters).toContain("C");
    expect(new Set(letters).size, "助记符重复").toBe(letters.length);
    expect(letters.length, "助记符数量应与菜单栏数一致").toBe(5);
  });

  it("编码菜单渲染出三组：解读编码 / 转换为 / BOM（B374 起行尾不在这里）", async () => {
    callbackWith(modelOf((m) => m));
    await openMenu("编码");
    expect(labelsOf([...document.querySelectorAll(".popup-menu")].at(-1)!)).toEqual([
      "解读编码",
      "转换为",
      "添加 BOM",
      "移除 BOM",
    ]);
    // 反向闸：行尾入口不许再出现在编码菜单里（B374 用户点名）
    expect(labelsOf([...document.querySelectorAll(".popup-menu")].at(-1)!)).not.toContain(
      "转换行尾符",
    );
  });

  it("三组内容都从传入的模型来（改模型就改菜单，不存在第二份手抄列表）", async () => {
    callbackWith(modelOf((m) => m));
    await openMenu("编码");
    expect(labelsOf(await openSubmenu("解读编码"))).toEqual([
      "UTF-8",
      "UTF-8 with BOM",
      "ISO-2022-JP",
    ]);
    expect(labelsOf(await openSubmenu("转换为"))).toEqual(["Shift-JIS"]);
  });

  it("编码清单由「转换」那一组承载，条目数不写死", () => {
    const model = modelOf((m) => m);
    // 判据看的是**来源**：两组都从 encodingOptions 的下发结果里 map 出来
    const body = fnBody(main, "encodingMenuModel");
    expect(body).toContain("encodingOptions.map");
    // 行尾不在这份模型里（B374）：出现 eolOptions 就是把两个概念又搅在一起了
    expect(body).not.toContain("eolOptions");
    expect(group(model, "convertTo").length, "转换组条目数应与下发清单一致").toBe(1);
  });

  it("转换只有一个出口 convertDoc（编码 / BOM）；行尾不再立即写盘", () => {
    const body = fnBody(main, "encodingMenuModel");
    // BOM 两项写成 convertDoc({ encoding: … })
    expect(body).toContain("convertDoc({ encoding:");
    // B378：行尾浮层只切换 `doc.eol`（保存时写盘），不许再叫转换出口
    const eol = fnBody(main, "showEolPicker");
    expect(eol, "行尾浮层不再走立即转换").not.toContain("convertDoc");
    expect(eol, "行尾浮层不得再出现第二层入口").not.toContain('showEolPicker("');
    expect(main).toContain("async function convertDoc(");
    // 不许再冒出第二套转换函数（两套 = 写盘保护抄两遍，必有一遍漏）
    expect(main).not.toContain("function convertEncoding(");
    expect(main).not.toContain("function convertEol(");
  });

  it("convertDoc 先写 doc.encoding 再走保存（顺序反了就绕过不可逆保护）", () => {
    const body = fnBody(main, "convertDoc");
    const atAssign = body.indexOf("doc.encoding = enc");
    const atSave = body.indexOf("saveDocCore");
    expect(atAssign, "应先赋目标编码").toBeGreaterThan(-1);
    expect(atSave, "再走保存").toBeGreaterThan(-1);
    expect(atAssign).toBeLessThan(atSave);
  });

  it("脏判据拿当前正文：传 null 会恒判脏，干净文档也弹「有未保存的修改」", () => {
    const body = fnBody(main, "convertDoc");
    expect(body).toContain("isDirtyVsBaseline(doc, freshTextOfDoc(doc))");
    expect(body).not.toContain("isDirtyVsBaseline(doc, null)");
  });

  it("保存被拒时把编码字段退回（否则状态栏会对不上磁盘）", () => {
    const body = fnBody(main, "convertDoc");
    const atRollback = body.indexOf("doc.encoding = prevEnc");
    const atSave = body.indexOf("saveDocCore");
    expect(atRollback).toBeGreaterThan(atSave);
    expect(body).toContain("const prevEnc = doc.encoding");
  });

  it("BOM 只认 UTF-8 两档：UTF-16 的带/不带 BOM 是独立条目，不走这项", () => {
    const body = topLevelFnBody(encoding, "bomTarget");
    expect(body).toContain("ENC_UTF8_BOM");
    expect(body).toContain("return null");
    // 反例：不要把 UTF-16LE without BOM 也算成「可去 BOM」
    expect(body).not.toContain("UTF-16LE without BOM");
  });

  it("状态栏那颗键的清单只从启动时预取的那份取数（点开不再走 IPC）", () => {
    const body = fnBody(main, "showEncodingPicker");
    // BOM 两项仍与主菜单同取一份模型
    expect(body).toContain("encodingMenuModel()");
    // 旧的「点开才 await listEncodings() + 四项兜底」实现应已删除：
    // 那是**启动时就取好**的一份清单，点开菜单再取一次只会多一次 IPC 往返。
    expect(body).not.toContain("listEncodings");
    expect(body).not.toContain("GB18030");
    // 反向判据：常用集必须是从那份清单里**过滤**出来的，不是临时又取一份
    expect(body, "常用集只能从预取清单过滤").toContain("encodingOptions");
  });

  it("旧的四项硬编码兜底清单从 main 里抹掉了（跟后端全量对不上就是坑）", () => {
    // 这行字面量是旧 showEncodingMenu 的 catch 兜底，留着就会在 IPC 一挂时
    // 悄悄把菜单缩回四条 —— 而那时用户看得见的是「编码变少了」，不会有任何报错。
    const stale = '["UTF-8", "UTF-8 with BOM", "UTF-16LE", "GB18030"]';
    expect(main, "旧兜底清单应删除").not.toContain(stale);
  });

  it("B366/B374/B378：编码 / 行尾都走居顶快速选择；行尾只有一层切换", () => {
    for (const fn of ["showEncodingPicker", "showEolPicker"]) {
      const body = fnBody(main, fn);
      expect(body, `${fn} 必须用公共 QuickPick`).toContain("showQuickPick(");
      expect(body, `${fn} 不许退回 showPopupMenu`).not.toContain("showPopupMenu");
      expect(body, `${fn} 要支持再点一下收起`).toContain("quickPickIsOpen()");
    }
    const enc = fnBody(main, "showEncodingPicker");
    expect(enc, "锚点 = 状态栏编码键").toContain("anchor: sbEncoding");
    expect(enc, "BOM 两项的禁用态来自同一份菜单模型").toContain("model.bom");
    // B374：编码浮层只谈编码，行尾不许再挂在这里
    expect(enc, "编码浮层里不许出现行尾入口").not.toContain("showEolPicker");
    expect(enc, "编码浮层里不许出现行尾文案").not.toContain("转换行尾符");

    const eol = fnBody(main, "showEolPicker");
    expect(eol, "行尾候选用启动时预取的清单（点开不再走 IPC）").toContain("eolOptions");
    expect(eol).not.toContain("listEols");
    expect(eol, "行尾列表按当前值打勾").toContain("checked: value === doc.eol");
    // B378（用户报「行尾切换里又套一层行尾切换」）：末条入口与 convert 模式都删掉
    expect(eol, "不许再出现「转换行尾符」末条").not.toContain("转换行尾符");
    expect(eol, "不再有第二层 convert 模式").not.toContain("EolPickerMode");
    expect(eol, "不再往列表里塞分隔线 + 末条").not.toContain("separator: true");
    expect(eol, "onSelect 直接落 doc.eol").toContain("doc.eol = value");
    // 点当前那一项不该把干净文档标脏
    expect(eol, "同值不动作").toContain("value === doc.eol");
    // main 的接线必须换到新入口
    expect(main).toContain(
      'sbEncoding.addEventListener("click", () => void showEncodingPicker());',
    );
    expect(main).toContain('sbEol.addEventListener("click", () => showEolPicker());');
  });

  it("状态栏那颗编码键限宽且能收缩（全量编码里最长的一条有二十个字符）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const block = ruleBlock(css, "#sb-encoding");
    expect(block, "必须有 #sb-encoding 的限宽规则").toContain("max-width");
    // B209：flex 子项 min-width 的初始值是 auto，只写 max-width 会被内容顶开
    expect(block, "不写 min-width: 0 就压不住").toContain("min-width: 0");
    // 截断后必须看得出来是截断了，否则用户以为编码就叫 UTF-16BE wit…
    expect(block).toContain("ellipsis");
  });

  it("B218：编码 / 转换两路都收成两级（首组内联，其余语言组走子菜单）", () => {
    const body = fnBody(main, "encodingMenuModel");
    // 解读编码与转换为 两路都要走同一个收口出口，别各写一遍（两遍就必差一处）
    expect(body.split("withLanguageGroups").length - 1).toBe(2);
    expect(body).toContain("const groups = encodingOptions.map");

    const helper = topLevelFnBody(encoding, "withLanguageGroups");
    expect(helper, "换组处要插一条分隔线").toContain("separator: true");
    expect(helper, "之后的每一组要收成子菜单入口").toContain("submenu:");
    // 第一组必须内联平铺：收口时 out 还是空的就说明它是第一组（那条路只铺不收）
    expect(helper, "第一组要内联，别也收成子菜单").toContain("out.length > 0");
    // 判据按 group 逐条对齐取，不许「数到第几项就当第几组」那样糊过去
    expect(helper).toContain("groups[i]");
    // 反例：分组只能来自后端下发，前端再抄一张「编码 → 语言」对照表就必漂
    expect(main, "不许在前端另抄一份编码→语言对照表").not.toMatch(/GB2312\s*[:=]/);
  });

  it("B218：菜单条目不许重复 —— 同一个编码显示两遍就是重复选项", () => {
    // 上一次「解码 / 转换菜单出现重复选项」是 all() 开头残留四条旧头、和下面的
    // Unicode 组重了一遍。⚠️ 分组连续性两条断言都抓不住：重复项**同组且相邻**，
    // 「每组连续」「正好 9 组」全绿，用户看到的却是两条一模一样的、各挂一个对勾。
    expect(codec, "Rust 侧必须有 label 唯一性硬断言").toContain(
      "fn menu_entries_have_no_duplicate_labels",
    );
    // 前端这一侧：两路条目都只从后端清单映射出来，不许第二处拼装把条目再凑一遍
    const body = fnBody(main, "encodingMenuModel");
    expect(body, "条目只能从后端清单映射").toContain("encodingOptions.map");
  });

  it("B219：状态栏那颗键只铺常用几条（常用集来自后端 common，不许手抄白名单）", () => {
    const body = fnBody(main, "showEncodingPicker");
    // 反例一：别把编码那一组原样摊平 —— 全量 40 条平铺就是用户说的「显示完整列表」。
    //    ⚠️ 这条要排在正向判据前面：反例先红才能证明它咬得住，否则退化时被正向
    //       断言抢先报错，这条闸等于没验过。
    expect(body, "不许把全量编码组摊平在顶层").not.toContain("...model.encodedIn");
    // 正向：过滤出来的常用集要真的铺在顶层
    expect(body, "常用集要铺在顶层").toContain("...common,");
    // 收窄的判据只能挂在后端下发的 common 字段上，不能前端另挑一批标签。
    // ⚠️ 判据要取**整条完整表达式**：只写 `it.common` 的话退化成 `!it.common`
    //    照样命中子串（假绿），而那会把常用集整个翻成「非常用」。
    expect(body, "常用集要按后端下发的 common 字段过滤").toContain(".filter((it) => it.common)");
    // 反例二：别在前端抄一份「常用编码」标签表 —— 又一张表，迟早差一条
    expect(body, "不许手抄常用编码清单").not.toMatch(/"UTF-8 with BOM"/);
    expect(body, "不许手抄常用编码清单").not.toMatch(/GB18030/);
    // 主菜单那条全量两级不受影响：仍从全量清单收成子菜单，不许跟着收窄
    const model = fnBody(main, "encodingMenuModel");
    expect(model, "主菜单仍要全量走两级").toContain("withLanguageGroups");
    expect(model, "收口出口拿的是全量清单").toContain("encodingOptions.map");
    expect(model, "主菜单不许跟着收窄成常用集").not.toContain("it.common");
  });

  it("B219：常用集是后端口径 —— Rust 侧锁住条数，且必须是全量的真子集", () => {
    // 常用集的值由后端 is_common 一处说了算，前端只过滤；这里盯住后端别乱涨
    expect(codec, "Rust 侧要有常用集断言").toContain(
      "fn common_encodings_are_a_subset_of_the_menu",
    );
    // api 契约上也要有这个字段，否则前端读 it.common 是读了个不存在的东西
    const api = readFileSync("src/ipc/api.ts", "utf-8");
    const block = topLevelFnBody(api, "listEncodings");
    expect(block, "list_encodings 的下发类型要带 common").toContain("invoke<EncodingItem[]>");
    expect(api, "EncodingItem 上要有 common 字段").toMatch(
      /interface EncodingItem \{[\s\S]{0,200}?common: boolean;/,
    );
  });

  it("B218：中文字符集包含 GB2312 等 Windows 常用字符集", () => {
    // label 与它背后那张 encoding_rs 表要成对盯住：只盯 label，把映射落到别的常量上照样绿
    const pairs: [string, string][] = [
      ['Encoding::Gb2312 => "GB2312"', "Encoding::Gb2312 => encoding_rs::GB18030"],
      ['Encoding::Gbk => "GBK"', "Encoding::Gbk => encoding_rs::GBK"],
      [
        'Encoding::Big5Hkscs => "Big5-HKSCS"',
        "Encoding::Big5 | Encoding::Big5Hkscs => encoding_rs::BIG5",
      ],
    ];
    for (const [label, table] of pairs) {
      expect(codec, `菜单条目${label}`).toContain(label);
      expect(codec, `落点${table}`).toContain(table);
    }
    // 中文那几条的组名要认得出（菜单上那条中文子菜单入口就取这个值）
    expect(codec).toContain('=> "中文（简体 / 繁体）"');
    // 老别名收口：cp936 / cp950 / chinese 这些系统 API 给出的名字照样落得下
    for (const alias of ['"gb2312"', '"cp936"', '"cp950"', '"chinese"']) {
      expect(codec, `别名 ${alias} 应从 from_label 收进来`).toContain(alias);
    }
  });

  it("Rust 侧 ISO-2022-JP 从 label 到 encoding_rs 常量一路打通", () => {
    expect(codec).toContain('Encoding::Iso2022Jp => "ISO-2022-JP"');
    expect(codec).toContain("Encoding::Iso2022Jp => encoding_rs::ISO_2022_JP");
    // 同一条链上别漏掉 EUC-JP（易被顺手写成 EUC_KR 那一路）
    expect(codec).toContain('Encoding::EucJp => "EUC-JP"');
    expect(codec).toContain("Encoding::EucJp => encoding_rs::EUC_JP");
  });
});
