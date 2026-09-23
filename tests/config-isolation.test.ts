// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SESSION_RS = "src-tauri/src/session/mod.rs";
const BACKUP_RS = "src-tauri/src/backup/mod.rs";
const SHOT_PY = "scripts/capture-screenshots.py";

/** 取 Rust 函数体：从 `fn <name>(` 起到下一个顶层 `}`。 */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`fn ${name}(`);
  if (start < 0) return "";
  const end = src.indexOf("\n}", start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

/**
 * 判据：配置路径必须**派生自** `config_dir()`，而不是自己再读一次 APPDATA。
 *
 * 「漏一个」是这里唯一真实的风险：三个落点里只要有一个还直连 `%APPDATA%`，
 * 「截图不碰用户目录」就只做了一半（热退出副本照样写回用户目录）。
 */
function derivesFromConfigDir(body: string): boolean {
  return /config_dir\(\)/.test(body) && !/var_os\(\s*"APPDATA"\s*\)/.test(body);
}

describe("配置目录隔离（截图不碰用户目录）", () => {
  it("B100 三个配置落点都必须派生自 config_dir()", () => {
    const session = readFileSync(SESSION_RS, "utf-8");
    const backup = readFileSync(BACKUP_RS, "utf-8");
    for (const [name, src] of [
      ["settings_path", session],
      ["session_path", session],
      ["backup_root", backup],
    ] as const) {
      const body = fnBody(src, name);
      expect(body, `取不到 ${name} 的函数体`).not.toBe("");
      expect(derivesFromConfigDir(body), `${name} 必须走 config_dir()，不得自己再读 APPDATA`).toBe(
        true,
      );
    }
  });

  it("B100 判据必须抓得住「自己读 APPDATA」的退化写法（否则上一条是恒真）", () => {
    const good =
      'pub fn settings_path() -> Option<PathBuf> {\n  config_dir().map(|d| d.join("s.json"))\n}';
    const bad =
      'pub fn settings_path() -> Option<PathBuf> {\n  std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("LitePad"))\n}';
    const worse = 'pub fn settings_path() -> Option<PathBuf> {\n  Some(PathBuf::from("C:/x"))\n}';
    expect(derivesFromConfigDir(good)).toBe(true);
    expect(derivesFromConfigDir(bad), "直连 APPDATA 必须被判为不合格").toBe(false);
    expect(derivesFromConfigDir(worse), "完全绕过 config_dir 必须被判为不合格").toBe(false);
  });

  it("B100 config_dir 必须支持 LITEPAD_CONFIG_DIR 覆盖，且空串不算覆盖", () => {
    const src = readFileSync(SESSION_RS, "utf-8");
    expect(src, "必须读 LITEPAD_CONFIG_DIR").toContain('var_os("LITEPAD_CONFIG_DIR")');
    // 空串被当成「指向当前目录」会写得到处都是，所以要有 is_empty 兜底
    expect(src, "空串覆盖必须有兜底").toMatch(/Some\(dir\)\s+if\s+!dir\.is_empty\(\)/);
  });

  it("B100 截图脚本必须把配置目录隔离到项目内 .tmp/shot/config", () => {
    const py = readFileSync(SHOT_PY, "utf-8");
    expect(py, "必须设 LITEPAD_CONFIG_DIR（子进程继承）").toContain(
      'os.environ["LITEPAD_CONFIG_DIR"] = CFG_DIR',
    );
    expect(py, "CFG_DIR 必须落在项目内 .tmp 下").toMatch(
      /CFG_DIR\s*=\s*os\.path\.join\(SHOT_DIR,\s*"config"\)/,
    );
    expect(py, "SHOT_DIR 必须落在项目内 .tmp 下").toMatch(
      /SHOT_DIR\s*=\s*os\.path\.join\(ROOT,\s*"\.tmp",\s*"shot"\)/,
    );
    // 真实配置只允许**读**（当底稿），不允许写
    expect(py, "不得再备份/还原真实配置").not.toContain("def backup_config");
    expect(py, "不得再备份/还原真实配置").not.toContain("def restore_config");
  });

  it("B100 WebView2 用户数据只在「首轮失败」时才移开，不再每轮清", () => {
    const py = readFileSync(SHOT_PY, "utf-8");
    // ⚠️ 从**定义之后**开始找：否则第一次命中的是 `def clear_webview_profile():` 本身
    //    （def 行也含 `clear_webview_profile()`），位置在 capture_recipe 之前 → 假红。
    const defAt = py.indexOf("def clear_webview_profile");
    expect(defAt, "应有 clear_webview_profile 定义").toBeGreaterThan(0);
    // ⚠️ 只能匹配「独立一行的真调用」：docstring 里也提到 `clear_webview_profile()`，
    //    单纯 indexOf 会先命中那段说明文字（位置在 shoot 之前）→ 假红。
    const m = /\n\s+clear_webview_profile\(\)\s*\n/.exec(py.slice(defAt));
    const call = m ? defAt + m.index : -1;
    expect(call, "应保留按需移开的调用").toBeGreaterThan(0);
    // 首轮 shoot 之前不得无条件清：调用点必须落在 capture_recipe 的重试分支里
    const recipe = py.indexOf("def capture_recipe");
    const shoot = py.indexOf("def shoot");
    expect(recipe, "应有 capture_recipe（重试包装）").toBeGreaterThan(0);
    expect(shoot).toBeGreaterThan(0);
    expect(call, "移开必须发生在 capture_recipe 之内").toBeGreaterThan(recipe);
    expect(py.slice(recipe, call), "移开前必须先试过一次 shoot").toContain("shoot(");
    // 且必须是「只调一次」：出现两次就说明又变回无条件清了
    // ⚠️ 偏移量要用**整段匹配**的长度：`m.index` 指向前导换行，只 +1 会重新命中同一处。
    const second = py.indexOf("clear_webview_profile()", call + m[0].length);
    expect(second, "按需移开只能有一处调用").toBe(-1);
  });
});
