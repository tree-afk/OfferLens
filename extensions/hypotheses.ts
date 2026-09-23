/**
 * extensions/hypotheses.ts —— ★ Tree-of-Hypotheses 编排（核心贡献 ①）。
 *
 * 树级（Pi 会话树，主管独占）= 假设搜索：
 *   每个假设 = 一个 custom entry（"hypothesis"）+ label 状态机
 *   `hyp/<slug>/<state>`（/tree 直接可读）；放弃的假设附 5 段裁决摘要
 *   （"hypothesis-summary" custom entry，同样不进 LLM 上下文）。
 *
 * /check 智能路由：
 *   - 占位模型（默认，未接 API）→ 程序化编排：runCheckFlow 驱动
 *     dispatch_collector/verifier/contrarian（schema 约束完全一致）；
 *   - 真实模型 → 读 prompts/check.md 模板（用户输入注入 $ARGUMENTS），
 *     sendUserMessage 交给真实 LLM 驱动同一组 dispatch 工具。
 *
 * 注：prompts/check.md 不进 pi manifest 的 prompts 声明——否则模板命令与
 * 本扩展的 /check 命令同名冲突（Pi 会注册成 /check:1 /check:2）；
 * 模板作为数据被 /check 读取并注入，语义等价且路由可控。
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dispatchCollector, dispatchContrarian, dispatchVerifier } from "./isolation.ts";
import { loadConfig } from "./lib/config.ts";
import { sharedEvidenceIndex } from "./lib/evidence.ts";
import { type CheckResult, type OrchestrationHooks, type RoleExecutor, runCheckFlow } from "./lib/orchestrator.ts";
import { PLACEHOLDER_PROVIDER } from "./lib/provider-placeholder.ts";
import { HYPOTHESIS_ABANDON_PROMPT } from "./lib/roles.ts";
import { runtime, setLastReport } from "./lib/runtime.ts";
import type { ContrarianResult, Hypothesis } from "./lib/types.ts";
import { ensureDir, packageRoot } from "./lib/util.ts";

/** 命令 ctx 上用到的只读会话视图（Pi 的 ReadonlySessionManager 子集）。 */
interface SessionView {
	getEntries(): Array<{ id: string; type: string; customType?: string; data?: unknown }>;
}

/** pi.appendEntry 不返回 id：追加后从会话条目尾部按 customType 取回。 */
function appendEntryId(pi: ExtensionAPI, sm: SessionView, customType: string, data: unknown): string {
	pi.appendEntry(customType, data);
	const last = [...sm.getEntries()].reverse().find((e) => e.type === "custom" && e.customType === customType);
	if (!last) throw new Error(`appendEntry(${customType}) 后未在会话中找到该条目`);
	return last.id;
}

/** 隔离派发执行器：/check 程序化路径与 LLM 工具路径共用同一实现。 */
function createDispatchExecutor(): RoleExecutor {
	return {
		mode: loadConfig().dispatchMode,
		async executeCollector(payload) {
			const outcome = await dispatchCollector(payload);
			if (!outcome.ok) throw new Error(outcome.error);
			return outcome.result!;
		},
		async executeVerifier(payload) {
			const outcome = await dispatchVerifier(payload);
			if (!outcome.ok) throw new Error(outcome.error);
			return outcome.result!;
		},
		async executeContrarian(payload) {
			const outcome = await dispatchContrarian(payload);
			if (!outcome.ok) throw new Error(outcome.error);
			return outcome.result!;
		},
	};
}

function parseCheckArgs(raw: string): { question: string; claim: string | null; url: string | null } {
	const tokens = raw.split(/\s+/).filter(Boolean);
	let claim: string | null = null;
	let url: string | null = null;
	const rest: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--claim") claim = tokens[++i] ?? null;
		else if (tokens[i] === "--url") url = tokens[++i] ?? null;
		else rest.push(tokens[i]);
	}
	return { question: rest.join(" ").trim(), claim, url };
}

function loadTemplate(name: string, args: string): string {
	const file = path.join(packageRoot(), "prompts", `${name}.md`);
	if (!fs.existsSync(file)) return `OfferLens ${name}: ${args}`;
	return fs.readFileSync(file, "utf8").replace(/\$ARGUMENTS/g, args);
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const index = sharedEvidenceIndex();

	/* ---------- hooks：Pi 会话树落地 ---------- */
	function makeHooks(sm: SessionView, onEvent: (t: string, d: unknown) => void): OrchestrationHooks {
		return {
			onEvent,
			appendEvidence(record) {
				pi.appendEntry("evidence", record); // custom entry：不进 LLM 上下文，/tree 与渲染器可见
				index.register(record);
			},
			appendHypothesis(h: Hypothesis): string {
				return appendEntryId(pi, sm, "hypothesis", { slug: h.slug, statement: h.statement, queries: h.queries });
			},
			setLabel(entryId, label) {
				pi.setLabel(entryId, label); // 状态机编码进 label：hyp/<slug>/<state>，/tree 可读
			},
			appendAbandonSummary(slug, summary) {
				const id = appendEntryId(pi, sm, "hypothesis-summary", { slug, summary, prompt: HYPOTHESIS_ABANDON_PROMPT });
				pi.setLabel(id, `hyp/${slug}/summary`);
			},
		};
	}

	async function runProgrammaticCheck(
		opts: { question: string; claim: string | null; url: string | null },
		sm: SessionView,
		onEvent: (t: string, d: unknown) => void,
	): Promise<CheckResult> {
		const executor = createDispatchExecutor();
		const hooks = makeHooks(sm, onEvent);
		const result = await runCheckFlow(opts, config, executor, hooks);
		setLastReport({ markdown: result.markdown, posterior: result.posterior });
		ensureDir(config.reportsDir);
		const file = path.join(config.reportsDir, `report-${Date.now()}.md`);
		fs.writeFileSync(file, result.markdown, "utf8");
		return result;
	}

	/* ---------- /check：智能路由 ---------- */
	pi.registerCommand("check", {
		description: "OfferLens 甄别：输入岗位问题或待核实说法，产出 5 段式报告（含结构化置信度与信息缺口）",
		handler: async (args, ctx) => {
			const parsed = parseCheckArgs(args);
			if (!parsed.question) {
				ctx.ui.notify(
					"用法：/check 字节 2027 届前端实习转正率　或　/check --url <链接> --claim <主张> <问题>",
					"error",
				);
				return;
			}
			const model = ctx.model as { provider?: string } | null;
			const realModel = model && model.provider && model.provider !== PLACEHOLDER_PROVIDER;

			if (realModel) {
				// 真实模型路径：模板注入，LLM 驱动同一组 dispatch 工具
				ctx.ui.notify(`已交给当前模型（${model.provider}）按 check 工作流驱动派发工具…`, "info");
				pi.sendUserMessage(
					loadTemplate(
						"check",
						`${parsed.question}${parsed.claim ? ` --claim ${parsed.claim}` : ""}${parsed.url ? ` --url ${parsed.url}` : ""}`,
					),
				);
				return;
			}

			// 占位模型路径：程序化编排（schema 约束与 LLM 路径完全一致）
			ctx.ui.setStatus("offerlens", "甄别运行中…");
			try {
				const result = await runProgrammaticCheck(parsed, ctx.sessionManager as SessionView, (type, data) => {
					if (type === "hypothesis")
						ctx.ui.setStatus(
							"offerlens",
							`hyp/${(data as { slug: string }).slug} → ${(data as { state: string }).state}`,
						);
					else if (type === "degraded") ctx.ui.setStatus("offerlens", `降级: ${(data as { channel: string }).channel}`);
				});
				ctx.ui.setStatus("offerlens", undefined);
				pi.sendMessage(
					{
						customType: "offerlens-report",
						content: result.markdown,
						display: true,
						details: { posterior: result.posterior, evidenceCount: result.evidenceCount, mode: config.dispatchMode },
					},
					{ triggerTurn: false },
				);
			} catch (e) {
				ctx.ui.setStatus("offerlens", undefined);
				ctx.ui.notify(`甄别失败: ${(e as Error).message}`, "error");
			}
		},
	});

	/* ---------- /scan：主动扫描（信息面收集，同样 5 段契约） ---------- */
	pi.registerCommand("scan", {
		description: "OfferLens 主动扫描：收集某方向的当前机会面（行动建议权重加大）",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("用法：/scan 多智能体方向 2027 届秋招", "error");
				return;
			}
			const model = ctx.model as { provider?: string } | null;
			if (model && model.provider && model.provider !== PLACEHOLDER_PROVIDER) {
				pi.sendUserMessage(loadTemplate("scan", question));
				return;
			}
			ctx.ui.setStatus("offerlens", "扫描运行中…");
			try {
				const result = await runProgrammaticCheck(
					{ question, claim: null, url: null },
					ctx.sessionManager as SessionView,
					() => {},
				);
				ctx.ui.setStatus("offerlens", undefined);
				pi.sendMessage(
					{
						customType: "offerlens-report",
						content: result.markdown,
						display: true,
						details: { posterior: result.posterior },
					},
					{ triggerTurn: false },
				);
			} catch (e) {
				ctx.ui.setStatus("offerlens", undefined);
				ctx.ui.notify(`扫描失败: ${(e as Error).message}`, "error");
			}
		},
	});

	/* ---------- /abandon：<slug> —— Pi 原生分支摘要（真实模型路径） ---------- */
	pi.registerCommand("abandon", {
		description: "放弃指定假设分支：navigateTree + HYPOTHESIS_ABANDON_PROMPT 生成 Pi 原生裁决摘要（需真实模型）",
		handler: async (args, ctx) => {
			const slug = args.trim().split(/\s+/)[0];
			if (!slug) {
				ctx.ui.notify("用法：/abandon <slug>（如 softad）", "error");
				return;
			}
			const model = ctx.model as { provider?: string } | null;
			if (!model || model.provider === PLACEHOLDER_PROVIDER) {
				ctx.ui.notify(
					`占位模型不支持 Pi 原生分支摘要（navigateTree 的摘要器需要真实 LLM）。占位路径的裁决摘要已以 custom entry 自动留存（/tree 查看 hyp/${slug}/summary）。`,
					"warning",
				);
				return;
			}
			const entries = ctx.sessionManager.getEntries();
			const target = [...entries]
				.reverse()
				.find(
					(e) =>
						e.type === "custom" &&
						(e as { customType?: string }).customType === "hypothesis" &&
						(e as { data?: { slug?: string } }).data?.slug === slug,
				);
			if (!target) {
				ctx.ui.notify(`未找到 hyp/${slug} 的分支 entry（先运行 /check）`, "error");
				return;
			}
			const result = await ctx.navigateTree(target.id, {
				summarize: true,
				customInstructions: HYPOTHESIS_ABANDON_PROMPT,
				label: `hyp/${slug}/abandoned`,
			});
			ctx.ui.notify(result.cancelled ? "已取消" : `已放弃 hyp/${slug}，Pi 原生裁决摘要已生成（/tree 查看）`, "info");
		},
	});

	/* ---------- /offerlens-setup：同步角色定义到 .pi/agents/ ---------- */
	pi.registerCommand("offerlens-setup", {
		description: "把 agents/*.md（collector/verifier/contrarian）同步到项目 .pi/agents/，供 subagent 派发发现",
		handler: async (_args, ctx) => {
			const src = path.join(packageRoot(), "agents");
			const dst = path.join(ctx.cwd, ".pi", "agents");
			fs.mkdirSync(dst, { recursive: true });
			const copied: string[] = [];
			for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".md"))) {
				fs.copyFileSync(path.join(src, f), path.join(dst, f));
				copied.push(f.replace(".md", ""));
			}
			ctx.ui.notify(`已同步角色定义: ${copied.join(", ")} → ${dst}`, "info");
		},
	});

	// session_start：重建证据索引 + 校验 runtime（sources.ts 应已先加载）
	pi.on("session_start", async (_event, ctx) => {
		void runtime();
		index.rebuild(
			ctx.sessionManager.getEntries().map((e) => ({
				id: e.id,
				type: e.type,
				customType: (e as { customType?: string }).customType,
				data: (e as { data?: unknown }).data,
			})),
		);
	});
}

export type { ContrarianResult, RoleExecutor };
