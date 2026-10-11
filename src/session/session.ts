// 会话模块门面（P3 批次）。
//
// 原 `src/session/session.ts` 上帝文件按职责拆成 persist / rebuild 两个子模块，本文件
// 只做重导出门面，保持所有 `import { ... } from "./session/session"` 的调用点零改动。
// 依赖方向单向：rebuild（恢复）→ persist（落盘/备份/外部变更），无环。
// 权威类型仍在 ./store（SessionState），本门面只是行为侧的汇出口。

export * from "./persist";
export * from "./rebuild";
