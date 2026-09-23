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
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov", "json-summary"],
			// vitest 的 exclude 是整体替换而非追加，故默认项须一并列出。
			// 在其基础上只多加两条排除：vendored 上游代码（与 Biome ignore 同一理由）、
			// 编译期即擦除的纯类型模块。web/ 与 extensions/ 胶水层保留在分母内——它们确实是 0，
			// 门槛要如实反映这一点。
			exclude: [
				"**/node_modules/**",
				"**/dist/**",
				"**/coverage/**",
				"**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
				"extensions/subagent/**",
				"extensions/lib/types.ts",
			],
			// 门槛 = 2026-09-23 实测值向下取整到 5（stmts 45.40 / branch 77.83 / funcs 67.76 / lines 45.40）。
			// 只作棘轮：覆盖率下滑即失败，上调需重新实测，不凭感觉填。
			thresholds: {
				statements: 45,
				branches: 75,
				functions: 65,
				lines: 45,
			},
		},
	},
});
