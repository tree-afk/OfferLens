/**
 * 四个角色（主管/采集/质检/反方）的占位模型逻辑 —— 确定性启发式。
 *
 * ★ 这些函数替代的是"专家背后的模型"（placeholder），不是系统的其它部分：
 *   - 占位模式下由扩展层在进程内调用（/check 程序化路径、占位 Provider 路径）；
 *   - 真实模型接入后，同样的输入输出契约由 .pi/agents/ 下的角色定义
 *     （agents/*.md 作为 system prompt）+ 真实 LLM 在独立子进程中履行；
 *   - 桩的"智商"边界是刻意保留的：不做超出角色目标函数的事（见 agents/*.md）。
 */
import { classifyDensity, extractFeatures, parseQuestion } from "./features.ts";
import type {
	Assessment,
	CollectorResult,
	ContrarianResult,
	EvidenceFeatures,
	Hypothesis,
	LrAdjustment,
	ParsedQuestion,
	RawItem,
	SourcePlan,
	SourcePlanEntry,
	VerifierResult,
} from "./types.ts";
import { truncate } from "./util.ts";

/* ================================================================ */
/* 主管：假设规划 + 裁决 + 放弃摘要                                    */
/* ================================================================ */

export function planHypotheses(question: string, claim: string | null, url: string | null): SourcePlan {
	const parsed = parseQuestion(question);
	const subject = claim ?? question;
	const year = new Date().getFullYear() + 1;
	const primary = parsed.companies[0] ?? "校招";
	const hypotheses: Hypothesis[] = [
		{
			slug: "softad",
			statement: `「${truncate(subject, 50)}」相关内容是软广/营销号批量生产的引流内容`,
			queries: [...parsed.queries, "避雷 营销", `${primary} 内推 真假`].slice(0, 4),
		},
		{
			slug: "stale",
			statement: `相关内容真实但已过期（上一招聘季的信息被搬运到当前周期）`,
			queries: [...parsed.queries, `${primary} 20${String(year).slice(2)} 校招 公告`].slice(0, 4),
		},
		{
			slug: "insufficient",
			statement: `公开信息样本量不足，无法对该主张做出判定`,
			queries: [...parsed.queries, "转正率 数据 统计"].slice(0, 3),
		},
	];
	const hypothesisPlans: Record<string, SourcePlanEntry[]> = {};
	for (const h of hypotheses) {
		const plan: SourcePlanEntry[] = h.queries.map((q) => ({ tool: "fetch_bilibili", args: { keyword: q } }));
		// RSS 官方公告源（相关度过滤在采集内做）
		hypothesisPlans[h.slug] = plan;
	}
	return {
		parsed,
		hypotheses,
		hypothesisPlans,
		rationale:
			"默认三假设覆盖：软广（动机质疑）/ 过期（时效质疑）/ 样本不足（可判定性质疑）。" +
			"每个假设一个会话树分支独立验证；被放弃的分支以假设裁决摘要留存。",
		claim,
		url,
	};
}

/** 假设裁决规则（主管占位逻辑的一部分；真实模型时由 LLM 按角色语义裁决）。 */
export function verdict(
	slug: string,
	ctx: { evidenceCount: number; corpus?: VerifierResult["corpus"] },
): "supported" | "refuted" | "abandoned" | "insufficient-evidence" {
	if (ctx.evidenceCount === 0) return "insufficient-evidence";
	const corpus = ctx.corpus ?? {
		total: ctx.evidenceCount,
		onTopic: ctx.evidenceCount,
		tangent: 0,
		promoCount: 0,
		staleCount: 0,
		currentCount: 0,
		personalCount: 0,
		density: "unknown" as const,
	};
	const total = Math.max(corpus.total, ctx.evidenceCount);
	if (total < 2) return "insufficient-evidence";
	switch (slug) {
		case "softad": {
			const promoRatio = corpus.promoCount / total;
			if (promoRatio >= 0.4 || (corpus.promoCount >= 1 && corpus.density === "high")) return "supported";
			if (corpus.promoCount === 0 && corpus.density !== "high") return "refuted";
			return "abandoned";
		}
		case "stale": {
			if (corpus.staleCount > corpus.currentCount && corpus.staleCount > 0) return "supported";
			if (corpus.currentCount > 0 && corpus.currentCount >= corpus.staleCount) return "refuted";
			return "abandoned";
		}
		case "insufficient": {
			if (total < 3 || corpus.personalCount === total) return "supported";
			if (total >= 5) return "refuted";
			return "abandoned";
		}
		default:
			return "abandoned";
	}
}

/**
 * ★ HYPOTHESIS_ABANDON_PROMPT —— 假设裁决语义的分支摘要指令。
 * 真实模型路径：作为 Pi navigateTree({summarize:true}) 的 customInstructions，
 * 由 Pi 的分支摘要机制生成；占位路径：buildStubAbandonSummary 按同一 5 段
 * 结构确定性生成。两条路径产出同构的裁决摘要。
 */
export const HYPOTHESIS_ABANDON_PROMPT = `为被放弃的假设生成分支摘要，使用以下 5 段结构（假设裁决语义，不是通用会话摘要）：
1.【假设】这个假设是什么
2.【支持它的证据】有哪些证据支持（引用 evidence_id）
3.【推翻它的证据】有哪些证据反对（引用 evidence_id）
4.【放弃的具体理由】为什么放弃而不是继续投入
5.【对其它分支的启示】其它分支应该从这次探索中学到什么（避免重复探索相同的查询面；已被本分支采信/否定的特征权重可直接引用）`;

/** 占位路径：按 HYPOTHESIS_ABANDON_PROMPT 的 5 段结构确定性生成裁决摘要。 */
export function buildStubAbandonSummary(
	hypothesis: Hypothesis,
	assessments: Assessment[],
	evidenceCount: number,
	reason: string,
): string {
	const promo = assessments.filter((a) => a.features.promoCode.state === true).length;
	const stale = assessments.filter((a) => a.features.staleness === "stale").length;
	const supporting = assessments
		.filter((a) =>
			hypothesis.slug === "stale" ? a.features.staleness === "stale" : a.features.promoCode.state === true,
		)
		.map((a) => a.id)
		.slice(0, 5);
	const opposing = assessments
		.filter((a) =>
			hypothesis.slug === "stale" ? a.features.staleness === "current" : a.features.promoCode.state === false,
		)
		.map((a) => a.id)
		.slice(0, 5);
	return [
		`【假设】${hypothesis.statement}`,
		`【支持它的证据】${evidenceCount} 条中 ${promo} 条引流要素、${stale} 条过期${supporting.length ? `（如 ${supporting.join("、")}）` : ""}。`,
		`【推翻它的证据】${opposing.length ? `${opposing.length} 条反向证据（如 ${opposing.join("、")}）` : "未发现直接反向证据"}。`,
		`【放弃的具体理由】${reason}`,
		`【对其它分支的启示】避免重复探索 ${hypothesis.queries.join(" / ")} 查询面；本分支未推翻的特征权重可被其它分支直接引用。`,
	].join("\n");
}

/* ================================================================ */
/* 采集：目标函数「全」                                               */
/* ================================================================ */

const COMPANY_CAREER_PAGES: Record<string, string> = {
	字节: "https://jobs.bytedance.com/campus/position",
	字节跳动: "https://jobs.bytedance.com/campus/position",
	腾讯: "https://join.qq.com/",
	阿里: "https://talent.alibaba.com/campus/position-list",
	阿里巴巴: "https://talent.alibaba.com/campus/position-list",
	美团: "https://zhaopin.meituan.com/WEB/campus/list",
	bilibili: "https://jobs.bilibili.com/",
};

export interface SourceTools {
	fetch_bilibili(keyword: string): Promise<RawItem[]>;
	fetch_web(url: string): Promise<RawItem[]>;
	fetch_rss(feedUrl: string): Promise<RawItem[]>;
	fetch_youtube(url: string): Promise<RawItem[]>;
}

/**
 * 采集执行计划（占位模式下由本函数驱动真实内容源工具；真实模型下由
 * 子 Agent 在自己的进程里调用同样的工具）。
 */
export async function runCollector(
	input: { hypothesis: string; queries: string[]; urls?: string[] },
	tools: SourceTools,
	config: { maxItemsPerSource: number; rssFeeds: string[] },
	onDegraded?: (d: { channel: string; query: string; reason: string }) => void,
): Promise<CollectorResult> {
	const items: (RawItem & { viaHypothesis?: string })[] = [];
	const degraded: CollectorResult["degraded"] = [];
	const cap = config.maxItemsPerSource;
	const companyKeys = Object.keys(COMPANY_CAREER_PAGES).filter((c) => input.queries.some((q) => q.includes(c)));

	// 用户直接给定的链接优先（--url 模式）
	for (const u of input.urls ?? []) {
		try {
			const isYt = /youtube\.com|youtu\.be/.test(u);
			const pages = isYt ? await tools.fetch_youtube(u) : await tools.fetch_web(u);
			items.push(...pages.map((p) => ({ ...p, viaHypothesis: input.hypothesis, fromUserUrl: true })));
		} catch (e) {
			degraded.push({
				channel: /youtube\.com|youtu\.be/.test(u) ? "youtube" : "web",
				query: u,
				reason: truncate((e as Error).message, 160),
			});
			onDegraded?.(degraded[degraded.length - 1]);
		}
	}

	// B 站（UGC 主力源）
	for (const q of input.queries) {
		try {
			const biliItems = await tools.fetch_bilibili(q);
			items.push(...biliItems.slice(0, cap).map((it) => ({ ...it, viaHypothesis: input.hypothesis })));
		} catch (e) {
			degraded.push({ channel: "bilibili", query: q, reason: truncate((e as Error).message, 160) });
			onDegraded?.(degraded[degraded.length - 1]);
		}
	}

	// 公司官方招聘页（web 通道没有站内搜索，只在能识别出公司时抓）
	for (const company of companyKeys.slice(0, 1)) {
		try {
			const pages = await tools.fetch_web(COMPANY_CAREER_PAGES[company]);
			items.push(...pages.map((p) => ({ ...p, title: `${company} 官方校招页`, viaHypothesis: input.hypothesis })));
		} catch (e) {
			degraded.push({ channel: "web", query: `${company} 官方招聘页`, reason: truncate((e as Error).message, 160) });
			onDegraded?.(degraded[degraded.length - 1]);
		}
	}

	// RSS 官方源：相关度过滤
	const relevance = [...input.queries, "校招", "实习", "招聘", "campus", "intern"];
	for (const feed of config.rssFeeds) {
		try {
			const feedItems = await tools.fetch_rss(feed);
			const relevant = feedItems.filter((it) =>
				relevance.some((kw) => `${it.title}${it.rawSnippet}`.toLowerCase().includes(kw.toLowerCase())),
			);
			items.push(...relevant.slice(0, cap).map((it) => ({ ...it, viaHypothesis: input.hypothesis })));
		} catch (e) {
			degraded.push({ channel: "rss", query: feed, reason: truncate((e as Error).message, 160) });
			onDegraded?.(degraded[degraded.length - 1]);
		}
	}

	return {
		items,
		degraded,
		plan: {
			queries: input.queries,
			urls: input.urls ?? [],
			bilibili: input.queries.length,
			web: companyKeys.map((c) => COMPANY_CAREER_PAGES[c]),
			rss: config.rssFeeds,
		},
	};
}

/* ================================================================ */
/* 质检：目标函数「准」                                               */
/* ================================================================ */

/** 质检输入单元：evidence_ids 解析出的原文片段 + 可选元数据。 */
export interface VerifierInputItem {
	id: string;
	title?: string | null;
	rawSnippet?: string | null;
	publishedAt?: string | null;
	author?: string | null;
	comments?: string[] | null;
	platform?: string;
	channelAuthority?: string;
}

const STOP_BIGRAM = /[的了吗呢吧是了了个这那]/;
const DOMAIN_TERMS = [
	"实习",
	"校招",
	"秋招",
	"春招",
	"转正",
	"offer",
	"Offer",
	"面经",
	"笔试",
	"招聘",
	"内推",
	"简历",
	"留用",
	"OC",
	"网申",
];

function claimTerms(claim: string): string[] {
	const terms = new Set<string>();
	for (const seg of String(claim ?? "").match(/[\u4e00-\u9fa5]{2,}|[a-zA-Z0-9]{2,}/g) ?? []) {
		if (/[a-zA-Z0-9]/.test(seg)) {
			terms.add(seg.toLowerCase());
			continue;
		}
		for (let i = 0; i + 2 <= seg.length; i++) {
			const bi = seg.slice(i, i + 2);
			if (!STOP_BIGRAM.test(bi)) terms.add(bi);
		}
	}
	return [...terms];
}

/** 相关性门（确定性）：中文 2-gram 重叠 + 领域词双通道。跑题证据不参与后验。 */
export function assessRelevance(
	raw: { title?: string | null; rawSnippet?: string | null },
	claim: string | undefined | null,
): EvidenceFeatures["relevance"] {
	const text = `${raw.title ?? ""}\n${raw.rawSnippet ?? ""}`;
	if (!claim) return "unknown";
	const lower = text.toLowerCase();
	const c = String(claim);
	const termHit = claimTerms(claim).some((t) => lower.includes(t));
	const claimDomain = DOMAIN_TERMS.some((t) => c.includes(t));
	const evDomain = DOMAIN_TERMS.some((t) => text.includes(t));
	return termHit || (claimDomain && evDomain) ? "on-topic" : "tangent";
}

/** 质检执行：逐条特征判定（可数、可复现），不做整体结论。
 *  relevanceOverride：混合模式下由质检 LLM 提供的相关性判定（id → on-topic/tangent/unknown）。
 *  缺省时走确定性 assessRelevance。特征其余部分恒为确定性抽取，保证"同样证据→同样数字"。 */
export function runVerifier(input: {
	evidence: VerifierInputItem[];
	claim?: string;
	focus?: string;
	relevanceOverride?: Record<string, "on-topic" | "tangent" | "unknown">;
}): VerifierResult {
	const authorCounts = new Map<string, number>();
	for (const r of input.evidence) {
		if (r.author) authorCounts.set(r.author, (authorCounts.get(r.author) ?? 0) + 1);
	}
	const now = Date.now();
	const assessments: Assessment[] = input.evidence.map((r) => {
		const features = extractFeatures(
			{
				title: r.title,
				rawSnippet: r.rawSnippet,
				publishedAt: r.publishedAt,
				comments: r.comments ?? null,
				authorFeatures: { recentSameTopicCount: r.author ? (authorCounts.get(r.author) ?? null) : null },
			},
			now,
		);
		features.relevance = input.relevanceOverride?.[r.id] ?? assessRelevance(r, input.claim);
		const notes: string[] = [];
		if (features.relevance === "tangent") notes.push("与主张无直接关联（排除出后验）");
		if (features.promoCode.state === true) notes.push(`含引流要素: ${features.excerpts.promoHits.join(" / ")}`);
		if (features.sampleSize === "personal")
			notes.push(`个例叙述（${features.excerpts.sampleSizeHint ?? "我认识的人"}式）`);
		if (features.staleness === "stale" && features.daysAgo != null)
			notes.push(`发布于 ${features.daysAgo} 天前，超出一个招聘季`);
		if (features.staleness === "unknown") notes.push("无可靠发布时间");
		if (features.authorDensity === "high") notes.push("语料内同作者多条同主题内容（代理指标）");
		if (features.commentRebuttal === "hasRebuttal") notes.push("评论区存在反驳声音");
		if (features.commentRebuttal === "unknown") notes.push("评论区不可达");
		if (input.focus) notes.push(`(关注点: ${input.focus})`);
		return { id: r.id, features, notes };
	});

	const onTopic = assessments.filter((a) => a.features.relevance !== "tangent");
	const count = (fn: (a: Assessment) => boolean) => onTopic.filter(fn).length;
	return {
		assessments,
		corpus: {
			total: input.evidence.length,
			onTopic: onTopic.length,
			tangent: input.evidence.length - onTopic.length,
			promoCount: count((a) => a.features.promoCode.state === true),
			staleCount: count((a) => a.features.staleness === "stale"),
			currentCount: count((a) => a.features.staleness === "current"),
			personalCount: count((a) => a.features.sampleSize === "personal"),
			density: classifyDensity(Math.max(0, ...authorCounts.values())),
		},
		summary:
			`共 ${input.evidence.length} 条证据：相关 ${onTopic.length} 条（跑题 ${input.evidence.length - onTopic.length} 条已排除）、` +
			`引流要素 ${count((a) => a.features.promoCode.state === true)} 条、` +
			`过期 ${count((a) => a.features.staleness === "stale")} 条、` +
			`时效正常 ${count((a) => a.features.staleness === "current")} 条、` +
			`个例叙述 ${count((a) => a.features.sampleSize === "personal")} 条。` +
			`特征判定见 assessments，整体结论留给主管与置信度引擎。`,
	};
}

/* ================================================================ */
/* 反方：目标函数「反」—— 攻击似然比的取值，不是结论本身                */
/* ================================================================ */

type ContrarianInput = {
	claim: string;
	evidence: VerifierInputItem[];
};

export function runContrarian(input: ContrarianInput): ContrarianResult {
	const { claim, evidence: raws } = input;
	const arguments_: Array<{
		target: string;
		feature: string;
		multiplier: number;
		argument: string;
		evidenceIds: string[];
	}> = [];

	const features = raws.map((r) =>
		extractFeatures({ ...r, authorFeatures: { recentSameTopicCount: null } }, Date.now()),
	);

	const rateLike = /率|比例|多少|几个/.test(claim);
	const personalAll =
		raws.length > 0 && features.every((f) => f.sampleSize === "personal" || f.sampleSize === "unknown");

	// 攻击 1：比率型主张 × 个例证据
	if (rateLike && personalAll) {
		arguments_.push({
			target: "样本量的生态效度",
			feature: "sampleSize",
			multiplier: 1.5,
			argument:
				`主张 "${truncate(claim, 60)}" 是群体统计性陈述，而全部 ${raws.length} 条证据都是个例叙述。` +
				`「样本量 personal」的 -0.7 权重方向正确但幅度不足以刻画这个错配：个例与比率之间隔着选择效应` +
				`（愿意分享的人本身就是幸存者），建议将该特征权重上调 1.5 倍。`,
			evidenceIds: raws.map((r) => r.id),
		});
	}

	// 攻击 2：过期证据撞当期主张
	const staleIdx = features.map((f, i) => (f.staleness === "stale" ? i : -1)).filter((i) => i >= 0);
	const currentYear = new Date().getFullYear() + 1;
	if (staleIdx.length > 0 && new RegExp(String(currentYear)).test(claim)) {
		arguments_.push({
			target: "时效与届别的错配",
			feature: "staleness",
			multiplier: 1.5,
			argument:
				`${staleIdx.length} 条证据发布于 90 天以前，而主张问的是 ${currentYear} 届。校招政策逐年变动` +
				`（扩招/缩招/转正政策都可能一年一变），过期证据不仅无益，还可能反向误导，建议上调 1.5 倍。`,
			evidenceIds: staleIdx.map((i) => raws[i].id),
		});
	}

	// 攻击 3：引流要素
	const promoIdx = features.map((f, i) => (f.promoCode.state === true ? i : -1)).filter((i) => i >= 0);
	if (promoIdx.length > 0) {
		arguments_.push({
			target: "引流要素与内容动机",
			feature: "promoCode",
			multiplier: 1.3,
			argument:
				`${promoIdx.length} 条证据含优惠码/内推码/引流联系方式。固然官方内推活动也会有码` +
				`（这是"发文密度"类特征可被攻击的镜像情形），但在无官方背书的情况下，码的存在让内容` +
				`动机存疑，建议上调 1.3 倍而非全额 -1.2 直扣。`,
			evidenceIds: promoIdx.map((i) => raws[i].id),
		});
	}

	// 攻击 4：UGC 无官方口径（幸存者偏差）
	const allUgc =
		raws.length > 0 && raws.every((r) => (r.platform ?? "") === "bilibili" || (r.platform ?? "") === "youtube");
	const noOfficial = !raws.some((r) => r.channelAuthority === "official");
	if (allUgc && noOfficial) {
		arguments_.push({
			target: "证据结构的单边性",
			feature: "channelAuthority",
			multiplier: 0.5,
			argument:
				`全部证据来自 UGC 平台，没有任何官方口径。官方通道 (+1.0) 的加分从未出现，这本身是` +
				`对可靠性的隐性折扣；同时 UGC 高播放且评论区无反驳更可能是算法同温层（幸存者偏差）` +
				`而非交叉验证。建议将「official」特征的 +1.0 权重乘 0.5，防止未来混入单一官方源时过度抬升。`,
			evidenceIds: raws.map((r) => r.id),
		});
	}

	// 攻击 5（镜像情形）：高密度 ≠ 软广（垂类博主反例）
	const highDensityIdx = features.map((f, i) => (f.authorDensity === "high" ? i : -1)).filter((i) => i >= 0);
	if (highDensityIdx.length > 0) {
		arguments_.push({
			target: "发文密度代理指标的区分度",
			feature: "authorDensity",
			multiplier: 0.5,
			argument:
				`in-corpus 语料内同作者计数达到 high 的证据有 ${highDensityIdx.length} 条。但垂类求职博主` +
				`本来就会高频发布同主题内容——该代理指标在垂类场景下没有区分度，-0.9 的权重` +
				`在无其他软广特征佐证时属于过度惩罚，建议乘 0.5 并在敏感性标注中明示该结论依赖此争议特征。`,
			evidenceIds: highDensityIdx.map((i) => raws[i].id),
		});
	}

	const lrAdjustments: LrAdjustment[] = arguments_.map((a) => ({
		feature: a.feature,
		multiplier: a.multiplier,
		argument: a.argument,
	}));
	const couldNotRefute = arguments_.length === 0;
	const rebuttal = [
		`> 以下为反方 Agent 原始输出（未被主管改写）。攻击对象是似然比的取值，不是结论本身。`,
		``,
		`**待反驳主张**：${claim}`,
		``,
		couldNotRefute
			? `**未能构造出反驳**。现有证据（${raws.length} 条）在时效、样本结构、引流要素、来源结构上` +
				`均未发现可攻击的折算：官方口径存在、时效正常、无引流要素。这不构成对主张的支持证明——` +
				`反方从不出具"可信"证明，最多出具"我攻不动"。`
			: arguments_
					.map((a, i) => `**反驳 ${i + 1}（${a.target}，特征 \`${a.feature}\` 权重 ×${a.multiplier}）**\n${a.argument}`)
					.join("\n\n"),
	].join("\n");

	return { rebuttal, lrAdjustments, couldNotRefute, claim };
}

export type { ParsedQuestion };
