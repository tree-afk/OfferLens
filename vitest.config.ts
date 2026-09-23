import { defineConfig } from "vitest/config";

/**
 * OfferLens 测试配置。
 *
 * 全部测试跑在确定性逻辑上：内容源通过 `createChannels(config, fetchImpl)` 注入
 * 假 fetch，角色执行走 `createStubExecutor`（进程内确定性），无需真实 API key、
 * 不访问真实网络。
 */
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		testTimeout: 20_000,
		// 各测试文件共享进程级证据索引的清理在 beforeAll 中进行；串行更稳。
		fileParallelism: false,
	},
});
