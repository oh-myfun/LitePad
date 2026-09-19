# ADR 0082：`git log --pretty=format:` 的末条无换行，`while read` 会静默吞掉区间内最旧的提交

- **状态**：Accepted
- **域**：构建 / 发布脚本
- **来源**：B82（v0.8.0 发布时发现 CHANGELOG 少了本版唯一的 feat 条目）
- **关联**：`scripts/gen-changelog.sh`；守卫 `tests/regressions.test.ts` B82；
  同源问题见 0074 / 0083（都是「脚本站错了会静默失效」）

## 背景（Context）
v0.8.0 发布后核对 CHANGELOG，发现本该有的 `### 新功能` 一节**整段不见了** ——
区间 `v0.7.0..HEAD` 里只有一个 feat（图标全线迁移），恰好被丢掉，
CHANGELOG 上只剩 `### 其他`（docs 那条）。计数也少 1。

手动补了 CHANGELOG 之后，问题变成：**生成器下次还会再犯**。

## 根因（Root Cause）
生成器这样读提交：

```sh
while IFS=$'\x1f' read -r sha subj; do … done \
  < <(git log "${PREV}..HEAD" --no-merges --pretty=format:'%h%x1f%s')
```

`git log --pretty=format:` 的输出**最后一条记录不带尾换行**。而 POSIX `read` 在遇到
「读到内容但没等到换行就 EOF」时返回**非 0**，于是：

- 循环体对最后一条**不执行**；
- 循环条件为假 → `while` 直接退出 → 脚本**静默**结束，退出码仍是 0。

`git log` 是**新 → 旧**排列，所以「最后一条」= **区间内最旧的提交**。
v0.8.0 的区间恰好只有 2 个提交，最旧那个就是 feat ⇒ 整节消失。

关键点：这不是「漏了一个字符」，而是**整条记录被丢弃**，且不报错、不警告。

## 决策（Decision）
循环条件补 EOF 兜底，把「有内容但无换行」也算作一条：

```sh
while IFS=$'\x1f' read -r sha subj || [ -n "$sha" ]; do
```

配套：
- 循环体内保留 `[ -n "$subj" ] || continue`，滤掉正常尾行产生的空记录；
- 新增 **B82** 静态守卫，断言生成器里存在 `|| [ -n "$sha" ]`；
- 任何「`while read` 消费 `--pretty=format:` 输出」的新脚本，照抄这个条件。

## 后果与守卫（Consequences）
- 修复后重跑，区间内 N 个提交全部进 CHANGELOG（实测 2/2、4/4）。
- ⚠️ **对生成器类脚本要「回读产物 + 比对计数」**，不能只看退出码 0：
  本 bug 全程退出码都是 0，`✓ CHANGELOG.md 已更新` 也会照常打印。
  与 `MEMORY.md` 红线「编辑回报成功 ≠ 已落盘」是同一类：**静默成功最危险**。
- ⚠️ 顺带记：`gen-changelog.sh` 永远是**前置**新小节、不做去重。重跑同一个版本区间
  会得到**两份 `## vX.Y.Z`**。所以它只能在发布流程里跑一次；核对历史版本请
  `git show <release-commit>:CHANGELOG.md`，别重跑生成器。
