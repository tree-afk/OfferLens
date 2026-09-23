/**
 * 编排端到端测试（替代旧 test/tree-evidence.test.js）→ vitest。
 *
 * 关键变化：旧实现需要真实的会话树 + 子进程；迁移后 `runCheckFlow` 的树/证据副作用
 * 全部通过 `OrchestrationHooks` 注入，因此可以用**内存 hooks** 完整验证：
 *   - 每个假设登记为 custom entry，label 编码状态机 `hyp/<slug>/<state>`
 *   - 放弃/证据不足的分支留下 5 段裁决摘要（hypothesis-summary custom entry）
 *   - 跨分支 contentHash 去重（重复内容不重复入库、不重复计入似然比）
 *   - 通道降级与结构缺陷 → 计入第 5 段信息缺口
 *   - 全流程不发真实网络请求（假 ChannelSet）
 */
import { beforeEach, describe, expect, test } from "vitest";
import { createStubExecutor, runCheckFlow, type CheckResult, type OrchestrationHooks } from "../extensions/lib/orchestrator.ts";
import { sharedEvidenceIndex } from "../extensions/lib/evidence.ts";
import { loadConfig } from "../extensions/lib/config.ts";
import { ChannelUnavailableError, type ChannelSet } from "../extensions/lib/sources.ts";
import type { EvidenceRecord, Hypothesis, RawItem } from "../extensions/lib/types.ts";

const VALID_STATES = ["open", "supported", "refuted", "abandoned", "insufficient-evidence"];

interface MemEntry {
	id: string;
	type: string;
	customType: string;
	data: unknown;
}

/** 内存版 OrchestrationHooks —— 等价于 Pi 的 appendEntry/setLabel，但不触碰真实会话。 */
function memHooks() {
	const entries: MemEntry[] = [];
	const labels = new Map<string, string>();
	const events: Array<{ type: string; data: unknown }> = [];
	let seq = 0;
	const hooks: OrchestrationHooks = {
		onEvent(type, data) {
			events.push({ type, data });
		},
		appendEvidence(record: EvidenceRecord) {
			entries.push({ id: `e${++seq}`, type: "custom", customType: "evidence", data: record });
		},
		appendHypothesis(h: Hypothesis) {
			const id = `e${++seq}`;
			entries.push({ id, type: "custom", customType: "hypothesis", data: { slug: h.slug, statement: h.statement, queries: h.queries } });
			return id;
		},
		setLabel(entryId, label) {
			labels.set(entryId, label);
		},
		appendAbandonSummary(slug, summary) {
			const id = `e${++seq}`;
			entries.push({ id, type: "custom", customType: "hypothesis-summary", data: { slug, summary } });
			labels.set(id, `hyp/${slug}/summary`);
		},
	};
	return { hooks, entries, labels, events };
}

function item(over: Partial<RawItem>): RawItem {
	return {
		source: "bilibili:x",
		url: "https://www.bilibili.com/video/BV1",
		platform: "bilibili",
		title: "实习经验分享",
		rawSnippet: "讲了一下实习转正的流程和感受，内容比较长所以看起来像正文。",
		publishedAt: null, // 无时间戳 → 时效 unknown
		author: null,
		channelAuthority: "ugc",
		...over,
	};
}

/** 假通道集：不发任何真实网络请求。 */
function fakeChannels(opts: { bilibili?: RawItem[]; rssThrows?: boolean } = {}): ChannelSet {
	const bili = opts.bilibili ?? [];
	return {
		async fetch_bilibili() {
			return bili;
		},
		async fetch_web() {
			return [];
		},
		async fetch_rss() {
			if (opts.rssThrows) throw new ChannelUnavailableError("rss", "HTTP 500");
			return [];
		},
		async fetch_youtube() {
			return [];
		},
		async probe() {
			return [{ channel: "bilibili", ok: true, detail: "fake" }];
		},
	};
}

async function run(question: string, channels: ChannelSet, cfg = loadConfig()): Promise<{ result: CheckResult; mem: ReturnType<typeof memHooks> }> {
	const mem = memHooks();
	const executor = createStubExecutor(channels, cfg);
	const result = await runCheckFlow({ question }, cfg, executor, mem.hooks);
	return { result, mem };
}

beforeEach(() => {
	sharedEvidenceIndex().rebuild([]); // 清空进程级证据索引
});

describe("runCheckFlow 端到端（占位模式，无网络）", () => {
	test("三个假设都被登记，label 编码状态机且状态在合法集合内", async () => {
		const four = [
			item({ source: "bilibili:1", url: "https://b/1", title: "帖子一" }),
			item({ source: "bilibili:2", url: "https://b/2", title: "帖子二" }),
			item({ source: "bilibili:3", url: "https://b/3", title: "帖子三" }),
			item({ source: "bilibili:4", url: "https://b/4", title: "内推码 OFFER2027 分享" }),
		];
		const { mem } = await run("字节 2027 届前端实习转正率", fakeChannels({ bilibili: four }));

		const hyps = mem.entries.filter((e) => e.customType === "hypothesis");
		expect(hyps.map((h) => (h.data as { slug: string }).slug).sort()).toEqual(["insufficient", "softad", "stale"]);

		// 每个分支的 label 形如 hyp/<slug>/<state>，state 属于白名单
		const branchLabels = [...mem.labels.values()].filter((l) => l.startsWith("hyp/") && !l.endsWith("/summary"));
		expect(branchLabels.length).toBe(3);
		for (const label of branchLabels) {
			const state = label.split("/")[2];
			expect(VALID_STATES, `非法状态 ${label}`).toContain(state);
		}
	});

	test("放弃/证据不足的分支留下 5 段裁决摘要（custom entry，不进 LLM 上下文）", async () => {
		const { mem } = await run("字节 2027 届前端实习转正率", fakeChannels({ bilibili: [item({ url: "https://b/1" }), item({ url: "https://b/2" })] }));

		const summaries = mem.entries.filter((e) => e.customType === "hypothesis-summary");
		expect(summaries.length).toBeGreaterThan(0);

		const text = (summaries[0].data as { summary: string }).summary;
		for (const seg of ["【假设】", "【支持它的证据】", "【推翻它的证据】", "【放弃的具体理由】", "【对其它分支的启示】"]) {
			expect(text, `裁决摘要缺少 ${seg}`).toContain(seg);
		}
		// 摘要条目的 label 可被 /tree 读为 hyp/<slug>/summary
		expect(mem.labels.get(summaries[0].id)).toMatch(/^hyp\/.+\/summary$/);
	});

	test("跨分支 contentHash 去重：同一内容只入库一次", async () => {
		const shared = [
			item({ url: "https://b/dup1", title: "同一条内容 A" }),
			item({ url: "https://b/dup2", title: "同一条内容 B" }),
		];
		const { mem } = await run("字节 2027 届前端实习转正率", fakeChannels({ bilibili: shared }));

		// 3 个假设分支各自调用同一通道，但同一内容只登记一次
		const evidenceEntries = mem.entries.filter((e) => e.customType === "evidence");
		expect(evidenceEntries.length).toBe(2);
		expect(sharedEvidenceIndex().size()).toBe(2);
	});

	test("第 5 段信息缺口非空，且包含小红书 by-design 排除项", async () => {
		const { result } = await run("字节 2027 届前端实习转正率", fakeChannels({ bilibili: [item({ url: "https://b/1" })] }));
		expect(result.gaps.length).toBeGreaterThan(0);
		expect(result.gaps.some((g) => g.what.includes("小红书"))).toBe(true);
		expect(result.markdown).toContain("## 5. ⚠️ 信息缺口");
	});

	test("通道降级 → 报告出现「来源不可达」并计入信息缺口", async () => {
		const { result } = await run("字节 2027 届前端实习转正率", fakeChannels({ bilibili: [item({ url: "https://b/1" })], rssThrows: false }));
		// 用一个整体不可达的通道集：bilibili 也抛错
		sharedEvidenceIndex().rebuild([]);
		const dead: ChannelSet = {
			async fetch_bilibili() {
				throw new ChannelUnavailableError("bilibili", "wbi 签名接口不可达");
			},
			async fetch_web() {
				throw new ChannelUnavailableError("web", "直连失败");
			},
			async fetch_rss() {
				throw new ChannelUnavailableError("rss", "HTTP 500");
			},
			async fetch_youtube() {
				throw new ChannelUnavailableError("youtube", "yt-dlp 未安装");
			},
			async probe() {
				return [];
			},
		};
		const { result: degraded } = await run("字节 2027 届前端实习转正率", dead);

		expect(degraded.gaps.some((g) => g.what.includes("来源不可达"))).toBe(true);
		expect(degraded.markdown).toMatch(/信息来源|来源不可达/);
		// 不崩溃，仍产出报告与结论
		expect(degraded.markdown).toContain("## 1. 结论摘要");
		expect(result.gaps.length).toBeGreaterThan(0);
	});

	test("全部通道不可达时不崩溃：假设全部记为证据不足", async () => {
		const dead: ChannelSet = {
			async fetch_bilibili() {
				throw new ChannelUnavailableError("bilibili", "unreachable");
			},
			async fetch_web() {
				throw new ChannelUnavailableError("web", "unreachable");
			},
			async fetch_rss() {
				throw new ChannelUnavailableError("rss", "unreachable");
			},
			async fetch_youtube() {
				throw new ChannelUnavailableError("youtube", "unreachable");
			},
			async probe() {
				return [];
			},
		};
		const { result, mem } = await run("多智能体方向 2027 届秋招", dead);

		const branchLabels = [...mem.labels.values()].filter((l) => l.startsWith("hyp/") && !l.endsWith("/summary"));
		expect(branchLabels.every((l) => l.endsWith("/insufficient-evidence"))).toBe(true);
		expect(result.evidenceCount).toBe(0);
		expect(result.gaps.some((g) => g.what.includes("样本量不足"))).toBe(true);
	});

	test("审计事件齐全（agent_state / hypothesis / evidence / confidence / done）", async () => {
		const { mem } = await run("字节 2027 届前端实习转正率", fakeChannels({ bilibili: [item({ url: "https://b/1" }), item({ url: "https://b/2" })] }));
		const types = new Set(mem.events.map((e) => e.type));
		for (const expected of ["agent_state", "hypothesis", "evidence", "confidence", "done"]) {
			expect(types, `缺少事件 ${expected}`).toContain(expected);
		}
		// 置信度事件带最终后验
		const conf = mem.events.filter((e) => e.type === "confidence").at(-1)!.data as { posterior: number; final: boolean };
		expect(conf.final).toBe(true);
		expect(conf.posterior).toBeGreaterThanOrEqual(0);
		expect(conf.posterior).toBeLessThanOrEqual(1);
	});

	test("报告 5 段结构齐备（标题级断言）", async () => {
		const { result } = await run("字节 2027 届前端实习转正率", fakeChannels({ bilibili: [item({ url: "https://b/1" }), item({ url: "https://b/2" })] }));
		for (const heading of ["## 1. 结论摘要", "## 2. 证据清单", "## 3. 反面证据", "## 4. 行动建议", "## 5. ⚠️ 信息缺口"]) {
			expect(result.markdown, `报告缺少 ${heading}`).toContain(heading);
		}
	});

	test("同输入两次运行 → 同后验（确定性可复现）", async () => {
		const build = () => fakeChannels({ bilibili: [item({ url: "https://b/1" }), item({ url: "https://b/2" })] });
		const a = await run("字节 2027 届前端实习转正率", build());
		sharedEvidenceIndex().rebuild([]);
		const b = await run("字节 2027 届前端实习转正率", build());
		expect(a.result.posterior).toBe(b.result.posterior);
	});

	test("消融开关：禁用反方后无 rebuttal 事件，第 3 段退化为占位行（第 5 段仍强制非空）", async () => {
		const mem = memHooks();
		const cfg = loadConfig();
		const channels = fakeChannels({ bilibili: [item({ url: "https://b/1" }), item({ url: "https://b/2" })] });
		const result = await runCheckFlow(
			{ question: "字节 2027 届前端实习转正率", ablateContrarian: true },
			cfg,
			createStubExecutor(channels, cfg),
			mem.hooks,
		);

		// 反方未被派发
		expect(mem.events.some((e) => e.type === "rebuttal")).toBe(false);
		expect(Object.keys(result.contrarianByBranch).length).toBe(0);
		// 第 3 段退化为占位行，且报告结构完整
		expect(result.markdown).toContain("未派发反方");
		expect(result.markdown).toContain("## 5. ⚠️ 信息缺口");
		// 契约不被绕过：第 5 段仍非空
		expect(result.gaps.length).toBeGreaterThan(0);
	});

	test("个例主导的语料被判定，第 5 段出现「证据结构缺陷：majorityPersonal」", async () => {
		// 每条都含相关性关键词「实习」（否则会被质检判为 tangent 而排除出语料级分母），
		// 同时含「我同学/我室友/我认识的」类个例短语 → 质检判 sampleSize=personal。
		const personal = [
			item({ source: "bilibili:1", url: "https://b/1", title: "我同学实习转正了", rawSnippet: "我同学去年在字节实习，最后转正了，流程挺长。" }),
			item({ source: "bilibili:2", url: "https://b/2", title: "我室友的实习经历", rawSnippet: "我室友在字节实习过，转正率我觉得挺高。" }),
			item({ source: "bilibili:3", url: "https://b/3", title: "我认识的都转正了", rawSnippet: "我认识的几个在字节实习的人都转正了。" }),
			item({ source: "bilibili:4", url: "https://b/4", title: "实习转正闲聊", rawSnippet: "说说我身边朋友的实习转正情况。" }),
		];
		const { result } = await run("字节 2027 届前端实习转正率", fakeChannels({ bilibili: personal }));

		// 4 条全部相关且全部个例 → 4/4 = 100% > 50%，且 >= 3 条下限
		expect(result.gaps.some((g) => g.what.includes("majorityPersonal"))).toBe(true);
		expect(result.markdown).toContain("证据结构缺陷：majorityPersonal");
	});
});
