/**
 * 结构化置信度引擎测试（迁移自 test/calibration.test.js → vitest + extensions/lib）。
 *
 * 覆盖：可复现性、相关性门、tanh 饱和、语料级特征、敏感性标注、
 *       反方调整有界性、unknown 不回退。
 */
import { describe, expect, test } from "vitest";
import { loadLikelihoodRatios } from "../extensions/lib/config.ts";
import { computePosterior, evidenceContributions, sensitivityAnalysis } from "../extensions/lib/calibration.ts";
import type { Assessment, EvidenceFeatures } from "../extensions/lib/types.ts";

const LR = loadLikelihoodRatios();

/** 构造一条完整特征（质检产出的形状）。 */
function mkFeatures(over: Partial<EvidenceFeatures> = {}): EvidenceFeatures {
	return {
		relevance: "on-topic",
		promoCode: { state: false, hits: [] },
		sampleSize: "unknown",
		staleness: "current",
		authorDensity: "low",
		densityProxy: "in-corpus",
		commentRebuttal: "unknown",
		daysAgo: 1,
		excerpts: { promoHits: [], sampleSizeHint: null },
		...over,
	};
}

function mkAssessment(id: string, over: Partial<EvidenceFeatures> = {}): Assessment {
	return { id, features: mkFeatures(over), notes: [] };
}

const meta1 = [{ id: "ev_1", channelAuthority: "ugc" as const, platform: "bilibili" }];

describe("calibration", () => {
	test("同样证据 → 同样后验（可复现性）", () => {
		const r1 = computePosterior([mkAssessment("ev_1")], meta1, [], { lrTable: LR });
		const r2 = computePosterior([mkAssessment("ev_1")], meta1, [], { lrTable: LR });
		expect(r1.posterior).toBe(r2.posterior);
		expect(r1.logodds).toBe(r2.logodds);
	});

	test("跑题证据被相关性门排除，不贡献 log-odds", () => {
		// 关掉语料级特征，隔离验证「单条证据相关性门」本身
		const noCorpus = { ...LR, corpusFeatures: {} };
		const onTopic = computePosterior([mkAssessment("ev_1")], meta1, [], { lrTable: noCorpus });
		const tangent = computePosterior([mkAssessment("ev_1", { relevance: "tangent" })], meta1, [], { lrTable: noCorpus });
		expect(tangent.logodds).toBe(0);
		expect(onTopic.logodds).not.toBe(0);
		expect(tangent.excludedCount).toBe(1);
	});

	test("同质证据按特征 tanh 饱和，不随条数线性爆炸", () => {
		const n = 30;
		const assessments = Array.from({ length: n }, (_, i) => mkAssessment(`ev_${i}`));
		const meta = Array.from({ length: n }, (_, i) => ({ id: `ev_${i}`, channelAuthority: "ugc" as const, platform: "bilibili" }));
		const r = computePosterior(assessments, meta, [], { lrTable: LR });
		// promoCode=false 每条 0.05：未饱和应为 30×0.05=1.5，饱和后必须 < 1.5
		expect(r.saturated.get("promoCode")!).toBeLessThan(1.5);
		// 总 log-odds 有界（不可能到 30 条线性叠加的量级）
		expect(Math.abs(r.logodds)).toBeLessThan(10);
	});

	test("无官方口径 / 单平台语料级缺陷被计入", () => {
		const r = computePosterior(
			[mkAssessment("e1", { staleness: "unknown", authorDensity: "unknown", sampleSize: "unknown" })],
			[{ id: "e1", channelAuthority: "ugc", platform: "bilibili" }],
			[],
			{ lrTable: LR },
		);
		const feats = r.corpusRows.map((x) => x.feature);
		expect(feats).toContain("noOfficialSource");
		expect(feats).not.toContain("singlePlatformOnly"); // 只有 1 条不判单平台
	});

	test("单特征主导 → 敏感性标注（信息缺口素材）", () => {
		// 官方口径 +1.0 是唯一强贡献
		const r = computePosterior(
			[mkAssessment("e1", { staleness: "unknown", authorDensity: "unknown", sampleSize: "unknown" })],
			[{ id: "e1", channelAuthority: "official", platform: "rss" }],
			[],
			{ lrTable: LR },
		);
		const sens = sensitivityAnalysis(r, 0.2, 1);
		expect(sens.length).toBeGreaterThan(0);
		expect(Math.abs(sens[0].deltaP)).toBeGreaterThan(0);
		expect(sens.some((s) => s.sensitive)).toBe(true);
	});

	test("证据量 ≤2 时敏感性条目带解释性 note", () => {
		const r = computePosterior(
			[mkAssessment("e1", { staleness: "unknown", authorDensity: "unknown", sampleSize: "unknown" })],
			[{ id: "e1", channelAuthority: "official", platform: "rss" }],
			[],
			{ lrTable: LR },
		);
		const sens = sensitivityAnalysis(r, 0.2, 1);
		expect(sens.every((s) => s.note && s.note.includes("≤2"))).toBe(true);
	});

	test("反方调整有界（0.2~5.0）且只作用于可调整特征", () => {
		const r = computePosterior(
			[mkAssessment("e1", { sampleSize: "personal" })],
			meta1,
			[
				{ feature: "sampleSize", multiplier: 99, argument: "个例也可能代表群体" },
				{ feature: "staleness", multiplier: 2, argument: "过期不代表无效" },
			],
			{ lrTable: LR, cap: { min: 0.2, max: 5 } },
		);
		expect(r.multipliers.sampleSize).toBe(5); // 99 → 夹到上限
		expect(r.multipliers.staleness).toBeUndefined(); // staleness 不可调整
		const rejected = r.appliedAdjustments.find((a) => a.feature === "staleness");
		expect(rejected?.applied).toBe(false);
	});

	test("反方多条主张取几何均值后再夹界", () => {
		const r = computePosterior(
			[mkAssessment("e1", { sampleSize: "personal" })],
			meta1,
			[
				{ feature: "sampleSize", multiplier: 4, argument: "a" },
				{ feature: "sampleSize", multiplier: 1, argument: "b" },
			],
			{ lrTable: LR, cap: { min: 0.2, max: 5 } },
		);
		// 几何均值 = sqrt(4) = 2
		expect(r.multipliers.sampleSize).toBeCloseTo(2, 5);
	});

	test("unknown 状态不回退到有值取值（无信息 = 0 贡献）", () => {
		const rows = evidenceContributions({ id: "e1", features: mkFeatures({ sampleSize: "unknown" }), channelAuthority: "ugc" }, LR, {});
		const sampleRow = rows.find((r) => r.feature === "sampleSize")!;
		expect(sampleRow.contribution).toBe(0);
	});

	test("似然比表结构自洽：可缺省特征声明 unknown、通道域闭合、取值均为有限数", () => {
		// 语义上可能「无法判定」的特征必须显式声明 unknown（贡献 0），
		// 否则 push() 会静默回退到别的取值，把「无信息」当成「有信息」。
		const nullable = ["promoCode", "authorDensity", "staleness", "sampleSize", "relevance", "commentRebuttal"];
		for (const name of nullable) {
			expect(LR.features[name]?.lr, `特征 ${name} 缺少 unknown 取值`).toHaveProperty("unknown");
		}
		// channelAuthority 是闭合枚举（official/ugc/web，生产者恒赋值 + `?? "ugc"` 兜底），
		// 不存在 unknown 路径，因此不要求 unknown —— 但三种取值必须齐全。
		expect(Object.keys(LR.features.channelAuthority!.lr).sort()).toEqual(["official", "ugc", "web"]);
		// 全表完整性：每条特征声明可调整性与方向，且每个取值都是有限数字。
		for (const [name, spec] of Object.entries(LR.features)) {
			expect(typeof spec.contrarianAdjustable, `特征 ${name} 缺少 contrarianAdjustable`).toBe("boolean");
			expect(typeof spec.direction, `特征 ${name} 缺少 direction`).toBe("string");
			for (const [state, lr] of Object.entries(spec.lr)) {
				expect(Number.isFinite(lr), `特征 ${name}.${state} 应为有限数字`).toBe(true);
			}
		}
	});

	/* ── 语料级「个例主导」majorityPersonal ─────────────────────────────
	 * 每条证据在 contributions 里有 7 行；这里统一用同平台 ugc meta，
	 * 以便把 singlePlatformOnly 之外的差异隔离到 majorityPersonal 上。
	 */
	function metaN(n: number) {
		return Array.from({ length: n }, (_, i) => ({ id: `e${i}`, channelAuthority: "ugc" as const, platform: "bilibili" }));
	}
	const corpusFeats = (r: ReturnType<typeof computePosterior>) => r.corpusRows.map((x) => x.feature);

	test("个例主导：过半相关证据为个例叙述 → 触发语料级 majorityPersonal", () => {
		const assessments = [
			mkAssessment("e0", { sampleSize: "personal" }),
			mkAssessment("e1", { sampleSize: "personal" }),
			mkAssessment("e2", { sampleSize: "personal" }),
			mkAssessment("e3", { sampleSize: "unlabelled" }),
		];
		const r = computePosterior(assessments, metaN(4), [], { lrTable: LR });
		expect(corpusFeats(r)).toContain("majorityPersonal"); // 3/4 = 75% > 50%
	});

	test("个例未过半（恰好 50%）→ 不触发（边界：严格大于 0.5）", () => {
		const assessments = [
			mkAssessment("e0", { sampleSize: "personal" }),
			mkAssessment("e1", { sampleSize: "personal" }),
			mkAssessment("e2", { sampleSize: "unlabelled" }),
			mkAssessment("e3", { sampleSize: "unlabelled" }),
		];
		const r = computePosterior(assessments, metaN(4), [], { lrTable: LR });
		expect(corpusFeats(r)).not.toContain("majorityPersonal"); // 2/4 = 50%，非「过半」
	});

	test("小样本不判个例主导：≤2 条即使全为个例也不触发", () => {
		const one = computePosterior([mkAssessment("e0", { sampleSize: "personal" })], metaN(1), [], { lrTable: LR });
		const two = computePosterior(
			[mkAssessment("e0", { sampleSize: "personal" }), mkAssessment("e1", { sampleSize: "personal" })],
			metaN(2),
			[],
			{ lrTable: LR },
		);
		expect(corpusFeats(one)).not.toContain("majorityPersonal"); // 1/1 = 100%，但样本 <3
		expect(corpusFeats(two)).not.toContain("majorityPersonal"); // 2/2 = 100%，但样本 <3
	});

	test("相关性门：跑题的个例证据不计入语料级个例判定", () => {
		const assessments = [
			mkAssessment("e0", { sampleSize: "personal", relevance: "tangent" }),
			mkAssessment("e1", { sampleSize: "personal", relevance: "tangent" }),
			mkAssessment("e2", { sampleSize: "personal", relevance: "tangent" }),
			mkAssessment("e3", { sampleSize: "unlabelled" }),
			mkAssessment("e4", { sampleSize: "unlabelled" }),
			mkAssessment("e5", { sampleSize: "unlabelled" }),
		];
		const r = computePosterior(assessments, metaN(6), [], { lrTable: LR });
		// 3 条 personal 全部跑题 → 被排除出分子与分母（相关证据 3 条、personal 0 条）→ 不触发
		expect(corpusFeats(r)).not.toContain("majorityPersonal");
	});

	test("majorityPersonal 的 -0.6 真实计入 log-odds（同一输入，仅开关该语料级特征）", () => {
		const assessments = Array.from({ length: 4 }, (_, i) => mkAssessment(`e${i}`, { sampleSize: "personal" }));
		const on = computePosterior(assessments, metaN(4), [], { lrTable: LR });
		// 移走 majorityPersonal，其余配置与输入完全一致 → 唯一变量就是这一行
		const { majorityPersonal: _omitted, ...restCorpus } = LR.corpusFeatures;
		const off = computePosterior(assessments, metaN(4), [], { lrTable: { ...LR, corpusFeatures: restCorpus } });

		expect(on.corpusRows.find((x) => x.feature === "majorityPersonal")?.contribution).toBeCloseTo(-0.6, 6);
		expect(corpusFeats(off)).not.toContain("majorityPersonal");
		// 单条特征与饱和完全一致，故 log-odds 差值应恰为语料级的 -0.6
		expect(on.logodds - off.logodds).toBeCloseTo(-0.6, 6);
	});
});
