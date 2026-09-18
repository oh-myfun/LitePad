---
name: litepad-project-rule
description: Institutionalize a new standing project rule/convention in LitePad (E:/Project/LitePad) — pick the right home for the rule, give it teeth in the ignore chains, sweep the repo for existing violations, fix the docs and scripts that would keep propagating the old behavior, and prove the rule actually bites. Use when the user states a new convention ("临时文件放项目内" / "README 面向使用者" / "界面改动必须刷截图") rather than asking for a code change.
description_zh: "把用户新提的项目规则落到 LitePad 全仓：规则落点 + 忽略链 + 存量清扫 + 文档同步 + 对照验证"
description_en: "Land a new LitePad project rule end-to-end and prove it actually bites"
agent_created: true
---

# 把一条项目规则落到 LitePad 全仓

## 何时用

用户以「**项目规则 / 约定 / 以后都…**」的口气提一条标准（不是要改代码）。
本项目 70+ 轮里这类需求反复出现，每次最容易犯的错是「写一句备忘就算完」——
真正的价值在后 4 步。判断依据：需求里没有可运行的产物，但**改变了以后该怎么做事**。

## 五步（照做，别跳）

1. **规则落点 = `.workbuddy/memory/MEMORY.md` 的「项目约定（用户明确要求）」**
   这个文件每次会话都会被注入，是全仓**唯一「一定会被读到」**的地方。
   写法照既有条目：短句、可执行、把**禁忌**与**例外**都写上（例外尤其重要 ——
   不写清楚，下次会把不该搬的东西搬走，例如受管工具链 `~/.workbuddy/binaries`）。
  ⚠️ **MEMORY.md 是被整篇注入的索引，保持精简**：历史改动 / 待办清单挪到 `OPEN-ITEMS.md`
  （按需读取，不进会话常载），别堆在索引里让会话越来越臃肿（09-18 重构经验）。
2. **让规则在工具链上有牙齿**（按需）：`.gitignore` / `.prettierignore` /
   `eslint.config.js` 的 `ignores`；涉及源码目录的还要看 `tsconfig.json` 的 `include`。
   ⚠️ **顺序不能反**：先让它被忽略，否则往里塞的探针脚本会被 lint / 被 tsc 扫 / 进 commit。
3. **清扫存量违规**：`Grep` 全仓旧做法的残留（跳过 `node_modules`、`dist`、
   `docs/vscode-reference`），重点改**仍会被复用的脚本** —— 只改文档不改脚本 =
   下次一跑又把旧行为带回来。顺手看 `%TEMP%` 一类外部目录里是否已堆了历史产物
   （只扫描报告，**不要**擅自删）。
   ⚠️ **新落点也要告诉「全仓扫描型」守卫**：本项目里有一批测试/脚本会**枚举整个仓库**
   （`tests/regressions.test.ts` 的 `collectTextFiles` + `SKIP_DIRS`、prettier/eslint 的
   ignore 链、`tsconfig.json` 的 `include`）。新增一个可放任意内容的目录（`.tmp/`）
   而不同步这些清单，**下次往里面扔一个探针文件就会把无关的守卫判红** ——
   B72 推送时实测：`.tmp/notepad-ref/notepad_cap.py` 里一句「for LiteMD menu redesign」
   的注释把全仓改名守卫顶红了（历史副本记录旧名是正当的，是**守卫的扫描范围**错）。
   反之也要注意别有 `SKIP_DIRS` 漏项：加完先跑一遍受影响的守卫。
4. **同步「照抄型」文档**：`BUILD-ENV.md` 是精确命令手册，规则与它冲突时**必须改它**
   （下个会话就是照它抄命令的）；`.workbuddy/skills/**` 里已固化的老教条同理，
   冲突的整条改写，别只加注解。
5. **验证规则真的生效**（本项目硬要求：写了不算，得自证）：
   - `git check-ignore -v <探针路径>`；
   - prettier / eslint / tsc 要**造探针 + 在未忽略处放同内容文件做对照** ——
     「无匹配」和「已忽略」输出是**同一句话**（`All matched files use Prettier code style!`），
     不看对照就会假绿；
   - 验完把探针删干净（`ls -a` 复核）。

## 铁律

- ⚠️ **工作区脏时绝不提交**：本项目常有并行的 Bxx 改动在飞（实测 `git status` 隔几分钟
  自己就长出新 modified 文件 —— 另一个会话在同时改）。pre-commit 的 `tsc -b` 与
  pre-push 的 vitest/cargo 会把半成品一起判 → 既不该混进同一个 commit，
  也不该把可能红的树推上去。**改完如实报告，并写明「未提交」及原因，等收尾时一起提交。**
- ⚠️ 同一文件的编辑一律**串行**（并发写会互相覆盖，且两次都回报成功）。
- 规则若涉及删/搬既有文件：**先只读扫描出报告**，列清单 + 等显式确认才动手，绝不默认清理。

## 反例（本项目实测踩过）

- 只跑 `prettier --check .tmp`，看到「All matched files use Prettier code style!」差点当成功；
  加一份**根目录同内容对照**（它会报 `[warn]`）才证明 `.tmp` 是真被忽略。
- 旧文档与技能都断言「Bash 的 `/tmp` 会被解析成 `E:\tmp`」——**错**
  （实测 `cd /tmp && pwd -W` = `C:/Users/maoyu/AppData/Local/Temp`，即 `%TEMP%`）。
  教训：**文档里的环境结论也要复核**，不要当事实继承。
- `.prettierignore` 里加目录名要带尾斜杠（`generated-images/`、`.tmp/`），
  与既有条目保持一致写法。
