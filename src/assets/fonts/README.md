# 应用内嵌字体（B227 / B369）

LitePad 的默认观感以前全押在「本机装没装这两款字体」上：换台机器、或者用户自己把
Cascadia Mono / 思源黑体删了，编辑器的字宽和界面字形就跟着变。这里放的是这两款的
**子集化产物**，随应用走，不依赖系统。

| 文件                          | 家族名        | 用途                      | 字形  | 码位                                                                     |
| ----------------------------- | ------------- | ------------------------- | ----- | ------------------------------------------------------------------------ |
| `cascadia-mono-regular.woff2` | Cascadia Mono | 编辑器默认等宽            | 1227  | 1122                                                                     |
| `noto-sans-sc-regular.woff2`  | Noto Sans SC  | 预览正文 / 界面默认非等宽 | 29120 | 28575（BMP 中文：统一表意 20976 + 扩展 A 6582 + 兼容表意 122 + 其余） |

## 为什么思源那份是全量（B369）

B227 的子集只收了 **GB2312 一级 3755 个汉字**，但 `fonts.css` 的等宽汉字层声明的是
`U+4E00-9FFF` 整段 —— 区外字（如「龘」「㐀」）逐字回落到微软雅黑，同一行中文出现
两种字形。B369 把子集扩到**源字体能提供的全部 BMP 中文**：统一表意 U+4E00–U+9FFF
收到 20976 字、扩展 A 收到 6582 字，外加兼容表意 / 假名 / 标点 / 全角。556KB → 约
4MB（安装包 +约 3.3MB），换任何一台 Windows 都是同一套字形。

⚠️ 本机源字体（`NotoSansSC-VF.ttf`）版本早于 Unicode 13，U+9FF0–U+9FFF 这 16 个新增字
没有字形（会逐字回落）；它们不是常用字。将来换新源字体时，
`tests/embedded-font.test.ts` 允许这段补上，不会误伤。

## 来源与授权

两款都是 **SIL Open Font License 1.1**，随应用分发必须连 license 一起给：

- `LICENSE-CascadiaMono.txt` — Cascadia Mono，版权 **Microsoft Corporation**，
  取自 [@fontsource/cascadia-mono](https://www.npmjs.com/package/@fontsource/cascadia-mono)。
- `LICENSE-NotoSansSC.txt` — Noto Sans SC，版权 **Google Inc.**，
  取自 [@fontsource/noto-sans-sc](https://www.npmjs.com/package/@fontsource/noto-sans-sc)。

## 三个坑（重写生成脚本时别踩）

1. **等宽字体的子集化不能贪。** 少留一个码位，那个字符就掉到回落字体、字宽一变整屏跳动。
   所以等宽那份的范围比看到的宽：ASCII / Latin / 通用标点 / 箭头 / 数学运算符 / 制表符 /
   方块元素 / CJK 标点 / 全角形式都在里面，总码位 1122、65KB。
2. **可变字体不能直接子集化。** Noto Sans SC 的原始 `.ttf` 是 17.7MB 的可变字体
   （31036 字形、wght 100–900），直接子集会把整条轴的轮廓都带上；思源那份要先定字重。
3. **汉字层必须真的覆盖声明的那几段。** `unicode-range` 是浏览器挑回退族的依据：
   声明了却没有字形，就会**逐字**掉到微软雅黑。`tests/embedded-font.test.ts` 直接解
   woff2 的 cmap 逐码位校验（扩展 A / 统一表意两段要求全中），还核 B347 那两个
   measure override 依赖的度量；换字体后先跑它。

## 重新生成

1. 从可变字体定字重：

```bash
python -m fontTools.varLib.instancer "C:/Windows/Fonts/NotoSansSC-VF.ttf" wght=400 -o noto400.ttf
```

2. 码位表落成文件，再喂给 `pyftsubset`：

```bash
python -m fontTools.subset noto400.ttf \
  --output-file=src/assets/fonts/noto-sans-sc-regular.woff2 \
  --flavor=woff2 \
  --unicodes-file=noto-ranges.txt \
  --layout-features='*' \
  --name-IDs='*' --name-legacy --name-languages='*' \
  --notdef-glyph --notdef-outline --recommended-glyphs
```

`noto-ranges.txt`（B369 实收）：

```text
U+0020-007E
U+00A0-00FF
U+2000-206F
U+2E80-2EFF
U+3000-303F
U+3040-30FF
U+31C0-31EF
U+3400-4DBF
U+4E00-9FFF
U+F900-FAFF
U+FE10-FE19
U+FE30-FE4F
U+FF00-FFEF
```

源取自本机 `C:\Windows\Fonts` 里已有的同名文件（**不必联网下载**；换台没有该字体的
机器跑这台脚本会失败，那就从 fontsource 的 npm 包里取源）。

⚠️ `pyftsubset` 没有 `--instancer`，Python API 的 `instantiateVariableFont` 传路径会报
`Missing required table fvar`，只认上面那条 `fontTools.varLib.instancer` CLI。
⚠️ 码位表**必须落文件**（`--unicodes-file=`）再喂给 pyftsubset：汉字区间上万个码位
走命令行参数会撞 WinError 206（文件名或扩展名太长）。
