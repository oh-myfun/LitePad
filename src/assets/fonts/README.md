# 应用内嵌字体（B227）

LitePad 的默认观感以前全押在「本机装没装这两款字体」上：换台机器、或者用户自己把
Cascadia Mono / 思源黑体删了，编辑器的字宽和界面字形就跟着变。这里放的是这两款的
**子集化产物**，随应用走，不依赖系统。

| 文件                          | 家族名        | 用途                      | 字形 | 码位                             |
| ----------------------------- | ------------- | ------------------------- | ---- | -------------------------------- |
| `cascadia-mono-regular.woff2` | Cascadia Mono | 编辑器默认等宽            | 1227 | 1122                             |
| `noto-sans-sc-regular.woff2`  | Noto Sans SC  | 预览正文 / 界面默认非等宽 | 4737 | 4671（含 GB2312 一级 3755 汉字） |

## 来源与授权

两款都是 **SIL Open Font License 1.1**，随应用分发必须连 license 一起给：

- `LICENSE-CascadiaMono.txt` — Cascadia Mono，版权 **Microsoft Corporation**，
  取自 [@fontsource/cascadia-mono](https://www.npmjs.com/package/@fontsource/cascadia-mono)。
- `LICENSE-NotoSansSC.txt` — Noto Sans SC，版权 **Google Inc.**，
  取自 [@fontsource/noto-sans-sc](https://www.npmjs.com/package/@fontsource/noto-sans-sc)。

## 两个坑（重写生成脚本时别踩）

1. **等宽字体的子集化不能贪。** 少留一个码位，那个字符就掉到回落字体、字宽一变整屏跳动。
   所以等宽那份的范围比看到的宽：ASCII / Latin / 通用标点 / 箭头 / 数学运算符 / 制表符 /
   方块元素 / CJK 标点 / 全角形式都在里面，总码位 1122、65KB。
2. **可变字体不能直接子集化。** Noto Sans SC 的原始 `.ttf` 是 17.7MB 的可变字体
   （31036 字形、wght 100–900），直接子集会把整条轴的轮廓都带上；思源那份要先定字重。

## 重新生成

```bash
PATH="$HOME/.workbuddy/binaries/python/envs/default/Scripts:$PATH" python .tmp/make-fonts.py
```

源取自本机 `C:\Windows\Fonts` 里已有的同名文件（**不必联网下载**；换台没有该字体的
机器跑这台脚本会失败，那就从 fontsource 的 npm 包里取源）。定字重走独立 CLI：

```bash
python -m fontTools.varLib.instancer "C:/Windows/Fonts/NotoSansSC-VF.ttf" wght=400 -o out.ttf
```

⚠️ `pyftsubset` 没有 `--instancer`，Python API 的 `instantiateVariableFont` 传路径会报
`Missing required table fvar`，只认上面这条 `fontTools.varLib.instancer` CLI。
⚠️ 码位表**必须落文件**（`--unicodes-file=`）再喂给 pyftsubset：GB2312 一级汉字 3755 个
走命令行参数会撞 WinError 206（文件名或扩展名太长）。
