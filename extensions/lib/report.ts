/**
 * 5 段式报告契约（纯逻辑）。
 *   1. 结论摘要      —— 一句话结论 + 结构化置信度（后验 + 敏感性标注）
 *   2. 证据清单表    —— 每条：URL/平台/时间/作者/时效/样本量/evidence_id
 *   3. 反面证据      —— 反方 Agent 原始输出，不被主管改写、不被折叠
 *   4. 行动建议      —— 具体到官方渠道与要问的问题
 *   5. ⚠️ 信息缺口   —— 强制段：缺失 = ReportValidationError = 运行失败
 */
import { nowIso, truncate } from "./util.ts";
import type { Assessment, CalibrationResult, ContrarianResult, EvidenceRecord, Hypothesis, SensitivityEntry } from "./types.ts";
import type { OfferLensConfig } from "./config.ts";

export class ReportValidationError extends Error {
	section: number;
	constructor(section: number, reason: string) {
		super(`报告契约校验失败（第 5 段「信息缺口」强制必填）: ${reason}`);
		this.name = "ReportValidationError";
		this.section = section;
	}
}

export interface BranchOutcome {
	hypothesis: Hypothesis;
	verdict: string;
	newEvidenceIds: string[];
	verifierSummary?: string;
	degraded: Array<{ channel: string; query: string; reason: string }>;
	/** 该分支质检执行器的原始判定（主管不改写、不重跑）。 */
	assessments?: Assessment[];
}

export interface ReportInput {
	question: string;
	claim: string;
	url: string | null;
	branchOutcomes: BranchOutcome[];
	contrarianByBranch: Record<string, ContrarianResult | null>;
	assessments: Assessment[];
	evidence: EvidenceRecord[];
	calib: CalibrationResult;
	sensitivity: SensitivityEntry[];
	config: Pick<OfferLensConfig, "calibration">;
	durationMs: number;
	dispatchMode: string;
}

export interface Gap {
	what: string;
	why: string;
}

const COMPANY_HINTS: Record<string, string> = {
	字节: "字节跳动招聘官网 jobs.bytedance.com（校招公告 + 官方答疑）",
	字节跳动: "字节跳动招聘官网 jobs.bytedance.com（校招公告 + 官方答疑）",
	腾讯: "腾讯招聘官网 join.qq.com（校招频道）",
	阿里: "阿里巴巴校园招聘 talent.alibaba.com",
	阿里巴巴: "阿里巴巴校园招聘 talent.alibaba.com",
	美团: "美团校园招聘 zhaopin.meituan.com",
	bilibili: "哔哩哔哩招聘 jobs.bilibili.com",
};

function fmtDate(iso: string | null): string {
	if (!iso || !Date.parse(iso)) return "未知";
	const d = new Date(iso);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 组装信息缺口条目 —— 每条都带"为什么"。 */
export function assembleGaps(ctx: {
	evidence: EvidenceRecord[];
	calib: CalibrationResult;
	sensitivity: SensitivityEntry[];
	collectorDegraded: Array<{ channel: string; query: string; reason: string }>;
	contrarianByBranch: Record<string, ContrarianResult | null>;
	config: Pick<OfferLensConfig, "calibration">;
}): Gap[] {
	const gaps: Gap[] = [];
	const seen = new Set<string>();
	const push = (what: string, why: string) => {
		if (seen.has(what)) return;
		seen.add(what);
		gaps.push({ what, why });
	};

	for (const d of ctx.collectorDegraded) {
		push(`来源不可达：${d.channel}（查询「${truncate(d.query, 30)}」）`, `三级降级耗尽：${d.reason}`);
	}
	push(
		"小红书等需登录态平台不在采集范围",
		"not supported by design (requires login) —— 设计决定：不做登录态注入，该平台信息缺失是显式边界",
	);

	const total = ctx.evidence.length;
	if (total < 3) push("样本量不足", `全部证据仅 ${total} 条（<3），后验的分辨率不足以支持判定`);
	const personal = ctx.calib.contributions.filter((c) => c.feature === "sampleSize" && c.state === "personal").length;
	if (personal > 0) push("个例证据占比高", `${personal} 条证据为个人经历叙述，与群体性主张之间存在选择效应`);
	if (ctx.calib.excludedCount > 0) {
		push(
			`${ctx.calib.excludedCount} 条证据与主张无直接关联（已排除出后验）`,
			"质检相关性门判定为 tangent；它们不贡献 log-odds，但仍可在第 2 段审计",
		);
	}
	for (const r of ctx.calib.corpusRows) {
		push(`证据结构缺陷：${r.feature}`, "语料级调整（手工设定权重）：单条特征叠加看不到的结构性单边，直接计入后验");
	}
	for (const s of ctx.sensitivity.filter((x) => x.sensitive)) {
		push(
			`后验对特征「${s.feature}」高度敏感（ΔP=${(s.deltaP * 100).toFixed(1)}pp）`,
			(s.touchedByContrarian ? "该特征权重已被反方 Agent 的攻击调整过；" : "") +
				`中和该特征后验将移动 ${(Math.abs(s.deltaP) * 100).toFixed(1)} 个百分点 —— 去核实这一根线`,
		);
	}
	const unknownStale = ctx.calib.contributions.filter((c) => c.feature === "staleness" && c.state === "unknown").length;
	if (unknownStale > 0) push(`${unknownStale} 条证据无可靠发布时间`, "源未提供时间戳，时效特征记为 unknown（不计入后验）");
	const unknownComments = ctx.calib.contributions.filter((c) => c.feature === "commentRebuttal" && c.state === "unknown").length;
	if (unknownComments > 0) push(`${unknownComments} 条证据的评论区不可达`, "评论区 API 未返回数据，反驳信号记为 unknown");
	const contrarianAttacked = ctx.calib.appliedAdjustments.filter((a) => a.applied).map((a) => a.feature);
	if (contrarianAttacked.length > 0) {
		push(
			`反方与质检在特征 [${contrarianAttacked.join(", ")}] 上存在张力`,
			"反方对该特征的似然比主张了调整（有界采纳）；主管按纪律不调和，张力保留在敏感性分析中",
		);
	}
	const couldNotRefute = Object.values(ctx.contrarianByBranch).some((c) => c?.couldNotRefute);
	if (couldNotRefute) {
		push("反方未能构造出反驳", "这最多说明现有证据结构攻不动，不构成对主张的支持证明（反方从不出具可信证明）");
	}
	return gaps;
}

export function buildReport(ctx: ReportInput): { markdown: string; gaps: Gap[]; posterior: number; stance: string } {
	const { calib, sensitivity, config } = ctx;
	const total = ctx.evidence.length;
	const posterior = calib.posterior;
	const pct = (posterior * 100).toFixed(1);

	// 结论带以先验几率 3:1 为界（|log-odds| ≥ ln3 ≈ 1.10 才谈"支持/质疑"）——保守是刻意的
	let stance: string;
	if (posterior >= 0.75) stance = "现有证据倾向于支持该信息的可靠性";
	else if (posterior >= 0.25) stance = "证据相互牵制，无法给出倾向性结论";
	else stance = "现有证据对该信息的可靠性构成实质质疑";
	const sensitiveTags = sensitivity.filter((s) => s.sensitive).map((s) => s.feature);

	const verifierById = new Map(ctx.assessments.map((a) => [a.id, a]));
	const evidenceRows = ctx.evidence.map((e) => {
		const f = verifierById.get(e.id)?.features;
		return [
			e.id,
			e.platform,
			truncate(e.title, 30),
			e.author ?? "—",
			fmtDate(e.publishedAt),
			f?.staleness ?? "—",
			f?.sampleSize ?? "—",
			f?.promoCode?.state === true ? "⚠️有" : "无",
			`[原文](${e.url})`,
		]
			.map((c) => String(c).replace(/\|/g, "\\|"));
	});

	const rebuttals = Object.entries(ctx.contrarianByBranch).filter(([, c]) => c?.rebuttal);
	const section3 = rebuttals.length
		? rebuttals
				.map(
					([slug, c]) =>
						`<details open><summary>分支 <code>hyp/${slug}</code> 的反方输出（${c!.couldNotRefute ? "未能构造出反驳" : "构造出反驳"}）</summary>\n\n---\n\n${c!.rebuttal}\n\n---\n\n</details>`,
				)
				.join("\n\n")
		: "_（未派发反方：无可反驳的证据面）_";

	const adviceLines: string[] = [];
	const seenAdvice = new Set<string>();
	for (const c of ctx.evidence.length ? hintCompanies(ctx) : []) {
		const h = COMPANY_HINTS[c];
		if (h && !seenAdvice.has(h)) {
			adviceLines.push(`- 去 **${h}** 二次确认官方口径（这是唯一不需要甄别的信息源）。`);
			seenAdvice.add(h);
		}
	}
	if (!adviceLines.length) adviceLines.push("- 去目标公司**官方**招聘渠道（官网校招页 / 官方公众号公告原文）二次确认，不要用搬运帖。");
	adviceLines.push(
		"- 问 HR / 在职学长学姐的三个问题：①「转正率」的分母口径是什么（是否剔除主动离职与被辞退者）；② 你们组最近两年各留用了几个实习生；③ offer 发放与转正答辩的时间线。",
		"- 对含内推码的内容：先向该公司官方渠道验证内推活动是否真实存在，再决定是否使用码。",
		"- 把「发布时间 > 90 天」的帖子当作背景资料而非决策依据：校招政策一年一变。",
	);

	const collectorDegraded = ctx.branchOutcomes.flatMap((b) => b.degraded);
	const gaps = assembleGaps({
		evidence: ctx.evidence,
		calib,
		sensitivity,
		collectorDegraded,
		contrarianByBranch: ctx.contrarianByBranch,
		config,
	});
	const section5 = gaps.map((g, i) => `${i + 1}. **${g.what}**\n   ↳ 为什么：${g.why}`).join("\n");

	const markdown = `# OfferLens 甄别报告

> 输入：${ctx.question}${ctx.claim !== ctx.question ? `\n> 待核实主张：${ctx.claim}` : ""}${ctx.url ? `\n> 指向内容：${ctx.url}` : ""}
> 生成于 ${nowIso()} · 运行耗时 ${(ctx.durationMs / 1000).toFixed(1)}s · 派发模式 ${ctx.dispatchMode}

## 1. 结论摘要

**${stance}**（结构化置信度 P(可靠)=${pct}%，log-odds=${calib.logodds.toFixed(2)}，基于 ${total} 条证据、${calib.contributions.length} 个特征判定）。
该数字由可数特征的似然比加权算出（手工权重、启发式、可复现），**不是**模型自报置信度，也未经标注集校准。
${sensitiveTags.length
	? `⚠️ 敏感性：结论对特征 [${sensitiveTags.join(", ")}] 高度敏感——中和任一特征后验将移动超过 ${(config.calibration.sensitivityDeltaThreshold * 100).toFixed(0)} 个百分点，详见第 5 段。`
	: `敏感性：无单一特征主导后验（阈值 ${(config.calibration.sensitivityDeltaThreshold * 100).toFixed(0)}pp）。`}

**后验构成**（特征 → log-odds 贡献，tanh 饱和后；反方调整过的标记 ⁂）：

| 特征 | 取值 | 贡献 |
|---|---|---|
${buildContributionRows(calib)}

**假设裁决**：

| 假设 | 裁决 | 新证据 |
|---|---|---|
${ctx.branchOutcomes.map((b) => `| hyp/${b.hypothesis.slug} | ${b.verdict} | ${b.newEvidenceIds.length} |`).join("\n")}

## 2. 证据清单

| evidence_id | 平台 | 标题 | 作者 | 发布时间 | 时效 | 样本 | 引流要素 | 溯源 |
|---|---|---|---|---|---|---|---|---|
${evidenceRows.length ? evidenceRows.map((r) => `| ${r.join(" | ")} |`).join("\n") : "| — | （无证据入库） | — | — | — | — | — | — | — |"}

作者发文密度为**检索语料内同作者计数**（代理指标，densityProxy=in-corpus）；证据原文以 custom entry 存于会话 JSONL（**不进 LLM 上下文**），可按 evidence_id 审计取回（/tree 可见分支标签）。

## 3. 反面证据（反方原始输出，未经理改写）

${section3}

## 4. 行动建议

${adviceLines.join("\n")}

## 5. ⚠️ 信息缺口

${section5 || "（空）"}

---
*假设树：\`${ctx.branchOutcomes.map((b) => `hyp/${b.hypothesis.slug}/${b.verdict}`).join(" / ")}\`（Pi 会话 /tree 查看，放弃分支附裁决摘要）*
`;

	validateSection5(section5);
	return { markdown, gaps, posterior, stance };
}

function hintCompanies(ctx: ReportInput): string[] {
	const companies = new Set<string>();
	for (const e of ctx.evidence) {
		for (const key of Object.keys(COMPANY_HINTS)) {
			if (`${e.title}${e.rawSnippet}`.includes(key)) companies.add(key);
		}
	}
	return [...companies];
}

function buildContributionRows(calib: CalibrationResult): string {
	const rows: string[] = [];
	const byFeature = new Map<string, { states: Set<string>; mult: number; adjustable: boolean }>();
	for (const c of calib.contributions) {
		if (c.feature === "relevance") continue;
		if (!byFeature.has(c.feature)) byFeature.set(c.feature, { states: new Set(), mult: 1, adjustable: c.contrarianAdjustable });
		const agg = byFeature.get(c.feature)!;
		agg.states.add(c.state);
		if (c.multiplier !== 1) agg.mult = c.multiplier;
	}
	for (const [feature, agg] of byFeature) {
		const saturated = calib.saturated.get(feature) ?? 0;
		rows.push(
			`| \`${feature}\` | ${[...agg.states].join("/")} | ${saturated >= 0 ? "+" : ""}${saturated.toFixed(2)}${agg.adjustable && agg.mult !== 1 ? ` ⁂×${agg.mult}` : ""} |`,
		);
	}
	for (const r of calib.corpusRows) {
		rows.push(`| \`${r.feature}\`（语料级） | ${r.state} | ${r.contribution >= 0 ? "+" : ""}${r.contribution.toFixed(2)} |`);
	}
	return rows.join("\n");
}

/** 契约校验入口（测试直接打这里）。 */
export function validateSection5(section5Text: string | null | undefined): true {
	const text = (section5Text ?? "").trim();
	if (!text || text === "（空）") {
		throw new ReportValidationError(5, "信息缺口段为空 —— 输出契约判定本次运行失败");
	}
	return true;
}
