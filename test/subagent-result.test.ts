/**
 * 子进程结果捕获 / 采集收割 / 质检混合模式 的纯逻辑测试。
 *
 * 这些是 #1（function-calling 捕获）、#4（混合质检）、#5（结构性守卫的底层判据）的可离线验证部分，
 * 不依赖真实模型：直接喂构造的子进程消息流与证据，断言父侧解析正确。
 */
import { describe, expect, test } from "vitest";
import { captureEmitArgs, harvestCollector, type LooseMessage } from "../extensions/isolation.ts";
import { runVerifier } from "../extensions/lib/roles.ts";

const assistantToolCall = (name: string, args: unknown): LooseMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", name, arguments: args }],
});
const assistantText = (text: string): LooseMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const toolResult = (toolName: string, payload: unknown): LooseMessage => ({
	role: "toolResult",
	toolName,
	content: [{ type: "text", text: JSON.stringify(payload) }],
});

describe("captureEmitArgs（子进程 emit 工具入参捕获）", () => {
	test("取最后一次匹配工具的调用入参", () => {
		const msgs = [
			assistantToolCall("emit_contrarian_result", { rebuttal: "v1", lrAdjustments: [], couldNotRefute: false }),
			assistantText("中间说明"),
			assistantToolCall("emit_contrarian_result", {
				rebuttal: "v2-final",
				lrAdjustments: [{ feature: "sampleSize", multiplier: 1.5, argument: "x" }],
				couldNotRefute: false,
			}),
		];
		const got = captureEmitArgs(msgs, "emit_contrarian_result") as { rebuttal: string };
		expect(got.rebuttal).toBe("v2-final");
	});

	test("忽略其它工具与纯文本；无匹配返回 null", () => {
		const msgs = [assistantToolCall("fetch_bilibili", { keyword: "x" }), assistantText("done")];
		expect(captureEmitArgs(msgs, "emit_verifier_result")).toBeNull();
	});
});

describe("harvestCollector（从 fetch_* 工具结果收割，而非解析 LLM 大 JSON）", () => {
	test("合并多个 fetch 工具的 RawItem 数组", () => {
		const msgs = [
			toolResult("fetch_bilibili", [
				{
					source: "bilibili:1",
					url: "u1",
					platform: "bilibili",
					title: "t1",
					rawSnippet: "s1",
					publishedAt: null,
					author: null,
					channelAuthority: "ugc",
				},
			]),
			toolResult("fetch_rss", [
				{
					source: "rss:1",
					url: "u2",
					platform: "rss",
					title: "t2",
					rawSnippet: "s2",
					publishedAt: null,
					author: null,
					channelAuthority: "official",
				},
			]),
		];
		const { items, degraded } = harvestCollector(msgs);
		expect(items.map((i) => i.url)).toEqual(["u1", "u2"]);
		expect(degraded).toHaveLength(0);
	});

	test("工具返回 {error} → 记为降级，不计入 items", () => {
		const msgs = [toolResult("fetch_youtube", { error: "yt-dlp 未安装" })];
		const { items, degraded } = harvestCollector(msgs);
		expect(items).toHaveLength(0);
		expect(degraded[0]).toMatchObject({ channel: "youtube", reason: "yt-dlp 未安装" });
	});

	test("忽略非 fetch_* 工具与非 JSON 输出", () => {
		const msgs = [
			toolResult("emit_something", [1, 2, 3]),
			{ role: "toolResult", toolName: "fetch_web", content: [{ type: "text", text: "not json" }] } as LooseMessage,
		];
		const { items } = harvestCollector(msgs);
		expect(items).toHaveLength(0);
	});
});

describe("runVerifier 混合模式（确定性特征 + LLM 仅覆盖相关性）", () => {
	const evidence = [
		{
			id: "e1",
			title: "内推码 OFFER2027 分享",
			rawSnippet: "我用内推码投了字节实习",
			publishedAt: null,
			author: null,
			comments: null,
		},
	];

	test("relevanceOverride 覆盖相关性，但 promoCode 等特征仍确定性计算", () => {
		const r = runVerifier({ evidence, claim: "字节转正率", relevanceOverride: { e1: "tangent" } });
		expect(r.assessments[0].features.relevance).toBe("tangent"); // 来自 LLM 覆盖
		expect(r.assessments[0].features.promoCode.state).toBe(true); // 来自确定性正则
	});

	test("被覆盖为 tangent 的证据不计入 corpus.onTopic", () => {
		const r = runVerifier({ evidence, claim: "字节转正率", relevanceOverride: { e1: "tangent" } });
		expect(r.corpus.onTopic).toBe(0);
		expect(r.corpus.tangent).toBe(1);
	});

	test("无 override 时回退到确定性 assessRelevance（向后兼容 stub 路径）", () => {
		const r = runVerifier({ evidence, claim: "字节 内推码 实习" });
		expect(["on-topic", "tangent", "unknown"]).toContain(r.assessments[0].features.relevance);
	});
});
