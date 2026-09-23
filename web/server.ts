/**
 * Web SSE 桥 —— node:http 直托管（不用 Express/Fastify，零依赖）。
 *
 * ── 迁移说明（计划步骤 12）──────────────────────────────────────────────
 * 本文件不再依赖 src/ 下的自建内核（Orchestrator / SessionTree）。它直接驱动
 * extensions/lib 的 runCheckFlow + createStubExecutor，并用一组「进程内 hooks」
 * 复刻 Pi 的 appendEntry / setLabel 语义（Pi 在扩展里由 pi.appendEntry /
 * pi.setLabel 提供，独立托管时需要自己落盘）。三份产物互不混淆：
 *
 *   SSE 事件流（UI 渲染用）      → .offerlens/sessions/<id>/events.jsonl
 *   custom entry 审计（树视图用）→ .offerlens/sessions/<id>/entries.jsonl
 *   5 段报告（markdown）         → .offerlens/reports/<id>.md
 *
 * 路由：
 *   POST /api/check?q=...            → 启动一次编排，返回 sessionId
 *   GET  /api/events?session=<id>    → SSE 事件流（先重放已持久化事件，再跟进实时流）
 *   GET  /api/tree?session=<id>      → 假设树文本（从 entries.jsonl 重建的只读视图）
 *   GET  /api/report?session=<id>    → 5 段报告 markdown
 *   GET  /                           → static/index.html
 *
 * 事件类型（与前端契约一致，保持不变）：agent_state / evidence / confidence /
 * rebuttal / hypothesis / degraded / done（另加 hypothesis_summary 供树视图）。
 * 刷新页面不丢历史 —— SSE 只做传输，状态在会话 JSONL 里。
 *
 * 运行：node web/server.ts （Node ≥ 22.18 原生剥离类型；或用 pi 的 jiti 加载）
 * 端口：PORT（默认 8787）/ HOST（默认 127.0.0.1）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../extensions/lib/config.ts";
import { createChannels } from "../extensions/lib/sources.ts";
import { sharedEvidenceIndex } from "../extensions/lib/evidence.ts";
import {
	createStubExecutor,
	runCheckFlow,
	type OrchestrationHooks,
} from "../extensions/lib/orchestrator.ts";
import { ensureDir, truncate } from "../extensions/lib/util.ts";
import type { EvidenceRecord, Hypothesis } from "../extensions/lib/types.ts";

const __dirname = import.meta.dirname;
const config = loadConfig();
const sessionsDir = config.sessionDir;
const reportsDir = config.reportsDir;
const PORT = Number(process.env.PORT ?? config.web.port);
const HOST = process.env.HOST ?? config.web.host;

/** sessionId → { listeners }；运行中的会话注册在此。 */
const live = new Map<string, { listeners: Set<http.ServerResponse> }>();

const dirOf = (sessionId: string): string => path.join(sessionsDir, sessionId);
const eventsFile = (sessionId: string): string => path.join(dirOf(sessionId), "events.jsonl");
const entriesFile = (sessionId: string): string => path.join(dirOf(sessionId), "entries.jsonl");

function persistEvent(sessionId: string, evt: { type: string; data: unknown; at: string }): void {
	ensureDir(dirOf(sessionId));
	fs.appendFileSync(eventsFile(sessionId), JSON.stringify(evt) + "\n", "utf8");
}

function persistEntry(sessionId: string, rec: Record<string, unknown>): void {
	ensureDir(dirOf(sessionId));
	fs.appendFileSync(entriesFile(sessionId), JSON.stringify(rec) + "\n", "utf8");
}

function readJsonl<T = Record<string, unknown>>(file: string): T[] {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l) as T;
			} catch {
				return null;
			}
		})
		.filter((x): x is T => x !== null);
}

function sseWrite(res: http.ServerResponse, evt: unknown): void {
	res.write(`data: ${JSON.stringify(evt)}\n\n`);
}

/**
 * 进程内 hooks：把 runCheckFlow 的持久化/状态机调用复刻为 Pi 的 appendEntry / setLabel。
 * 「done」事件被刻意吞掉 —— 由调用方在报告落盘之后再统一发出，避免前端在 done 时
 * 立刻拉取 /api/report 却读到尚未写入的文件。
 */
function createSessionHooks(sessionId: string): { hooks: OrchestrationHooks; emit: (type: string, data: unknown) => void } {
	const emit = (type: string, data: unknown): void => {
		const evt = { type, data, at: new Date().toISOString() };
		persistEvent(sessionId, evt);
		const reg = live.get(sessionId);
		if (reg) for (const res of reg.listeners) sseWrite(res, evt);
	};
	let seq = 0;
	const hooks: OrchestrationHooks = {
		onEvent: (type, data) => {
			if (type !== "done") emit(type, data);
		},
		appendEvidence: (record: EvidenceRecord) => {
			// custom entry 不进 LLM 上下文（Pi 语义）；此处仅落盘供审计/重建。
			persistEntry(sessionId, { type: "custom", customType: "evidence", data: record, at: new Date().toISOString() });
		},
		appendHypothesis: (h: Hypothesis): string => {
			const entryId = `hyp-${h.slug}-${++seq}`;
			persistEntry(sessionId, {
				type: "custom",
				customType: "hypothesis",
				entryId,
				slug: h.slug,
				statement: h.statement,
				queries: h.queries,
				at: new Date().toISOString(),
			});
			return entryId;
		},
		setLabel: (entryId, label) => {
			// 状态机编码进 label：hyp/<slug>/<state>（Pi 的 setLabel 只接受单个字符串）
			persistEntry(sessionId, { type: "custom", customType: "label", entryId, label, at: new Date().toISOString() });
		},
		appendAbandonSummary: (slug, summary) => {
			persistEntry(sessionId, { type: "custom", customType: "hypothesis-summary", slug, summary, at: new Date().toISOString() });
			emit("hypothesis_summary", { slug, summary });
		},
	};
	return { hooks, emit };
}

/** 从 entries.jsonl 重建假设树文本（label 状态机只读视图）。 */
function renderTree(sessionId: string): string {
	const entries = readJsonl<Record<string, any>>(entriesFile(sessionId));
	const hyps: Array<{ entryId: string; slug: string; statement: string }> = [];
	const labels = new Map<string, string>();
	const summaries = new Map<string, string>();
	for (const e of entries) {
		if (e.customType === "hypothesis") hyps.push({ entryId: e.entryId, slug: e.slug, statement: e.statement });
		else if (e.customType === "label") labels.set(e.entryId, e.label);
		else if (e.customType === "hypothesis-summary") summaries.set(e.slug, e.summary);
	}
	if (!hyps.length) return "（空：尚无假设分支）";
	const lines = [`假设树 —— session ${sessionId}（label 状态机：hyp/<slug>/<state>）`];
	hyps.forEach((h, i) => {
		const label = labels.get(h.entryId) ?? `hyp/${h.slug}/open`;
		const slash = i === hyps.length - 1 ? "└─" : "├─";
		lines.push(`${slash} ${label.padEnd(36)} ${truncate(h.statement, 48)}`);
		const sum = summaries.get(h.slug);
		if (sum) lines.push(`   ↳ 裁决摘要：${truncate(sum, 140)}`);
	});
	return lines.join("\n");
}

// 通道与执行器只建一次（占位模式 = 进程内确定性；subagent 模式需 Pi 运行时，此处降级）。
const channels = createChannels(config);
const executor = createStubExecutor(channels, config);
ensureDir(reportsDir);
ensureDir(sessionsDir);
if (config.dispatchMode === "subagent") {
	console.warn("[web] dispatchMode=subagent 需要 Pi 运行时；Web 桥降级为占位执行器（stub）。");
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

	if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		fs.createReadStream(path.join(__dirname, "static", "index.html")).pipe(res);
		return;
	}

	if (req.method === "POST" && url.pathname === "/api/check") {
		let body = "";
		for await (const chunk of req) body += chunk;
		let payload: { q?: string; claim?: string; url?: string; ablateContrarian?: boolean } = {};
		try {
			payload = JSON.parse(body || "{}");
		} catch {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "请求体不是合法 JSON" }));
			return;
		}
		const q = payload.q?.trim();
		if (!q) {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "缺少 q" }));
			return;
		}
		const sessionId = `web-${Date.now().toString(36)}`;
		ensureDir(dirOf(sessionId));
		const reg = { listeners: new Set<http.ServerResponse>() };
		live.set(sessionId, reg);
		const { hooks, emit } = createSessionHooks(sessionId);

		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ sessionId }));

		// 会话级隔离：清空进程内证据索引（contentHash 去重只在单次会话内生效）
		sharedEvidenceIndex().rebuild([]);

		void (async () => {
			try {
				const result = await runCheckFlow(
					{
						question: q,
						claim: payload.claim ?? null,
						url: payload.url ?? null,
						// 消融对照（计划 §5.1）：true 时禁用反方 Agent，用于定性对照脚本
						ablateContrarian: payload.ablateContrarian === true,
					},
					config,
					executor,
					hooks,
				);
				// ★ 先落盘报告，再发 done —— 前端收到 done 立即拉 /api/report 才能读到内容
				fs.writeFileSync(path.join(reportsDir, `${sessionId}.md`), result.markdown, "utf8");
				emit("done", { posterior: result.posterior, evidenceCount: result.evidenceCount });
			} catch (e) {
				emit("done", { error: String((e as Error)?.message ?? e) });
			} finally {
				live.delete(sessionId);
			}
		})();
		return;
	}

	if (req.method === "GET" && url.pathname === "/api/events") {
		const sessionId = url.searchParams.get("session");
		if (!sessionId) {
			res.writeHead(400).end("missing session");
			return;
		}
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		for (const evt of readJsonl(eventsFile(sessionId))) sseWrite(res, evt);
		const reg = live.get(sessionId);
		if (reg) {
			reg.listeners.add(res);
			req.on("close", () => reg.listeners.delete(res));
		} else {
			res.write("data: {\"type\":\"done\"}\n\n"); // 无实时流：重放结束即 done
			res.end();
		}
		return;
	}

	if (req.method === "GET" && url.pathname === "/api/tree") {
		const sessionId = url.searchParams.get("session");
		if (!sessionId) {
			res.writeHead(400).end("missing session");
			return;
		}
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		res.end(renderTree(sessionId));
		return;
	}

	if (req.method === "GET" && url.pathname === "/api/report") {
		const sessionId = url.searchParams.get("session");
		const file = sessionId ? path.join(reportsDir, `${sessionId}.md`) : "";
		if (!file || !fs.existsSync(file)) {
			res.writeHead(404).end("report not found");
			return;
		}
		res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
		fs.createReadStream(file).pipe(res);
		return;
	}

	res.writeHead(404).end("not found");
});

server.listen(PORT, HOST, () => {
	console.log(`OfferLens Web: http://${HOST}:${PORT}  (Ctrl+C 退出)`);
	console.log(`  执行器：${executor.mode}   会话目录：${sessionsDir}`);
});
