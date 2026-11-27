// 验收测试所需的最小 Node 全局声明（避免引入完整 @types/node）。
declare const process: {
  exitCode?: number;
  env: Record<string, string | undefined>;
};
