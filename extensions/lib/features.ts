/** 可数特征抽取 —— 置信度引擎的原料（确定性规则，非模型）。 */
import { truncate } from "./util.ts";
import type { EvidenceFeatures, ParsedQuestion, SampleSize, Staleness } from "./types.ts";

const PROMO_PATTERNS: RegExp[] = [
	/内推码/i,
	/优惠码/i,
	/邀请码/i,
	/折扣码/i,
	/(?:口令|暗号)[：:]\s*\S+/,
	/(?:加(?:我)?|\+v|VX|威信|微信)[：:]?\s*[a-zA-Z0-9_-]{5,}/,
	/投递(?:时|可)?(?:备注|填写)(?:我的)?(?:内推)?码/i,
	/balcony|refer(?:ral)?[-_ ]?code/i,
];

const PERSONAL_SAMPLE_PATTERNS: RegExp[] = [
	/我(?:认识|身边|室友|舍友|同学|朋友|学长|学姐|表哥|表姐)/,
	/我(?:自己|当年|去年|上个月)/,
	/(?:身边|周围)(?:的同学|朋友)/,
];

const GROUP_SAMPLE_PATTERNS: RegExp[] = [
	/(?:问卷|统计|调研|官方(?:数据|公告)|报告中?称)/,
	/(?:平均|整体|约?[\d.]+%的)/,
];

const REBUTTAL_COMMENT_PATTERNS: RegExp[] = [/(假|骗|营销|广告|软广|别信|引流|割韭菜|标题党|辟谣|不实)/];

export function detectPromoCode(text: string): { state: boolean | null; hits: string[] } {
	const hits: string[] = [];
	for (const re of PROMO_PATTERNS) {
		const m = text.match(re);
		if (m) hits.push(truncate(m[0], 30));
	}
	const unique = [...new Set(hits)].slice(0, 3);
	if (unique.length > 0) return { state: true, hits: unique };
	if (text.trim().length > 0) return { state: false, hits: [] };
	return { state: null, hits: [] };
}

export function classifySampleSize(text: string): SampleSize {
	if (PERSONAL_SAMPLE_PATTERNS.some((re) => re.test(text))) return "personal";
	if (GROUP_SAMPLE_PATTERNS.some((re) => re.test(text))) return "unlabelled";
	const m = text.match(/(\d+)\s*(?:个|位|名|人)/);
	if (m) {
		const n = Number(m[1]);
		if (Number.isFinite(n)) return n <= 10 ? "small" : "unlabelled";
	}
	return "unknown";
}

export function classifyStaleness(publishedAt: string | null, now = Date.now()): Staleness {
	if (!publishedAt) return "unknown";
	const t = Date.parse(publishedAt);
	if (!Number.isFinite(t)) return "unknown";
	const days = Math.floor((now - t) / 86400000);
	if (days < 0) return "current";
	return days < 90 ? "current" : "stale";
}

export function classifyDensity(countInCorpus: number | null | undefined): "low" | "mid" | "high" | "unknown" {
	// 注意：不可用 Number(null)→0。null/undefined 语义是「无法计算」→ unknown，
	// 只有真正的有限数字才进分档（NaN/Infinity 同样归 unknown）。
	if (typeof countInCorpus !== "number" || !Number.isFinite(countInCorpus)) return "unknown";
	if (countInCorpus >= 5) return "high";
	if (countInCorpus >= 2) return "mid";
	return "low";
}

export function detectCommentRebuttal(comments: string[] | null): "hasRebuttal" | "none" | "unknown" {
	if (!Array.isArray(comments) || comments.length === 0) return "unknown";
	const has = comments.some((c) => REBUTTAL_COMMENT_PATTERNS.some((re) => re.test(String(c))));
	return has ? "hasRebuttal" : "none";
}

/** 从一条原始证据抽取全部特征；无法判定时输出 unknown，不猜。 */
export function extractFeatures(
	evidence: {
		title?: string | null;
		rawSnippet?: string | null;
		publishedAt?: string | null;
		comments?: string[] | null;
		authorFeatures?: { recentSameTopicCount?: number | null };
	},
	now = Date.now(),
): EvidenceFeatures {
	const text = `${evidence.title ?? ""}\n${evidence.rawSnippet ?? ""}`;
	const promo = detectPromoCode(text);
	const parsed = evidence.publishedAt ? Date.parse(evidence.publishedAt) : NaN;
	const daysAgo = Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / 86400000)) : null;
	return {
		relevance: "unknown", // 由质检在知道主张后回填
		promoCode: promo,
		sampleSize: classifySampleSize(text),
		staleness: classifyStaleness(evidence.publishedAt ?? null, now),
		authorDensity: classifyDensity(evidence.authorFeatures?.recentSameTopicCount),
		densityProxy: "in-corpus",
		commentRebuttal: detectCommentRebuttal(evidence.comments ?? null),
		daysAgo,
		excerpts: {
			promoHits: promo.hits,
			sampleSizeHint: (text.match(PERSONAL_SAMPLE_PATTERNS[0]) || [])[0] ?? null,
		},
	};
}

/* ---------------- 问题解析（主管规划输入） ---------------- */

const COMPANY_DICT = [
	"字节跳动", "字节", "腾讯", "阿里", "阿里巴巴", "美团", "拼多多", "百度", "华为", "京东",
	"小米", "网易", "b站", "哔哩哔哩", "bilibili", "快手", "滴滴", "网易雷火", "米哈游",
	"莉莉丝", "深信服", "海康威视", "大疆", "微软", "google", "谷歌", "apple", "苹果", "亚马逊",
];

export function parseQuestion(input: string): ParsedQuestion {
	const text = String(input ?? "");
	const lower = text.toLowerCase();
	const companies = COMPANY_DICT.filter((c) => lower.includes(c.toLowerCase()));
	const normalized = [...new Set(companies.map((c) => (c === "哔哩哔哩" || c === "b站" ? "bilibili" : c)))];
	const kind: ParsedQuestion["kind"] =
		/转正|留用|offer|背调|毁约|拖欠|避雷|真假|靠谱|真实|内推|坑/.test(text) ? "claim-like" : "info";
	const rateLike = /率|比例|多少|几个/.test(text);
	return { raw: text, companies: normalized, kind, rateLike, queries: buildQueries(text, normalized) };
}

function buildQueries(text: string, companies: string[]): string[] {
	const cleaned = text.replace(/[？?!。,，、的了吗呢吧]/g, " ").trim();
	const queries = new Set<string>();
	if (cleaned) queries.add(cleaned.slice(0, 30));
	for (const c of companies) {
		if (!cleaned.includes(c)) queries.add(c);
		queries.add(`${c} 实习`);
		queries.add(`${c} 校招`);
	}
	if (!companies.length) queries.add("校招 实习 经验");
	return [...queries].slice(0, 4);
}
