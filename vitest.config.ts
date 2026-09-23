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
			// ★ 分母必须由 include 显式钉住。vitest 3 的 `coverage.all` 在 v4 被**整个删除**，
			// 运行时对未知键静默忽略（写 all:true 不报错也不生效），默认口径退化为
			// "只统计被测试导入过的文件"——web/server.ts、checkflow.ts、hypotheses.ts 等 0% 文件
			// 会从分母消失，statements 因此从 45.40 "涨"到 68.85。那是口径缩小，不是代码变好。
			// 这条能被拦住是因为 vitest.config.ts 已纳入 tsconfig include：
			// tsc 报 `'all' does not exist in type 'CoverageOptions'`。
			include: ["extensions/**/*.ts", "web/**/*.ts"],
			// exclude 是整体替换而非追加；但 include 已把范围钉死在 extensions/ 与 web/，
			// vitest 默认的 node_modules/dist/config 模式与之无交集，故此处只留两条真正起作用的：
			// vendored 上游代码（与 Biome ignore 同一理由）、编译期即擦除的纯类型模块。
			// web/ 与 extensions/ 胶水层**保留在分母内**——它们确实是 0，门槛要如实反映。
			exclude: ["extensions/subagent/**", "extensions/lib/types.ts"],
			// 门槛 = 2026-09-23 在 vitest 4.1.11 下实测向下取整到 5
			// （stmts 47.84 / branch 43.75 / funcs ≈50 / lines 47.81，两次跑完全一致）。
			// functions 取 45 而非 50：报表里的 "50" 是四舍五入后的展示值，真实精度未知，
			// 按显示值设门等于留零余量，跨 OS runner 易翻车。
			// ★ 与 0.2.0 里 vitest 3.2.7 的 branch 77.83 / funcs 67.76 **不可比**：
			// vitest 4 改了 branch 与 function 的计数定义，只有 stmts/lines 同量级。
			thresholds: {
				statements: 45,
				branches: 40,
				functions: 45,
				lines: 45,
			},
		},
	},
});
