/**
 * Tree-of-Hypotheses 编排核心（★ 核心贡献 ①）—— 纯逻辑驱动器。
 *
 * 树级（Pi 会话树，主管独占） = 假设搜索：
 *   每个假设 = 一个 custom entry + label 状态机（hyp/<slug>/<state>），
 *   放弃的假设附裁决摘要（真实模型路径：navigateTree + HYPOTHESIS_ABANDON_PROMPT；
 *   占位路径：buildStubAbandonSummary 同构 5 段）。
 * 进程级 = 角色执行：真实模型时由 vendored subagent 派发独立 pi 进程；
 *   占位模式下为进程内确定性执行（schema 约束在两种模式下完全一致）。
 *
 * 主管纪律：收敛但不调和 —— 质检与反方的冲突不抹平，体现为置信度分量与信息缺口。
 * 跨分支去重：contentHash 全局去重，重复证据不重复计入似然比。
 */
import { computePosterior, sensitivityAnalysis } from "./calibration.ts";
import { loadLikelihoodRatios } from "./config.ts";
import { sharedEvidenceIndex } from "./evidence.ts";
import { buildStubAbandonSummary, planHypotheses, runCollector, runContrarian, runVerifier, verdict } from "./roles.ts";
import type { ChannelSet } from "./sources.ts";
import type { SourceTools } from "./roles.ts";
import { buildReport, type BranchOutcome } from "./report.ts";
import type {
	Assessment,
	ContrarianResult,
	EvidenceRecord,
	Hypothesis,
	HypothesisState,
	RawItem,
} from "./types.ts";
import type { OfferLensConfig } from "./config.ts";

export interface OrchestrationHooks {
	/** 进度事件（web SSE / notify）：agent_state / hypothesis / evidence / degraded / rebuttal / confidence / done。 */
	onEvent(type: string, data: unknown): void;
	/** 证据持久化：pi.appendEntry("evidence", record) —— custom entry 不进 LLM 上下文。 */
	appendEvidence(record: EvidenceRecord): void;
	/** 假设分支登记：pi.appendEntry("hypothesis", ...)，返回 entryId 供 setLabel。 */
	appendHypothesis(h: Hypothesis): string;
	/** 状态机编码进 label：pi.setLabel(entryId, `hyp/<slug>/<state>`)。 */
	setLabel(entryId: string, label: string): void;
	/** 放弃假设的裁决摘要留存：pi.appendEntry("hypothesis-summary", ...)。 */
	appendAbandonSummary(slug: string, summary: string): void;
}

export interface CheckOptions {
	question: string;
	claim?: string | null;
	url?: string | null;
	/**
	 * 消融开关（**仅用于计划 §5.1 的定性对照演示**）：为 true 时不派发反方 Agent，
	 * 报告第 3 段随之退化为占位行，用于并排展示「有/无反方」的差异。
	 * 默认 undefined（= 正常派发）；打开它不会改变其余任何路径的行为。
	 */
	ablateContrarian?: boolean;
}

export interface CheckResult {
	markdown: string;
	posterior: number;
	gaps: { what: string; why: string }[];
	evidenceCount: number;
	branchOutcomes: BranchOutcome[];
	assessments: Assessment[];
	contrarianByBranch: Record<string, ContrarianResult | null>;
}

/** 采集/质检/反方的执行器：占位模式 = 进程内角色逻辑；真实模型 = vendored subagent 派发。 */
export interface RoleExecutor {
	executeCollector(payload: { hypothesis: string; queries: string[]; urls?: string[] }): Promise<{ items: RawItem[]; degraded: Array<{ channel: string; query: string; reason: string }> }>;
	executeVerifier(payload: { evidence_ids: string[]; claim: string }): Promise<{ assessments: Assessment[]; corpus: ReturnType<typeof runVerifier>["corpus"] }>;
	executeContrarian(payload: { claim: string; evidence_ids: string[] }): Promise<ContrarianResult>;
	mode: string;
}

/** 占位执行器：角色逻辑在进程内确定性执行（模型占位期）。 */
export function createStubExecutor(channels: ChannelSet, config: OfferLensConfig): RoleExecutor {
	const tools: SourceTools = {
		fetch_bilibili: (k) => channels.fetch_bilibili(k),
		fetch_web: (u) => channels.fetch_web(u),
		fetch_rss: (u) => channels.fetch_rss(u),
		fetch_youtube: (u) => channels.fetch_youtube(u),
	};
	return {
		mode: "stub",
		async executeCollector(payload) {
			return runCollector(payload, tools, { maxItemsPerSource: config.sources.maxItemsPerSource, rssFeeds: config.sources.rss.feeds });
		},
		async executeVerifier(payload) {
			const index = sharedEvidenceIndex();
			const raws = index.resolveRawSnippets(payload.evidence_ids).map((r) => ({ ...r, comments: index.get(r.id)?.comments ?? null }));
			const result = runVerifier({ evidence: raws, claim: payload.claim });
			return { assessments: result.assessments, corpus: result.corpus };
		},
		async executeContrarian(payload) {
			const index = sharedEvidenceIndex();
			const raws = index.resolveRawSnippets(payload.evidence_ids).map((r) => ({
				...r,
				platform: index.get(r.id)?.platform,
				channelAuthority: index.get(r.id)?.channelAuthority,
			}));
			return runContrarian({ claim: payload.claim, evidence: raws });
		},
	};
}

export async function runCheckFlow(
	opts: CheckOptions,
	config: OfferLensConfig,
	executor: RoleExecutor,
	hooks: OrchestrationHooks,
): Promise<CheckResult> {
	const startedAt = Date.now();
	const index = sharedEvidenceIndex();
	const claim = opts.claim ?? opts.question;
	const question = opts.question;

	hooks.onEvent("agent_state", { agent: "supervisor", state: "planning" });

	// ── 1. 主管规划（占位：确定性；真实模型：LLM 按角色语义产出同构计划）──
	const plan = planHypotheses(question, opts.claim ?? null, opts.url ?? null);
	hooks.onEvent("agent_state", { agent: "supervisor", state: "orchestrating", hypotheses: plan.hypotheses.map((h) => h.slug) });

	// ── 2. 逐假设分支执行 ──
	const branchOutcomes: BranchOutcome[] = [];
	const contrarianByBranch: Record<string, ContrarianResult | null> = {};
	const hypothesisEntryIds = new Map<string, string>();

	for (const hypothesis of plan.hypotheses) {
		const entryId = hooks.appendHypothesis(hypothesis);
		hypothesisEntryIds.set(hypothesis.slug, entryId);
		hooks.setLabel(entryId, labelFor(hypothesis.slug, "open"));
		hooks.onEvent("hypothesis", { slug: hypothesis.slug, statement: hypothesis.statement, state: "open" });

		// collector
		hooks.onEvent("agent_state", { agent: "collector", state: `working:${hypothesis.slug}` });
		const isFirstBranch = index.size() === 0;
		let collector: { items: RawItem[]; degraded: Array<{ channel: string; query: string; reason: string }> };
		try {
			collector = await executor.executeCollector({
				hypothesis: hypothesis.statement,
				queries: hypothesis.queries,
				...(isFirstBranch && opts.url ? { urls: [opts.url] } : {}),
			});
		} catch (e) {
			collector = { items: [], degraded: [{ channel: "collector", query: hypothesis.slug, reason: String((e as Error).message) }] };
		}
		const newIds: string[] = [];
		for (const item of collector.items) {
			const { record, deduped } = index.prepare(item);
			if (!deduped) {
				hooks.appendEvidence(record);
				index.register(record);
				newIds.push(record.id);
				hooks.onEvent("evidence", { ...record, branch: hypothesis.slug });
			} // 跨分支去重：重复 contentHash 不重复入库、不重复计入似然比
		}
		for (const d of collector.degraded) hooks.onEvent("degraded", { branch: hypothesis.slug, ...d });

		// verifier（evidence_ids 由扩展侧解析为原文——质检拿不到主管结论）
		hooks.onEvent("agent_state", { agent: "verifier", state: `working:${hypothesis.slug}` });
		let verifierRes: Awaited<ReturnType<RoleExecutor["executeVerifier"]>> | null = null;
		if (newIds.length > 0) {
			try {
				verifierRes = await executor.executeVerifier({ evidence_ids: newIds, claim });
			} catch (e) {
				hooks.onEvent("degraded", { branch: hypothesis.slug, channel: "verifier", reason: String((e as Error).message) });
			}
		}

		// contrarian（schema 只收 claim + evidence_ids）
		hooks.onEvent("agent_state", { agent: "contrarian", state: `working:${hypothesis.slug}` });
		let contrarian: ContrarianResult | null = null;
		const branchEvidenceIds = newIds;
		if (opts.ablateContrarian) {
			// 消融对照（计划 §5.1）：不派发反方 → 第 3 段退化为占位行。默认关闭。
			hooks.onEvent("degraded", { branch: hypothesis.slug, channel: "contrarian", reason: "ablation: 反方 Agent 已被对照开关禁用" });
		} else if (branchEvidenceIds.length > 0) {
			try {
				contrarian = await executor.executeContrarian({ claim, evidence_ids: branchEvidenceIds });
				contrarianByBranch[hypothesis.slug] = contrarian;
				hooks.onEvent("rebuttal", { branch: hypothesis.slug, couldNotRefute: contrarian.couldNotRefute });
			} catch (e) {
				hooks.onEvent("degraded", { branch: hypothesis.slug, channel: "contrarian", reason: String((e as Error).message) });
			}
		}

		// 裁决 + 状态机
		const v = verdict(hypothesis.slug, { evidenceCount: newIds.length, corpus: verifierRes?.corpus });
		hooks.setLabel(entryId, labelFor(hypothesis.slug, v));
		hooks.onEvent("hypothesis", { slug: hypothesis.slug, state: v });

		// 放弃/证据不足 → 裁决摘要留存（真实模型路径见 hypotheses.ts 的 navigateTree 分支）
		if (v === "abandoned" || v === "insufficient-evidence") {
			const summary = buildStubAbandonSummary(
				hypothesis,
				verifierRes?.assessments ?? [],
				newIds.length,
				v === "abandoned" ? "判别条件未达到 supported 阈值（见质检特征判定）。" : "证据量不足或采集通道整体不可达，分支无法推进。",
			);
			hooks.appendAbandonSummary(hypothesis.slug, summary);
		}

		branchOutcomes.push({
			hypothesis,
			verdict: v,
			newEvidenceIds: newIds,
			verifierSummary: undefined,
			degraded: collector.degraded,
			assessments: verifierRes?.assessments ?? [],
		});
	}

	// ── 3. 聚合（不调和）→ 结构化后验 + 敏感性 ──
	// 质检的 assessments 直接采用各分支执行器的产出（真实模式下那是质检 Agent
	// 在独立进程里的原始判定，主管不重跑、不改写）。evidence_id 全局唯一
	// （contentHash 去重），跨分支不会重复计入。
	hooks.onEvent("agent_state", { agent: "supervisor", state: "calibrating" });
	const allAssessments = branchOutcomes.flatMap((b) => b.assessments ?? []);
	const lrAdjustments = Object.values(contrarianByBranch).flatMap((c) => (c ? c.lrAdjustments : []));
	const evidenceMeta = index.list().map((e) => ({ id: e.id, channelAuthority: e.channelAuthority, platform: e.platform }));
	const calib = computePosterior(allAssessments, evidenceMeta, lrAdjustments, {
		priorLogodds: config.calibration.priorLogodds,
		lrTable: loadLikelihoodRatios(),
		cap: config.calibration.contrarianAdjustmentCap,
	});
	const sensitivity = sensitivityAnalysis(calib, config.calibration.sensitivityDeltaThreshold, evidenceMeta.length);
	hooks.onEvent("confidence", { posterior: calib.posterior, logodds: calib.logodds, final: true });

	// ── 4. 报告（第 5 段缺失 = 运行失败）──
	const report = buildReport({
		question,
		claim,
		url: opts.url ?? null,
		branchOutcomes,
		contrarianByBranch,
		assessments: allAssessments,
		evidence: index.list(),
		calib,
		sensitivity,
		config,
		durationMs: Date.now() - startedAt,
		dispatchMode: executor.mode,
	});
	hooks.onEvent("done", { posterior: calib.posterior, evidenceCount: index.size() });

	return {
		markdown: report.markdown,
		posterior: report.posterior,
		gaps: report.gaps,
		evidenceCount: index.size(),
		branchOutcomes,
		assessments: allAssessments,
		contrarianByBranch,
	};
}

export function labelFor(slug: string, state: HypothesisState | string): string {
	return `hyp/${slug}/${state}`;
}
