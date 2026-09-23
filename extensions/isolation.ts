/**
 * extensions/isolation.ts —— ★ Schema 强制的上下文隔离（核心贡献 ②）。
 *
 * 问题：进程隔离保证"父历史传不过去"，但没保证主管只传原始证据——如果主管在
 * task 里顺手写上"质检认为可信度 0.8"，隔离就白费。
 *
 * 解法：让泄漏在类型层面无法表达——
 *   - 三个 dispatch_* 工具的参数 schema 是封闭的 TypeBox 对象
 *     （additionalProperties: false）。反方工具里**物理上不存在**
 *     verdicts / reasoning / summary 字段；真实 LLM 路径由 Pi 框架的
 *     validateToolArguments 在工具执行前拒绝（fail-closed），
 *     程序化路径由 lib/schema.ts 的同构校验拒绝；
 *   - evidence_ids 由扩展侧解析为 rawSnippet（resolveRawSnippets）：
 *     主管只能传"句柄"，传不了内容。
 *
 * 执行路由（两种模式走同一 schema）：
 *   - stub（默认，占位模型）：角色逻辑进程内确定性执行；
 *   - subagent：vendored subagent 派发独立 pi 进程（--mode json -p --no-session
 *     + --append-system-prompt 角色定义 + --model 占位 Provider 或真实模型）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./lib/config.ts";
import { sharedEvidenceIndex } from "./lib/evidence.ts";
import { runCollector, runContrarian, runVerifier, type VerifierInputItem } from "./lib/roles.ts";
import { type BranchState, hasRunState, recordContrarian, recordVerifier, runState } from "./lib/runstate.ts";
import { runtime } from "./lib/runtime.ts";
import { assertContrarianSchemaIsolation, validateDispatchPayload } from "./lib/schema.ts";
import type {
	Assessment,
	CollectorPayload,
	CollectorResult,
	ContrarianPayload,
	ContrarianResult,
	Hypothesis,
	RawItem,
	SourcePlanEntry,
	VerifierPayload,
	VerifierResult,
} from "./lib/types.ts";
import { isFailedResult, runSingleAgent } from "./subagent/index.ts";

/* ---------- TypeBox 封闭 schema（与 lib/schema.ts 的规范描述一一对应） ---------- */

const CollectorParams = Type.Object(
	{
		hypothesis: Type.String({ description: "当前假设的自然语言描述（给采集的上下文，不是结论）" }),
		queries: Type.Array(Type.String(), { description: "查询关键词" }),
		urls: Type.Optional(Type.Array(Type.String(), { description: "用户直接给定的待核实链接（输入，非结论）" })),
		sourcePlan: Type.Optional(
			Type.Array(
				Type.Object({
					tool: Type.String({ description: "内容源工具名：fetch_bilibili / fetch_web / fetch_rss / fetch_youtube" }),
					args: Type.Record(Type.String(), Type.String()),
				}),
				{ description: "内容源调用计划（可选；subagent 模式下子进程照此执行）" },
			),
		),
	},
	{ additionalProperties: false },
);

const VerifierParams = Type.Object(
	{
		evidence_ids: Type.Array(Type.String(), { description: "证据句柄，由扩展侧解析为原文" }),
		claim: Type.Optional(Type.String({ description: "用户主张原文（相关性判定的对象本身，不是任何前序结论）" })),
		focus: Type.Optional(Type.String({ description: "质检关注点提示——禁止携带评分/结论" })),
	},
	{ additionalProperties: false },
);

const ContrarianParams = Type.Object(
	{
		claim: Type.String({ description: "待反驳的主张原文" }),
		evidence_ids: Type.Array(Type.String(), { description: "原始证据 ID，由扩展侧解析为原文" }),
		// ★ 物理上不存在 verdicts / reasoning / summary 字段
	},
	{ additionalProperties: false },
);

/* ---------- 程序化派发器（/check 编排与 LLM 工具共用） ---------- */

export interface DispatchOutcome<T> {
	ok: boolean;
	result?: T;
	error?: string;
	via: "stub" | "subagent";
}

/* ---------- 子进程结果捕获：function-calling 档，取代"提示词要 JSON + JSON.parse" ---------- */

type LooseMessage = {
	role?: string;
	toolName?: string;
	content?: Array<{ type?: string; text?: string; name?: string; arguments?: unknown }>;
};

export type { LooseMessage };

/** 从子进程消息流里倒序找最后一次对某个 emit 工具的调用入参（Pi 已按 schema 校验）。 */
export function captureEmitArgs(messages: LooseMessage[], toolName: string): unknown | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content) {
			if (block.type === "toolCall" && block.name === toolName) return block.arguments ?? null;
		}
	}
	return null;
}

/** 采集：不要求 LLM 重发大 JSON，直接收割 fetch_* 工具的结构化返回（工具结果本就是 RawItem[]）。 */
export function harvestCollector(messages: LooseMessage[]): {
	items: RawItem[];
	degraded: Array<{ channel: string; query: string; reason: string }>;
} {
	const items: RawItem[] = [];
	const degraded: Array<{ channel: string; query: string; reason: string }> = [];
	for (const m of messages) {
		if (m.role !== "toolResult") continue;
		const tool = m.toolName ?? "";
		if (!tool.startsWith("fetch_")) continue;
		const text = (m.content ?? []).map((c) => c.text ?? "").join("\n");
		try {
			const json = JSON.parse(text) as unknown;
			if (Array.isArray(json)) items.push(...(json as RawItem[]));
			else if (json && typeof json === "object" && "error" in (json as Record<string, unknown>)) {
				degraded.push({
					channel: tool.replace("fetch_", ""),
					query: "",
					reason: String((json as Record<string, unknown>).error),
				});
			}
		} catch {
			/* 非 JSON 的工具输出忽略（例如降级路径的结构化错误已是 JSON） */
		}
	}
	return { items, degraded };
}

/** 启动一个角色子进程（真实模型），返回其原始 SingleResult；失败时给结构化 error。 */
async function runRoleProcess(role: "collector" | "verifier" | "contrarian", taskPayload: unknown) {
	const { discoverAgents } = await import("./subagent/agents.ts");
	const discovery = discoverAgents(process.cwd(), "both");
	const agent = discovery.agents.find((a) => a.name === role);
	if (!agent) {
		return { ok: false as const, error: `角色 ${role} 未定义（.pi/agents/${role}.md 缺失，运行 /offerlens-setup）` };
	}
	const result = await runSingleAgent(
		process.cwd(),
		{ model: agent.model ?? undefined },
		discovery.agents,
		role,
		`Task: ${JSON.stringify(taskPayload)}`,
		undefined,
		undefined,
		undefined,
		() => undefined,
		(results) => ({ mode: "single", agentScope: "both", projectAgentsDir: discovery.projectAgentsDir, results }),
	);
	if (isFailedResult(result)) {
		return {
			ok: false as const,
			error: `子 Agent ${role} 失败: ${result.errorMessage ?? result.stderr.slice(0, 300)}`,
		};
	}
	return { ok: true as const, messages: result.messages as LooseMessage[] };
}

/**
 * B：子进程"未通过 emit 工具提交合法结果"时，重派一个全新子进程，最多 tries 次。
 * 读不到就报错重试，不做文本 JSON 兜底。每次尝试是独立进程，互不污染上下文。
 */
async function withRetry<T>(tries: number, runOnce: () => Promise<DispatchOutcome<T>>): Promise<DispatchOutcome<T>> {
	let last: DispatchOutcome<T> = { ok: false, error: "未执行", via: "subagent" };
	for (let i = 0; i < Math.max(1, tries); i++) {
		last = await runOnce();
		if (last.ok) return last;
	}
	return { ...last, error: `${last.error}（已重试 ${Math.max(1, tries) - 1} 次仍失败）` };
}

function collectorPlan(hypothesis: string, queries: string[], urls: string[]): SourcePlanEntry[] {
	const plan: SourcePlanEntry[] = queries.map((q) => ({ tool: "fetch_bilibili", args: { keyword: q } }));
	for (const u of urls) {
		plan.push(
			/youtube\.com|youtu\.be/.test(u)
				? { tool: "fetch_youtube", args: { url: u } }
				: { tool: "fetch_web", args: { url: u } },
		);
	}
	return plan;
}

export async function dispatchCollector(
	payload: CollectorPayload & { hypothesisStatement?: string },
): Promise<DispatchOutcome<CollectorResult>> {
	const config = loadConfig();
	const sanitized = validateDispatchPayload("dispatch_collector", payload).sanitized as unknown as CollectorPayload;
	// stub 模式：进程内执行角色逻辑（占位模型）
	if (config.dispatchMode === "stub") {
		const { channels } = runtime();
		const urls = sanitized.urls ?? [];
		const result = await runCollector(
			{ hypothesis: sanitized.hypothesis, queries: sanitized.queries, urls },
			{
				fetch_bilibili: (k) => channels.fetch_bilibili(k),
				fetch_web: (u) => channels.fetch_web(u),
				fetch_rss: (u) => channels.fetch_rss(u),
				fetch_youtube: (u) => channels.fetch_youtube(u),
			},
			{ maxItemsPerSource: config.sources.maxItemsPerSource, rssFeeds: config.sources.rss.feeds },
		);
		return { ok: true, result, via: "stub" };
	}
	// subagent 模式：sourcePlan 传给子进程执行 fetch_* 工具，父侧直接收割工具结果
	const sourcePlan =
		sanitized.sourcePlan ?? collectorPlan(sanitized.hypothesis, sanitized.queries, sanitized.urls ?? []);
	return withRetry(config.subagentRetries, async () => {
		const proc = await runRoleProcess("collector", {
			role: "collector",
			payload: { hypothesis: sanitized.hypothesis, queries: sanitized.queries, urls: sanitized.urls ?? [], sourcePlan },
		});
		if (!proc.ok) return { ok: false, error: proc.error, via: "subagent" };
		const { items, degraded } = harvestCollector(proc.messages);
		// #5 结构性守卫：采集子进程一个工具结果都没产出 → 判失败重试，不静默返回空
		if (items.length === 0 && degraded.length === 0) {
			return { ok: false, error: "采集子进程未产出任何 fetch_* 工具结果", via: "subagent" };
		}
		return {
			ok: true,
			result: {
				items,
				degraded,
				plan: {
					queries: sanitized.queries,
					urls: sanitized.urls ?? [],
					bilibili: sourcePlan.filter((p) => p.tool === "fetch_bilibili").length,
					web: sourcePlan
						.filter((p) => p.tool === "fetch_web" || p.tool === "fetch_youtube")
						.map((p) => String(p.args.url ?? "")),
					rss: sourcePlan
						.filter((p) => p.tool === "fetch_rss")
						.map((p) => String(p.args.keyword_or_url ?? p.args.url ?? "")),
				},
			},
			via: "subagent",
		};
	});
}

export async function dispatchVerifier(payload: VerifierPayload): Promise<DispatchOutcome<VerifierResult>> {
	const config = loadConfig();
	const sanitized = validateDispatchPayload("dispatch_verifier", payload).sanitized as unknown as VerifierPayload;
	// ★ evidence_ids 由扩展侧解析为原文 —— 质检拿到的只有原文+主张，没有主管结论
	const index = sharedEvidenceIndex();
	const evidence: VerifierInputItem[] = index.resolveRawSnippets(sanitized.evidence_ids).map((r) => ({
		...r,
		comments: index.get(r.id)?.comments ?? null,
	}));
	if (config.dispatchMode === "stub") {
		return { ok: true, result: runVerifier({ evidence, claim: sanitized.claim, focus: sanitized.focus }), via: "stub" };
	}
	// subagent 混合模式：质检 LLM 只判"相关性"（真正需要语义理解的一步），其余特征仍由确定性
	// extractFeatures 计算 —— 保住"同样证据→同样数字"，只把易漂移的判断交给模型。
	return withRetry(config.subagentRetries, async () => {
		const proc = await runRoleProcess("verifier", {
			role: "verifier",
			payload: {
				claim: sanitized.claim,
				evidence: evidence.map((e) => ({ id: e.id, title: e.title, rawSnippet: e.rawSnippet })),
			},
		});
		if (!proc.ok) return { ok: false, error: proc.error, via: "subagent" };
		const emitted = captureEmitArgs(proc.messages, "emit_verifier_result") as { relevance?: unknown } | null;
		const rows = emitted?.relevance;
		if (!Array.isArray(rows)) {
			return { ok: false, error: "质检子进程未通过 emit_verifier_result 提交相关性数组", via: "subagent" };
		}
		const override: Record<string, "on-topic" | "tangent" | "unknown"> = {};
		for (const row of rows as Array<{ id?: unknown; relevance?: unknown }>) {
			const id = typeof row?.id === "string" ? row.id : null;
			const rel = row?.relevance;
			if (!id || (rel !== "on-topic" && rel !== "tangent" && rel !== "unknown")) {
				return {
					ok: false,
					error: `质检相关性条目不合法（需 {id, relevance∈on-topic|tangent|unknown}）: ${JSON.stringify(row).slice(0, 120)}`,
					via: "subagent",
				};
			}
			override[id] = rel;
		}
		return {
			ok: true,
			result: runVerifier({ evidence, claim: sanitized.claim, focus: sanitized.focus, relevanceOverride: override }),
			via: "subagent",
		};
	});
}

export async function dispatchContrarian(payload: ContrarianPayload): Promise<DispatchOutcome<ContrarianResult>> {
	const config = loadConfig();
	const sanitized = validateDispatchPayload("dispatch_contrarian", payload).sanitized as unknown as ContrarianPayload;
	// ★ schema 只收 claim + evidence_ids；扩展侧解析句柄为原文
	const index = sharedEvidenceIndex();
	const evidence: VerifierInputItem[] = index.resolveRawSnippets(sanitized.evidence_ids).map((r) => ({
		...r,
		platform: index.get(r.id)?.platform,
		channelAuthority: index.get(r.id)?.channelAuthority,
	}));
	if (config.dispatchMode === "stub") {
		return { ok: true, result: runContrarian({ claim: sanitized.claim, evidence }), via: "stub" };
	}
	return withRetry(config.subagentRetries, async () => {
		const proc = await runRoleProcess("contrarian", {
			role: "contrarian",
			payload: { claim: sanitized.claim, evidence },
		});
		if (!proc.ok) return { ok: false, error: proc.error, via: "subagent" };
		const emitted = captureEmitArgs(proc.messages, "emit_contrarian_result") as ContrarianResult | null;
		// #5 结构性守卫：必填键缺失即判失败并重试，绝不把残缺对象喂进置信度引擎
		if (
			!emitted ||
			typeof emitted.rebuttal !== "string" ||
			!Array.isArray(emitted.lrAdjustments) ||
			typeof emitted.couldNotRefute !== "boolean"
		) {
			return {
				ok: false,
				error: "反方子进程未通过 emit_contrarian_result 提交合法结果（缺 rebuttal/lrAdjustments/couldNotRefute）",
				via: "subagent",
			};
		}
		return { ok: true, result: { ...emitted, claim: sanitized.claim }, via: "subagent" };
	});
}

/* ---------- 扩展入口：注册三个工具 + 启动自检 ---------- */

export default function (pi: ExtensionAPI) {
	// 启动自检：反方 schema 里没有可泄漏的字段（fail fast）
	assertContrarianSchemaIsolation();

	const textOut = (data: unknown) =>
		({
			content: [{ type: "text" as const, text: JSON.stringify(data) }],
			details: {},
		}) satisfies import("@earendil-works/pi-agent-core").AgentToolResult<Record<string, never>>;

	pi.registerTool({
		name: "dispatch_collector",
		label: "派发采集",
		description:
			"派发采集 Agent（目标：全）。宁多收不漏收，禁止丢弃疑似软广。参数只有假设描述与查询计划——没有传递前序结论的字段。",
		parameters: CollectorParams,
		promptGuidelines: ["Use dispatch_collector to gather raw evidence for a hypothesis before any judgment."],
		async execute(_id, params) {
			const outcome = await dispatchCollector(params as CollectorPayload);
			return textOut(outcome.ok ? outcome.result : { error: outcome.error });
		},
	});

	pi.registerTool({
		name: "dispatch_verifier",
		label: "派发质检",
		description:
			"派发质检 Agent（目标：准）。只收 evidence_ids（扩展侧解析为原文片段）与主张原文——质检在独立上下文里逐条打特征分。",
		parameters: VerifierParams,
		promptGuidelines: [
			"Use dispatch_verifier with evidence_ids from collected evidence; never pass scores or conclusions.",
		],
		async execute(_id, params) {
			const outcome = await dispatchVerifier(params as VerifierPayload);
			// LLM 主管路径：把质检产物并入共享运行态，并按裁决更新分支 label（占位路径不经此处）
			if (outcome.ok && hasRunState()) {
				const touched = recordVerifier(outcome.result!.assessments, outcome.result!.corpus);
				const st = runState();
				for (const slug of touched) {
					const b = st.branches.get(slug) as (BranchState & { entryId?: string }) | undefined;
					if (b?.entryId) pi.setLabel(b.entryId, `hyp/${slug}/${b.state}`);
				}
			}
			return textOut(outcome.ok ? outcome.result : { error: outcome.error });
		},
	});

	pi.registerTool({
		name: "dispatch_contrarian",
		label: "派发反方",
		description:
			"派发反方 Agent（目标：反，只推理不检索）。★ 参数 schema 只有 claim 与 evidence_ids——不存在能传递前序结论的字段，主管无法表达它就无法泄漏。",
		parameters: ContrarianParams,
		promptGuidelines: [
			"Use dispatch_contrarian with only the claim and evidence_ids; it attacks likelihood-ratio weights, not conclusions.",
		],
		async execute(_id, params) {
			const outcome = await dispatchContrarian(params as ContrarianPayload);
			// LLM 主管路径：反方产物并入运行态（供 finalize_report 计入 LR 调整与第 3 段）
			if (outcome.ok && hasRunState()) recordContrarian((params as ContrarianPayload).evidence_ids, outcome.result!);
			return textOut(outcome.ok ? outcome.result : { error: outcome.error });
		},
	});

	/* ---- 子进程"提交结果"工具（function-calling 档）：参数 schema 即校验契约 ----
	 * 子进程以调用这些工具收尾，父侧从消息流捕获其入参（Pi 已按 schema 校验，fail-closed），
	 * 取代脆弱的"提示词要 JSON + JSON.parse"。execute 只回一句确认，真正的值由父侧读 toolCall。 */
	pi.registerTool({
		name: "emit_verifier_result",
		label: "提交质检相关性",
		description:
			"质检子进程专用：以工具调用形式提交每条证据的相关性判定（on-topic/tangent/unknown）。混合模式下这是模型唯一要给的判断，其余特征由扩展侧确定性计算。",
		parameters: Type.Object(
			{
				relevance: Type.Array(
					Type.Object(
						{
							id: Type.String({ description: "证据 id" }),
							relevance: Type.Union([Type.Literal("on-topic"), Type.Literal("tangent"), Type.Literal("unknown")]),
						},
						{ additionalProperties: false },
					),
					{ description: "每条证据的相关性判定" },
				),
			},
			{ additionalProperties: false },
		),
		async execute() {
			return { content: [{ type: "text" as const, text: "已提交质检相关性" }], details: {}, terminate: true };
		},
	});

	pi.registerTool({
		name: "emit_contrarian_result",
		label: "提交反方结果",
		description: "反方子进程专用：以工具调用形式提交反驳论证与对似然比权重的有界调整（multiplier 0.2~5.0）。",
		parameters: Type.Object(
			{
				rebuttal: Type.String({ description: "反方论证全文（原样进报告第 3 段，不被改写）" }),
				lrAdjustments: Type.Array(
					Type.Object(
						{
							feature: Type.String({
								description:
									"被攻击的特征名（promoCode/authorDensity/staleness/sampleSize/channelAuthority/commentRebuttal）",
							}),
							multiplier: Type.Number({ description: "建议权重乘数，限定 0.2~5.0" }),
							argument: Type.String({ description: "理由，须引用具体证据" }),
						},
						{ additionalProperties: false },
					),
				),
				couldNotRefute: Type.Boolean({ description: "确实构造不出反驳时为 true" }),
			},
			{ additionalProperties: false },
		),
		async execute() {
			return { content: [{ type: "text" as const, text: "已提交反方结果" }], details: {}, terminate: true };
		},
	});
}

export type { Assessment, Hypothesis, RawItem };
