# ADR 0098：打包「退出码 0」不等于产物可用 —— 空壳 `dist` 与 dev 模式中间产物

- **状态**：Accepted（09-23 实测）
- **域**：构建 / 交付
- **来源**：用户报「打开应用显示：127.0.0.1 拒绝连接」
- **关联**：`scripts/build-all.sh`、`tests/static.ts`、守卫 B98（`tests/menubar.test.ts` 正向 +
  `tests/reverse-verify.test.ts` 退化对照）；与 0085 同族（vite 挂死会留下空壳 `dist`）、
  与 0082 / 0083 同族（**静默失效 / 假成功**）

## 背景（Context）

用户拿到我给的 exe，打开显示 **「127.0.0.1 拒绝连接」**。回头看，底下压着三层问题，
每一层单独看都是「命令成功、日志正常」：

1. 交付的 exe 来自 `scripts/build-all.sh` 的**第 3 步** `cargo build --release`；
2. 磁盘上的 `dist/` 是**空壳**：只剩 `index.html`（8KB），`assets/` 下 434 个文件全丢；
3. 在那之前，我一直在给 MSVC 链接失败找「工具链没装对」的原因，其实是我自己
   往环境里塞了 `LIB` / `INCLUDE` / `TMP`。

## 根因（Root Cause）

### 一、`cargo build --release` 的 exe 是 dev 模式（会去连 `devUrl`）

`tauri-2.11.5/build.rs`：

```rust
let custom_protocol = has_feature("custom-protocol");
let dev = !custom_protocol;
alias("dev", dev);
println!("cargo:dev={dev}");
```

`custom-protocol` **只由 `tauri build` 注入**（CLI 自己加 feature，项目 `Cargo.toml`
里没有 `[features]` 段也照样生效）。所以 `cargo build --release` 出来的
`src-tauri/target/release/litepad.exe` 是 `dev = true`，窗口去加载 `build.devUrl`
（`http://127.0.0.1:1420`）—— 没有 dev server 监听，就是那句「拒绝连接」。

**判据**：`src-tauri/target/release/build/tauri-*/output` 里的 `cargo:dev=false`
才是生产产物；`true` 的那个目录对应 dev 构建。两者会在 `target/` 里**并存**，
所以不能只看「有没有这个文件」，要看**构建时间/特征**对得上哪一次构建。

### 二、空壳 `dist` 会被**无声**打进包里

`vite` 的 `build` 先 `emptyOutDir` 再写文件。**挂在写盘阶段被 kill / Ctrl-C**
（0085 的间歇性挂死）之后，`dist/` 就停在「`index.html` 已写、`assets/` 还没写」的中间态。

此时 `tauri build` 一路成功：`Finished release profile`、`Running makensis`、
`Finished 1 bundle`，**退出码 0**。但嵌入的前端是空的：

| | 正常 | 空壳 dist |
|---|---|---|
| `litepad.exe` | 8,121,856 B | 3,764,224 B |
| `LitePad_0.11.0_x64-setup.exe` | 5,744,765 B | 1,375,709 B |

打开就是一片空白 —— 从退出码和日志上完全看不出来。

### 三、MSVC 链接失败是「自己配坏了环境」

默认环境下（**不设** `LIB` / `INCLUDE` / `TMP`、**不**跑 vcvars）：

- `cargo build --release` → **1m29s 成功**
- `tauri build --config '{"build":{"beforeBuildCommand":""}}'` → **1m56s 成功**

前几轮的 `LNK1181 无法打开输入文件"kernel32.lib"` / `LNK1104 无法打开
C:\WINDOWS\lnk{…}.tmp` 全是自伤：MSYS 会改写 `LIB` 里的 `;` 分隔路径、把 `TMP`
转成 POSIX 形态，`link.exe` 于是既找不到库、也写不了临时文件。
rustc 对 msvc target **自带 SDK/VC 探测**（会把 `/LIBPATH:` 直接挂在 link 命令行上），
根本不需要外部 `LIB`。

## 决策（Decision）

1. **交付物只有一个**：`tauri build` 覆盖写的 `src-tauri/target/release/litepad.exe`
   与 `bundle/nsis/*.exe`。第 3 步（`cargo build --release`）的产物只是编译校验，
   **不得拿给用户、不得拿去截图**。已在 `build-all.sh` 第 3 步标题与注释里写明。
2. **打包前点数 `dist/assets`**，不足 10 个文件直接 `exit 1`，不许带着空壳往下打。
3. **不要给 MSVC 手工塞 `LIB` / `INCLUDE` / `TMP`**，也不要走 vcvars / `cmd` / PowerShell
   包装再调 `tauri build`；直接
   `node node_modules/@tauri-apps/cli/tauri.js build --config '{"build":{"beforeBuildCommand":""}}'`。
4. 沙箱里**拍不到界面**不等于 exe 是坏的（见下）；判断「产物是否可用」要靠
   **产物层面的硬证据**（导入表 / 嵌入资源 / 体积 / `cargo:dev`），不要靠截图。

## 后果与守卫（Consequences）

- 守卫 **B98**：
  - `tests/menubar.test.ts` 正向断言 `scripts/build-all.sh` 含「点数 `dist/assets` + 不达标 exit 1」
    与「第 3 步标注不可交付 + 点出 `127.0.0.1` 指纹」；
  - 判据抽到 `tests/static.ts`（`hasDistIntegrityGuard` / `hasStep3NotDeliverableWarning`）；
  - `tests/reverse-verify.test.ts` 两条**退化对照**证明判据咬得住：
    ① 只点数、不阻断 → 判据必须为假；② 删掉警示 → 判据必须为假。
    两条都先自证退化脚本「确实少了那一半」，否则「字符串不相等」是恒真假绿。
- ⚠️ **「退出码 0 / 日志全绿」在本项目反复骗人**（0082 / 0083 / 0085 / 本条）。
  交付类改动一律**回读产物**：体积、PE 导入表、嵌入资源、`cargo:dev`。
- ⚠️ **空屏的排查顺序**：先看 `dist/` 是否完整、再看 `cargo:dev`，最后才怀疑环境。
  本次实测用 BitBlt 抓窗口，内容区恒为 `#1b1d1f` —— 正好等于 `tauri.conf.json` 的
  `backgroundColor`，即**原生窗口底色**（webview 表面没被合成进来）。
  对照实验：装在 `D:\Program Files\LitePad\litepad.exe` 的 0.10.x（GNU + dll、
  此前一直可用、9/19 的截图就是它拍的）抓出来是**字节数完全相同**的空白图。
  ⇒ 空屏是**本沙箱的限制**，`msedgewebview2.exe` 起了、UDD 正常增长，
  清 `EBWebView` 也不解决，别在这上面继续耗。
