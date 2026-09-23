/**
 * 报告契约 + 特征抽取测试（迁移自 test/report-features.test.js → vitest）。
 *
 * 覆盖：第 5 段强制校验、信息缺口组装（"不做"也要可见）、确定性特征抽取、问题解析。
 */
import { describe, expect, test } from "vitest";
import { computePosterior } from "../extensions/lib/calibration.ts";
import { loadConfig, loadLikelihoodRatios } from "../extensions/lib/config.ts";
import {
	classifyDensity,
	classifySampleSize,
	classifyStaleness,
	detectCommentRebuttal,
	detectPromoCode,
	parseQuestion,
} from "../extensions/lib/features.ts";
import {
	assembleGaps,
	ReportValidationError,
	stripUnsourcedLinks,
	validateSection5,
} from "../extensions/lib/report.ts";
import type { CalibrationResult } from "../extensions/lib/types.ts";

const LR = loadLikelihoodRatios();
const config = loadConfig();

/** 空语料的置信度结果（用于隔离测试信息缺口组装本身）。 */
function emptyCalib(): CalibrationResult {
	return computePosterior([], [], [], { lrTable: LR });
}

describe("report 契约", () => {
	test("第 5 段缺失 → ReportValidationError（契约级必填）", () => {
		expect(() => validateSection5("")).toThrow(ReportValidationError);
		expect(() => validateSection5("（空）")).toThrow(ReportValidationError);
		expect(() => validateSection5(undefined)).toThrow(ReportValidationError);
		expect(validateSection5("1. 样本量不足 ↳ …")).toBe(true);
	});

	test("契约错误的 name 与段号可被程序识别", () => {
		try {
			validateSection5("");
			throw new Error("应当抛出");
		} catch (e) {
			expect(e).toBeInstanceOf(ReportValidationError);
			expect((e as ReportValidationError).section).toBe(5);
			expect((e as ReportValidationError).name).toBe("ReportValidationError");
		}
	});

	test("信息缺口至少包含小红书 by-design 排除项（'不做'也要可见）", () => {
		const gaps = assembleGaps({
			evidence: [],
			calib: emptyCalib(),
			sensitivity: [],
			collectorDegraded: [],
			contrarianByBranch: {},
			config,
		});
		expect(gaps.some((g) => g.what.includes("小红书"))).toBe(true);
		expect(gaps.every((g) => g.why.length > 0)).toBe(true); // 每条缺口都必须带"为什么"
	});

	test("通道降级 → 计入信息缺口", () => {
		const gaps = assembleGaps({
			evidence: [],
			calib: emptyCalib(),
			sensitivity: [],
			collectorDegraded: [{ channel: "bilibili", query: "字节 实习", reason: "三级降级耗尽" }],
			contrarianByBranch: {},
			config,
		});
		expect(gaps.some((g) => g.what.includes("来源不可达") && g.what.includes("bilibili"))).toBe(true);
	});

	test("样本量 <3 → 计入信息缺口", () => {
		const calib = computePosterior(
			[{ id: "e1", features: f(), notes: [] }],
			[{ id: "e1", channelAuthority: "ugc", platform: "bilibili" }],
			[],
			{ lrTable: LR },
		);
		const gaps = assembleGaps({
			evidence: [{ id: "e1" } as never],
			calib,
			sensitivity: [],
			collectorDegraded: [],
			contrarianByBranch: {},
			config,
		});
		expect(gaps.some((g) => g.what.includes("样本量不足"))).toBe(true);
	});

	test("缺口去重：同一 what 只出现一次", () => {
		const gaps = assembleGaps({
			evidence: [],
			calib: emptyCalib(),
			sensitivity: [],
			collectorDegraded: [
				{ channel: "bilibili", query: "q", reason: "boom" },
				{ channel: "bilibili", query: "q", reason: "boom" },
			],
			contrarianByBranch: {},
			config,
		});
		const whats = gaps.map((g) => g.what);
		expect(new Set(whats).size).toBe(whats.length);
	});
});

function f() {
	return {
		relevance: "on-topic" as const,
		promoCode: { state: false, hits: [] },
		sampleSize: "unlabelled" as const,
		staleness: "current" as const,
		authorDensity: "low" as const,
		densityProxy: "in-corpus" as const,
		commentRebuttal: "unknown" as const,
		daysAgo: 1,
		excerpts: { promoHits: [], sampleSizeHint: null },
	};
}

describe("features 确定性抽取", () => {
	test("内推码 / 引流识别", () => {
		const a = detectPromoCode("内推码 OFFER2027，投递时备注我的内推码");
		expect(a.state).toBe(true);
		expect(a.hits.length).toBeGreaterThan(0);
		expect(detectPromoCode("今天面了个试，感觉一般").state).toBe(false);
		expect(detectPromoCode("").state).toBeNull(); // 空文本 = 无信息，不是"没有引流要素"
	});

	test("个例 vs 群体样本", () => {
		expect(classifySampleSize("我认识的人都拿到转正了")).toBe("personal");
		expect(classifySampleSize("根据官方数据显示，平均留用率30%")).toBe("unlabelled");
		expect(classifySampleSize("转正率这个东西不好说")).toBe("unknown");
	});

	test("时效判定", () => {
		const now = Date.now();
		expect(classifyStaleness(new Date(now - 10 * 86400000).toISOString(), now)).toBe("current");
		expect(classifyStaleness(new Date(now - 200 * 86400000).toISOString(), now)).toBe("stale");
		expect(classifyStaleness(null, now)).toBe("unknown");
		expect(classifyStaleness("不是日期", now)).toBe("unknown");
	});

	test("作者密度分档（代理指标 in-corpus）", () => {
		expect(classifyDensity(0)).toBe("low");
		expect(classifyDensity(2)).toBe("mid");
		expect(classifyDensity(5)).toBe("high");
		expect(classifyDensity(null)).toBe("unknown");
	});

	test("评论区反驳检测：不可达 = unknown，不当作「没有反驳」", () => {
		expect(detectCommentRebuttal(null)).toBe("unknown");
		expect(detectCommentRebuttal([])).toBe("unknown");
		expect(detectCommentRebuttal(["这明显是广告"])).toBe("hasRebuttal");
		expect(detectCommentRebuttal(["讲得挺细的"])).toBe("none");
	});

	test("问题解析：识别公司名与查询词", () => {
		const p = parseQuestion("字节 2027 届前端实习转正率");
		expect(p.companies).toContain("字节");
		expect(p.queries.length).toBeGreaterThan(0);
		expect(p.kind).toBe("claim-like");
		expect(p.rateLike).toBe(true);
	});

	test("问题解析：非主张类问题不误判", () => {
		const p = parseQuestion("多智能体方向有哪些公司");
		expect(p.kind).toBe("info");
		expect(p.companies).not.toContain("字节");
	});
});

describe("反方输出的 URL 白名单去链（第 3 段完整性）", () => {
	// 证据表里的真实 URL（B 站是 av<数字> 形态）
	const real = "http://www.bilibili.com/video/av914714365";
	const allowed = new Set([real]);

	test("证据表内的 markdown 链接原样保留", () => {
		const src = `见[外包经历](${real})说明。`;
		const { text, removed } = stripUnsourcedLinks(src, allowed);
		expect(text).toBe(src);
		expect(removed).toEqual([]);
	});

	test("把内部句柄拼成的假链接去链，论证文字一字不动", () => {
		// 2026-09-23 真跑第 3 段里出现过的实际形态
		const fake = "https://www.bilibili.com/video/ev_563c4275d6";
		const { text, removed } = stripUnsourcedLinks(`主要来自个人分享（如[大厂洋姐职场教练](${fake})）。`, allowed);
		expect(text).toBe("主要来自个人分享（如大厂洋姐职场教练）。");
		expect(removed).toEqual([fake]);
		expect(text).not.toContain("http");
	});

	test("裸的假 URL 降级为行内代码，可见但不可点", () => {
		const fake = "https://www.bilibili.com/video/ev_e3eca4d39e";
		const { text, removed } = stripUnsourcedLinks(`参考 ${fake} 。`, allowed);
		expect(text).toContain(`\`${fake}\``);
		expect(text).not.toMatch(/\]\(http/);
		expect(removed).toEqual([fake]);
	});

	test("带查询参数的真实链接按前缀关系放行，不误伤", () => {
		const withQuery = `${real}?spm_id_from=333.788`;
		const { text, removed } = stripUnsourcedLinks(`[原文](${withQuery})`, allowed);
		expect(text).toBe(`[原文](${withQuery})`);
		expect(removed).toEqual([]);
	});

	test("空证据表时任何链接都算无来源（不默认放行）", () => {
		const { text, removed } = stripUnsourcedLinks(`[x](${real})`, new Set());
		expect(text).toBe("x");
		expect(removed).toEqual([real]);
	});
});

describe("去链处理必须进第 5 段（不许只在第 3 段悄悄改）", () => {
	const real = "http://www.bilibili.com/video/av914714365";
	const fake = "https://www.bilibili.com/video/ev_563c4275d6";

	function evidenceOne() {
		return [
			{
				id: "ev_x",
				contentHash: "h",
				url: real,
				platform: "bilibili",
				title: "t",
				rawSnippet: "s",
				publishedAt: "2026-01-01T00:00:00.000Z",
				author: "a",
				channelAuthority: "ugc",
				comments: null,
			},
		] as never;
	}
	const branch = (rebuttal: string) =>
		({ hyp: { rebuttal, lrAdjustments: [], couldNotRefute: false, claim: "c" } }) as never;

	test("反方含假链接 → 第 5 段出现一条说明被去链的缺口", () => {
		const gaps = assembleGaps({
			evidence: evidenceOne(),
			calib: emptyCalib(),
			sensitivity: [],
			collectorDegraded: [],
			contrarianByBranch: branch(`见[某人](${fake})。`),
			config,
		});
		const hit = gaps.find((g) => g.what.includes("证据表之外的 URL"));
		expect(hit).toBeDefined();
		expect(hit!.why).toContain(fake);
		expect(hit!.why).toContain("仅摘除链接");
	});

	test("反方只引真实链接 → 不产生该缺口（不把处理当默认成本）", () => {
		const gaps = assembleGaps({
			evidence: evidenceOne(),
			calib: emptyCalib(),
			sensitivity: [],
			collectorDegraded: [],
			contrarianByBranch: branch(`见[某人](${real})。`),
			config,
		});
		expect(gaps.some((g) => g.what.includes("证据表之外的 URL"))).toBe(false);
	});
});
