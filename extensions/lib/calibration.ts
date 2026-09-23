/**
 * 结构化置信度引擎 —— 朴素贝叶斯形式的加权叠加（启发式，非校准）。
 *
 * 诚实标注：没有人工标注集就没有 ground truth，所以这一层不叫"校准"。
 * 保留两个不依赖标注集的价值：
 *   1. 可复现性：同样的证据 → 同样的数字；
 *   2. 敏感性分析：后验对哪个特征高度敏感 → 自动进入第 5 段「信息缺口」。
 *
 * logodds = prior + Σ_feature tanh(Σ_evidence lr / scale) × scale + Σ_corpus
 * posterior = sigmoid(logodds)，语义是 P(信息可靠)。
 */
import { loadLikelihoodRatios, type LikelihoodRatios } from "./config.ts";
import type {
	AppliedAdjustment,
	Assessment,
	CalibrationResult,
	ContributionRow,
	CorpusRow,
	EvidenceRecord,
	LrAdjustment,
	SensitivityEntry,
} from "./types.ts";

function sigmoid(x: number): number {
	return 1 / (1 + Math.exp(-x));
}

/**
 * 语料级「个例主导」（majorityPersonal）的最小可判定样本数。
 *
 * 为什么需要下限：个例主导是**结构性**判断，1~2 条样本谈「过半」没有统计意义；
 * 而且单条级 `sampleSize: personal → -0.7` 已在起作用，小样本上再叠 -0.6 会双重惩罚。
 * 取 3 与 `report.ts` 的 `total < 3 → 样本量不足` 信息缺口门槛对齐，语义自洽。
 * （配置 `likelihood-ratios.json` 未声明该门槛，此为代码侧约定，已在交付说明中标注。）
 */
const MIN_EVIDENCE_FOR_CORPUS = 3;

/** 单条证据对 log-odds 的贡献。相关性门：relevance=tangent 时全部贡献置零。 */
export function evidenceContributions(
	evidence: { id: string; features: Assessment["features"]; channelAuthority: string },
	lrTable: LikelihoodRatios,
	multipliers: Record<string, number> = {},
): ContributionRow[] {
	const feats = evidence.features;
	const tangent = feats.relevance === "tangent";
	const rows: ContributionRow[] = [];
	const push = (feature: string, state: string | null, fallback = "unknown") => {
		const spec = lrTable.features[feature];
		if (!spec) return;
		// unknown（显式无信息）不回退到有值的取值；只有 state 缺失时才用 fallback
		const lr = state == null ? (spec.lr[fallback] ?? 0) : (spec.lr[state] ?? 0);
		const multiplier = multipliers[feature] ?? 1;
		rows.push({
			evidenceId: evidence.id,
			feature,
			state: state ?? fallback,
			lr,
			multiplier,
			contribution: tangent ? 0 : lr * multiplier,
			excluded: tangent,
			contrarianAdjustable: spec.contrarianAdjustable,
		});
	};
	push("relevance", feats.relevance ?? "unknown");
	push("promoCode", feats.promoCode?.state === true ? "true" : feats.promoCode?.state === false ? "false" : "unknown");
	push("authorDensity", feats.authorDensity);
	push("staleness", feats.staleness);
	push("sampleSize", feats.sampleSize, "unlabelled");
	push("channelAuthority", evidence.channelAuthority);
	push("commentRebuttal", feats.commentRebuttal);
	return rows;
}

/** 语料级结构特征（证据结构缺陷是单条特征叠加看不到的）。 */
export function corpusContributions(evidenceMeta: Array<{ channelAuthority: string; platform: string }>, lrTable: LikelihoodRatios): CorpusRow[] {
	const rows: CorpusRow[] = [];
	const specs = lrTable.corpusFeatures ?? {};
	if (specs.noOfficialSource && evidenceMeta.length > 0 && evidenceMeta.every((e) => e.channelAuthority !== "official")) {
		rows.push({ feature: "noOfficialSource", contribution: specs.noOfficialSource.logodds, state: "hit" });
	}
	const platforms = new Set(evidenceMeta.map((e) => e.platform));
	if (specs.singlePlatformOnly && platforms.size === 1 && evidenceMeta.length > 1) {
		rows.push({ feature: "singlePlatformOnly", contribution: specs.singlePlatformOnly.logodds, state: "hit" });
	}
	return rows;
}

/**
 * 从已计算的特征贡献行派生「个例主导」语料级判定。
 *
 * 与 noOfficialSource / singlePlatformOnly 的区别：它读的是 `contributions`（含质检特征），
 * 而非 `evidenceMeta`（只有通道/平台）——所以单独成函数，在 computePosterior 内叠加。
 * 这样 `corpusContributions` 与 `computePosterior` 的对外签名都不必改动。
 */
function majorityPersonalRow(contributions: ContributionRow[], lrTable: LikelihoodRatios): CorpusRow | null {
	const spec = lrTable.corpusFeatures?.majorityPersonal;
	if (!spec) return null;
	// 相关性门：跑题证据不是证据，与单条级处理保持一致（见 evidenceContributions 的 tangent 分支）
	const onTopicIds = new Set(contributions.filter((c) => !c.excluded).map((c) => c.evidenceId));
	const onTopicTotal = onTopicIds.size;
	// 只数「非跑题且被判定为 personal」的证据；用 Set 保证每条证据最多计一次
	// （contributions 里每条证据有 7 行，sampleSize 恰好只占一行，用 Set 更稳）
	const personalIds = new Set(
		contributions
			.filter((c) => !c.excluded && c.feature === "sampleSize" && c.state === "personal")
			.map((c) => c.evidenceId),
	);
	const personalCount = personalIds.size;
	// 触发需同时满足：① 有可判定的相关证据且达下限；② personal 占比「过半」（严格大于 0.5）
	if (onTopicTotal >= MIN_EVIDENCE_FOR_CORPUS && personalCount / onTopicTotal > 0.5) {
		return { feature: "majorityPersonal", contribution: spec.logodds, state: "hit" };
	}
	return null;
}

export function computePosterior(
	assessments: Assessment[],
	evidenceMeta: Array<{ id: string; channelAuthority: string; platform: string }>,
	lrAdjustments: LrAdjustment[] = [],
	opts: { priorLogodds?: number; lrTable?: LikelihoodRatios; cap?: { min: number; max: number }; saturationScale?: number } = {},
): CalibrationResult {
	const lrTable = opts.lrTable ?? loadLikelihoodRatios();
	const cap = opts.cap ?? { min: 0.2, max: 5 };
	const scale = opts.saturationScale ?? lrTable.saturation?.scale ?? 1.5;

	// 反方调整：同特征多条主张取几何均值并夹在界内 —— 攻击要有界，防止单点乘爆
	const multipliers: Record<string, number> = {};
	const appliedAdjustments: AppliedAdjustment[] = [];
	const byFeature = new Map<string, number[]>();
	for (const adj of lrAdjustments) {
		if (!lrTable.features[adj.feature]?.contrarianAdjustable) {
			appliedAdjustments.push({ ...adj, applied: false, reason: "特征不可被反方调整" });
			continue;
		}
		if (!byFeature.has(adj.feature)) byFeature.set(adj.feature, []);
		byFeature.get(adj.feature)!.push(adj.multiplier);
	}
	for (const [feature, ms] of byFeature) {
		const geo = Math.exp(ms.reduce((s, m) => s + Math.log(Math.max(m, 1e-9)), 0) / ms.length);
		const bounded = Math.min(cap.max, Math.max(cap.min, geo));
		multipliers[feature] = bounded;
		appliedAdjustments.push({ feature, multipliers: ms, effective: bounded, applied: true });
	}

	const metaById = new Map(evidenceMeta.map((e) => [e.id, e]));
	const contributions: ContributionRow[] = [];
	for (const a of assessments) {
		const meta = metaById.get(a.id);
		contributions.push(
			...evidenceContributions(
				{ id: a.id, features: a.features, channelAuthority: meta?.channelAuthority ?? "ugc" },
				lrTable,
				multipliers,
			),
		);
	}

	// 按特征聚合 + tanh 饱和（相关性折扣），relevance 门本身不饱和
	const perFeature = new Map<string, number>();
	for (const row of contributions) {
		if (row.feature === "relevance") continue;
		perFeature.set(row.feature, (perFeature.get(row.feature) ?? 0) + row.contribution);
	}
	const saturated = new Map<string, number>();
	for (const [feature, total] of perFeature) {
		saturated.set(feature, total === 0 ? 0 : Math.tanh(total / scale) * scale);
	}

	const corpusRows = corpusContributions(evidenceMeta, lrTable);
	// 「个例主导」需读 contributions（含质检 sampleSize），故在此单独派生并叠加
	const mp = majorityPersonalRow(contributions, lrTable);
	if (mp) corpusRows.push(mp);
	let logodds = opts.priorLogodds ?? 0;
	logodds += [...saturated.values()].reduce((s, v) => s + v, 0);
	logodds += corpusRows.reduce((s, r) => s + r.contribution, 0);

	const excludedCount = Math.round(contributions.filter((c) => c.excluded).length / 7); // 每条证据 7 行特征

	return { posterior: sigmoid(logodds), logodds, contributions, appliedAdjustments, multipliers, corpusRows, saturated, excludedCount };
}

/** 敏感性分析：逐特征中和（其全部贡献置零）后重算后验。 */
export function sensitivityAnalysis(base: CalibrationResult, threshold: number, evidenceCount: number): SensitivityEntry[] {
	const out: SensitivityEntry[] = [];
	const entries: Array<{ feature: string; totalContribution: number }> = [
		...[...base.saturated.entries()].map(([feature, v]) => ({ feature, totalContribution: v })),
		...base.corpusRows.map((r) => ({ feature: r.feature, totalContribution: r.contribution })),
	];
	for (const { feature, totalContribution } of entries) {
		if (totalContribution === 0) continue;
		const delta = sigmoid(base.logodds) - sigmoid(base.logodds - totalContribution);
		const touchedByContrarian = base.multipliers[feature] !== undefined && base.multipliers[feature] !== 1;
		const entry: SensitivityEntry = {
			feature,
			totalContribution,
			deltaP: delta,
			sensitive: Math.abs(delta) > threshold,
			touchedByContrarian,
		};
		if (evidenceCount <= 2) entry.note = "证据量 ≤2，单特征波动即可主导后验";
		out.push(entry);
	}
	out.sort((a, b) => Math.abs(b.deltaP) - Math.abs(a.deltaP));
	return out;
}

export type { EvidenceRecord };
