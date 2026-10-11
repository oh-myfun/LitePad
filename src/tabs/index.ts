// 标签模块门面（P3 批次）。
//
// 原 `src/tabs.ts` 上帝文件按职责拆成 render / lifecycle / split / deps 四个子模块，
// 本文件只做重导出门面，保持所有 `import { ... } from "./tabs"`（含 `"../tabs"`）的
// 调用点零改动。子模块之间为（运行期安全的）循环引用，符号均在本文件经 `export *` 汇出。

export * from "./render";
export * from "./lifecycle";
export * from "./split";
export * from "./deps";
