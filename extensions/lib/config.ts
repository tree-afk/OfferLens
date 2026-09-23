/** OfferLens 运行时配置 —— config/config.json + config/likelihood-ratios.json。 */
import path from "node:path";
import type { CalibrationResult } from "./types.ts";
import { packageRoot, readJsonIfExists } from "./util.ts";

export interface OfferLensConfig {
	_doc?: string;
	/** stub = 占位模型（默认，不接入 API）；subagent = 通过 vendored 派发真实 pi 子进程。 */
	dispatchMode: "stub" | "subagent";
	/** subagent 模式下，单个角色子进程"未通过 emit 工具提交合法结果"时的重试次数（读不到即报错重试，不做 JSON 兜底）。 */
	subagentRetries: number;
	sources: {
		cacheTtlMs: number;
		cacheDir: string;
		maxItemsPerSource: number;
		fetchTimeoutMs: number;
		bilibili: { enabled: boolean; minIntervalMs: number; maxPages: number; fetchComments: boolean };
		web: { enabled: boolean; minIntervalMs: number; jinaBaseUrl: string };
		rss: { enabled: boolean; minIntervalMs: number; feeds: string[] };
		youtube: { enabled: boolean; minIntervalMs: number };
	};
	calibration: {
		priorLogodds: number;
		sensitivityDeltaThreshold: number;
		contrarianAdjustmentCap: { min: number; max: number };
	};
	reportsDir: string;
	/** 会话产物目录（events.jsonl / entries.jsonl）——Web 桥与 TUI 树视图共用。 */
	sessionDir: string;
	/** Web SSE 桥监听地址（node web/server.ts）。 */
	web: { host: string; port: number };
}

const DEFAULTS: OfferLensConfig = {
	dispatchMode: "stub",
	subagentRetries: 2,
	sources: {
		cacheTtlMs: 86400000,
		cacheDir: ".offerlens/cache",
		maxItemsPerSource: 6,
		fetchTimeoutMs: 20000,
		bilibili: { enabled: true, minIntervalMs: 1500, maxPages: 1, fetchComments: true },
		web: { enabled: true, minIntervalMs: 800, jinaBaseUrl: "https://r.jina.ai/" },
		rss: { enabled: true, minIntervalMs: 500, feeds: ["https://github.blog/feed/"] },
		youtube: { enabled: true, minIntervalMs: 800 },
	},
	calibration: {
		priorLogodds: 0,
		sensitivityDeltaThreshold: 0.2,
		contrarianAdjustmentCap: { min: 0.2, max: 5 },
	},
	reportsDir: ".offerlens/reports",
	sessionDir: ".offerlens/sessions",
	web: { host: "127.0.0.1", port: 8787 },
};

function deepMerge<T>(base: T, over: unknown): T {
	if (over === undefined || over === null) return base;
	if (
		typeof base !== "object" ||
		base === null ||
		typeof over !== "object" ||
		Array.isArray(base) ||
		Array.isArray(over)
	) {
		return over as T;
	}
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const k of Object.keys(over as Record<string, unknown>)) {
		out[k] = deepMerge((base as Record<string, unknown>)[k], (over as Record<string, unknown>)[k]);
	}
	return out as T;
}

let cached: OfferLensConfig | null = null;

export function loadConfig(): OfferLensConfig {
	if (cached) return cached;
	const root = packageRoot();
	const user = readJsonIfExists<Record<string, unknown>>(path.join(root, "config", "config.json")) ?? {};
	const merged = deepMerge(DEFAULTS, user.offerlens ?? user);
	// 绝对化相对路径
	merged.sources.cacheDir = path.isAbsolute(merged.sources.cacheDir)
		? merged.sources.cacheDir
		: path.join(root, merged.sources.cacheDir);
	merged.reportsDir = path.isAbsolute(merged.reportsDir) ? merged.reportsDir : path.join(root, merged.reportsDir);
	merged.sessionDir = path.isAbsolute(merged.sessionDir) ? merged.sessionDir : path.join(root, merged.sessionDir);
	cached = merged;
	return merged;
}

export function resetConfigCache(): void {
	cached = null;
}

/* ---------------- 似然比表 ---------------- */

export interface LrSpec {
	_doc?: string;
	lr: Record<string, number>;
	contrarianAdjustable: boolean;
	direction: string;
}

export interface LikelihoodRatios {
	_doc?: string;
	target: string;
	features: Record<string, LrSpec>;
	corpusFeatures: Record<string, { condition: string; logodds: number }>;
	saturation: { scale: number };
}

let lrCached: LikelihoodRatios | null = null;

export function loadLikelihoodRatios(): LikelihoodRatios {
	if (lrCached) return lrCached;
	const root = packageRoot();
	const table = readJsonIfExists<LikelihoodRatios>(path.join(root, "config", "likelihood-ratios.json"));
	if (!table || !table.features) {
		throw new Error(`似然比配置缺失或损坏: ${path.join(root, "config", "likelihood-ratios.json")}`);
	}
	lrCached = table;
	return table;
}

export function resetLrCache(): void {
	lrCached = null;
}

export type { CalibrationResult };
