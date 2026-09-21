# pitfalls/0097 — tests/ 不进 tsc，搬用例漏 import 只到运行时才红

日期：2026-09-22　关联：测试整理拆 regressions.test.ts

## 现象
把用例从 `tests/regressions.test.ts` 搬到新建的模块测试文件后，`tsc --noEmit`（pre-commit 里的
`tsc -b`）全绿，但 `vitest` 一跑整片红：

> ReferenceError: themeBlock is not defined
> ReferenceError: readJson is not defined
> ReferenceError: FILE_FAMILIES is not defined

一次红了 35 条，全是因为新文件少了 `import { themeBlock } from "./static"` / `import { readFileSync } from "node:fs"`。

## 根因
`tsconfig.json` 的 `include` 只有 `["src"]`，**测试目录根本不在编译单元里**——
`tsc --noEmit` 一行 tests 代码都不看，所以「引用了没导入的标识符」这种错只在 vitest 运行时
（`ReferenceError`）才冒头，类型检查阶段一律放行。

这跟 B91-2「编辑回报成功 ≠ 已落盘」是同族坑：**门禁绿 ≠ 真没问题**，缺口藏在执行期。

## 判据 / 自检
- 跨文件搬 `it` 块后，逐文件 grep 用到的 `static.ts` 导出名与 `node:fs`/`node:path` 绑定，确认都 import 了。
- 辅助脚本 `.tmp/check-imports.cjs`：扫 `tests/*.ts`「用到但没 import」的标识符
  （候选集 = `readJson/themeBlock/ruleBlock/cssDecls/stripLineComments/topLevelFnBody/FILE_FAMILIES/
  collectTextFiles/readFileSync/readdirSync/join/extname/dirname/basename/resolve/existsSync`）。
  ⚠️ 必然有误报：数组 `.join(`、`.Promise.resolve`、`await import("node:fs")` 动态导入 —— 需人工 glance。
- 拆完用「用例标题集合」与拆前基线逐条 `comm -3` 比对，确认零丢失、零新增（本次 562 条零差）。

## 长期修复候选（暂缓，待定）
1. 加 `tsconfig.tests.json`（`include:["tests","src"]`，`types:["node","vitest"]`，但仓库当前**没装
   `@types/node`**，需先装），pre-commit/CI 的 `tsc -b` 改成双工程（root + tests）。
2. 或保持现状，把「tests 静态 import 自检」塞进 `scripts/run-vitest.cjs` 启动前跑（零成本、不改工程）。

## 教训
- 任何「搬运已有代码到新文件」的动作，门禁绿之后必须**真跑一次目标**（这里是 vitest），
  不能只看 tsc/eslint —— 缺口在运行时。
- 测试文件也是源代码，缺 import 同样致命；搬块时 import 跟着走，别让拆工具只搬 `describe` 体。
