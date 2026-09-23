/**
 * extensions/checkflow.ts —— LLM 主管路径的编排工具（真实模型下由主管按序调用）。
 *
 * 分工：主管 LLM 负责"决定采什么、按序调用"，但**算分与出报告仍是确定性代码**——
 * finalize_report 复用 runCheckFlow 同一套尾段（置信度引擎 + 敏感性 + 5 段报告契约 + 第 5 段校验），
 * 因此"保留 LLM 主管"不以牺牲可复现的报告契约为代价。
 *
 * 主管按 check.md 规定的顺序调用：
 *   begin_check → (每分支) dispatch_collector → register_evidence → dispatch_verifier → dispatch_contrarian
 *   → finalize_report
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { computePosterior, sensitivityAnalysis } from "./lib/calibration.ts";
import { loadConfig, loadLikelihoodRatios } from "./lib/config.ts";
import { sharedEvidenceIndex } from "./lib/evidence.ts";
import { type BranchOutcome, buildReport } from "./lib/report.ts";
import { type BranchState, recordEvidence, resetRun, runState } from "./lib/runstate.ts";
import { setLastReport } from "./lib/runtime.ts";
import type { ContrarianResult, EvidenceRecord, RawItem } from "./lib/types.ts";

interface SessionView {
	getEntries(): Array<{ id: string; type: string; customType?: string }>;
}

/** appendEntry 不返回 id：追加后按 customType 从会话尾部取回。 */
function appendEntryId(pi: ExtensionAPI, sm: SessionView, customType: string, data: unknown): string {
	pi.appendEntry(customType, data);
	const last = [...sm.getEntries()].reverse().find((e) => e.type === "custom" && e.customType === customType);
	if (!last) throw new Error(`appendEntry(${customType}) 后未找到条目`);
	return last.id;
}

const RawItemSchema = Type.Object(
	{
		source: Type.String(),
		url: Type.String(),
		platform: Type.String(),
		title: Type.String(),
		rawSnippet: Type.String(),
		publishedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		author: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		channelAuthority: Type.Union([Type.Literal("official"), Type.Literal("ugc"), Type.Literal("web")]),
		comments: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
	},
	{ additionalProperties: true },
);

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const index = sharedEvidenceIndex();
	const textOut = (data: unknown) => ({
		content: [{ type: "text" as const, text: JSON.stringify(data) }],
		details: {},
	});

	pi.registerTool({
		name: "begin_check",
		label: "开始甄别",
		description:
			"初始化一次甄别运行：解析输入、生成默认三假设（软广/过期/样本不足）并在会话树上登记分支。整轮 /check 的第一步，只调用一次。",
		parameters: Type.Object({
			question: Type.String({ description: "用户输入的问题或方向" }),
			claim: Type.Optional(Type.String({ description: "待核实主张原文（缺省=question）" })),
		}),
		promptGuidelines: ["Call begin_check first, once, before any dispatch."],
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const st = resetRun(params.question, params.claim ?? params.question);
			const sm = ctx.sessionManager as unknown as SessionView;
			const out: Array<{ slug: string; statement: string; queries: string[] }> = [];
			for (const b of st.branches.values()) {
				const entryId = appendEntryId(pi, sm, "hypothesis", {
					slug: b.hypothesis.slug,
					statement: b.hypothesis.statement,
					queries: b.hypothesis.queries,
				});
				(b as BranchState & { entryId?: string }).entryId = entryId;
				pi.setLabel(entryId, `hyp/${b.hypothesis.slug}/open`);
				out.push({ slug: b.hypothesis.slug, statement: b.hypothesis.statement, queries: b.hypothesis.queries });
			}
			return textOut({
				branches: out,
				claim: st.claim,
				next: "对每个分支：dispatch_collector → register_evidence → dispatch_verifier → dispatch_contrarian；全部完成后 finalize_report",
			});
		},
	});

	pi.registerTool({
		name: "register_evidence",
		label: "登记证据",
		description:
			"把某分支采集到的原始证据登记进证据库（分配 evidence_id、以 custom entry 落盘、不进 LLM 上下文、contentHash 去重），返回 evidence_ids 供质检/反方引用。",
		parameters: Type.Object(
			{
				branch: Type.String({ description: "所属假设 slug（begin_check 返回的三个之一）" }),
				items: Type.Array(RawItemSchema, { description: "dispatch_collector 返回的原始条目数组，原样传入" }),
				degraded: Type.Optional(
					Type.Array(
						Type.Object(
							{ channel: Type.String(), query: Type.String(), reason: Type.String() },
							{ additionalProperties: true },
						),
					),
				),
			},
			{ additionalProperties: false },
		),
		promptGuidelines: [
			"After dispatch_collector, call register_evidence with branch + the returned items to obtain evidence_ids.",
		],
		async execute(_id, params) {
			const ids: string[] = [];
			let deduped = 0;
			for (const it of params.items as RawItem[]) {
				const { record, deduped: dup } = index.prepare(it);
				if (dup) {
					deduped++;
					if (!ids.includes(record.id)) ids.push(record.id);
					continue;
				}
				pi.appendEntry("evidence", record);
				index.register(record);
				ids.push(record.id);
			}
			recordEvidence(params.branch, ids);
			if (params.degraded?.length) {
				const st = runState();
				const b = st.branches.get(params.branch);
				if (b) b.degraded.push(...params.degraded);
			}
			return textOut({ branch: params.branch, evidence_ids: ids, added: ids.length - deduped, deduped });
		},
	});

	pi.registerTool({
		name: "finalize_report",
		label: "生成报告",
		description:
			"整轮甄别的最后一步：对已登记的证据与质检/反方产物运行确定性置信度引擎 + 敏感性分析，产出并校验 5 段报告（第 5 段缺失即失败）。主管不要自己写报告，调用本工具。",
		parameters: Type.Object({}),
		promptGuidelines: [
			"Call finalize_report exactly once as the final action, after all branches are verified and refuted.",
		],
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const st = runState();
			const branchOutcomes: BranchOutcome[] = [];
			const contrarianByBranch: Record<string, ContrarianResult | null> = {};
			const allAssessments = [];
			for (const b of st.branches.values()) {
				branchOutcomes.push({
					hypothesis: b.hypothesis,
					verdict: b.state,
					newEvidenceIds: b.newEvidenceIds,
					degraded: b.degraded,
					assessments: b.assessments,
				});
				contrarianByBranch[b.hypothesis.slug] = b.contrarian;
				allAssessments.push(...b.assessments);
			}
			const evidence: EvidenceRecord[] = index.list();
			const lrAdjustments = [...st.branches.values()].flatMap((b) => (b.contrarian ? b.contrarian.lrAdjustments : []));
			const meta = evidence.map((e) => ({ id: e.id, channelAuthority: e.channelAuthority, platform: e.platform }));
			const calib = computePosterior(allAssessments, meta, lrAdjustments, {
				priorLogodds: config.calibration.priorLogodds,
				lrTable: loadLikelihoodRatios(),
				cap: config.calibration.contrarianAdjustmentCap,
			});
			const sensitivity = sensitivityAnalysis(calib, config.calibration.sensitivityDeltaThreshold, meta.length);
			const report = buildReport({
				question: st.question,
				claim: st.claim,
				url: null,
				branchOutcomes,
				contrarianByBranch,
				assessments: allAssessments,
				evidence,
				calib,
				sensitivity,
				config,
				durationMs: Date.now() - st.startedAt,
				dispatchMode: `subagent(llm-supervisor)`,
			});
			setLastReport({ markdown: report.markdown, posterior: report.posterior });
			pi.sendMessage(
				{
					customType: "offerlens-report",
					content: report.markdown,
					display: true,
					details: { posterior: report.posterior, evidenceCount: evidence.length },
				},
				{ triggerTurn: false },
			);
			void ctx;
			return textOut({
				posterior: report.posterior,
				evidenceCount: evidence.length,
				gaps: report.gaps.length,
				note: "报告已作为 offerlens-report 呈现，无需再复述",
			});
		},
	});
}
