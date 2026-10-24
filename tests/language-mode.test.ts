// B365：状态栏「文件类型」可手动切换 —— 模型侧的判据。
//
// 口径（用户原话）：默认按文件后缀自动匹配；匹配不到就是纯文本（和原来一样）；
// 手动切过的类型压过自动判定；未命名文件（没有后缀）也能切到 Markdown 等类型，
// 从而拿到语法高亮与预览入口。
//
// 这里只测纯模型（doc-model + 语言注册表），菜单/浮层在 language-picker.test.ts。

import { describe, expect, it } from "vitest";
import { isMdDoc, languageOfDoc, makeDoc } from "../src/doc-model";
import {
  AUTO_LANGUAGE,
  LANGUAGE_LABELS,
  languageChoices,
  languageInfoByLabel,
} from "../src/editor/language";

/** 造一个文档；path 为 null 表示未命名缓冲（名字仍是「未命名」）。 */
function doc(name: string, text = "") {
  return makeDoc(1, text, name, null, "UTF-8", "LF", false);
}

describe("B365 语言模式：自动检测 + 手动覆盖", () => {
  it("自动（override = null）：按后缀判定，未知后缀回退 Plain Text", () => {
    expect(languageOfDoc(doc("a.md")).label).toBe("Markdown");
    expect(languageOfDoc(doc("a.xyz")).label).toBe("Plain Text");
    expect(languageOfDoc(doc("未命名")).label).toBe("Plain Text");
    expect(isMdDoc(doc("a.md"))).toBe(true);
    expect(isMdDoc(doc("a.xyz"))).toBe(false);
    expect(isMdDoc(doc("未命名"))).toBe(false);
  });

  it("手动覆盖压过后缀：未命名文件切成 Markdown ⇒ 有高亮扩展、算 Markdown", () => {
    const d = doc("未命名");
    d.langOverride = "Markdown";
    expect(languageOfDoc(d).label).toBe("Markdown");
    expect(languageOfDoc(d).extension, "Markdown 必须有高亮扩展").not.toBeNull();
    expect(isMdDoc(d), "预览闸必须认手动切出来的 Markdown").toBe(true);
  });

  it("反向：.md 手动切成 Plain Text ⇒ 不再按 Markdown（预览闸关闭）", () => {
    const d = doc("a.md");
    d.langOverride = "Plain Text";
    expect(languageOfDoc(d).label).toBe("Plain Text");
    expect(languageOfDoc(d).extension).toBeNull();
    expect(isMdDoc(d)).toBe(false);
  });

  it("注册表里没有的覆盖值按自动处理（旧会话/改名不会卡死）", () => {
    const d = doc("a.rs");
    d.langOverride = "NoSuchLanguage";
    expect(languageOfDoc(d).label).toBe("Rust");
    expect(isMdDoc(d)).toBe(false);
  });

  it("改回自动（override = null）能恢复后缀判定", () => {
    const d = doc("a.md");
    d.langOverride = "Plain Text";
    expect(isMdDoc(d)).toBe(false);
    d.langOverride = null;
    expect(languageOfDoc(d).label).toBe("Markdown");
    expect(isMdDoc(d)).toBe(true);
  });

  it("菜单清单覆盖注册表：每个标签都能解析回自己，Markdown / Plain Text 在内", () => {
    expect(LANGUAGE_LABELS, "Markdown 必须在清单里").toContain("Markdown");
    expect(LANGUAGE_LABELS, "必须能显式切回纯文本").toContain("Plain Text");
    for (const label of LANGUAGE_LABELS) {
      expect(languageInfoByLabel(label)?.label, `清单里的 ${label} 必须能解析`).toBe(label);
    }
    expect(languageInfoByLabel("NoSuchLanguage")).toBeNull();
    expect(languageInfoByLabel("markdown"), "菜单传的是注册表原名，大小写不做模糊匹配").toBeNull();
  });

  it("浮层清单：自动检测置顶，永远只有一项打勾", () => {
    const auto = languageChoices(null);
    expect(auto[0]).toEqual({
      label: AUTO_LANGUAGE,
      description: "按文件后缀自动识别",
      checked: true,
    });
    expect(auto, "自动检测 + 注册表全量").toHaveLength(1 + LANGUAGE_LABELS.length);
    expect(
      auto.filter((it) => it.checked),
      "自动态只有自动检测打勾",
    ).toHaveLength(1);

    const manual = languageChoices("Markdown");
    expect(manual[0].checked, "手动态自动检测不勾").toBe(false);
    expect(manual.find((it) => it.label === "Markdown")?.checked).toBe(true);
    expect(
      manual.filter((it) => it.checked),
      "手动态只有那一项打勾",
    ).toHaveLength(1);

    const stale = languageChoices("NoSuchLanguage");
    expect(stale[0].checked, "未知覆盖值按自动显示（与 languageOfDoc 回退同口径）").toBe(true);
    expect(stale.filter((it) => it.checked)).toHaveLength(1);
  });
});
