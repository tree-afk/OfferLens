/**
 * OfferLens 占位 Provider —— "专家背后的模型"占位实现（不接入任何 LLM API）。
 *
 * 通过 pi.registerProvider 注册为 `offerlens-placeholder/offerlens-placeholder-v1`。
 * vendored subagent 派发子 pi 进程时传 `--model offerlens-placeholder/...`，
 * 子进程同样加载本包 → 同名 Provider 可解析 → agent 循环跑在本 Provider 上。
 *
 * 行为：解析子进程的 `Task: {json}` 载荷，按 payload.role 确定性执行角色逻辑：
 *   - collector：首轮重放 sourcePlan 工具调用（真实网络）；次轮汇总为 JSON 文本；
 *   - verifier / contrarian：单轮直接产出 JSON 文本（只推理不检索）。
 * 真实模型接入：用户切换到真实模型（--model anthropic/...），子进程继承，
 * 角色由 .pi/agents/*.md 的 system prompt 引导 —— 本文件即被绕过，编排层零改动。
 */
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	createProvider,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { runContrarian, runVerifier, type SourceTools } from "./roles.ts";
import type { CollectorResult, ContrarianResult, RawItem, SourcePlanEntry, VerifierResult } from "./types.ts";

export const PLACEHOLDER_PROVIDER = "offerlens-placeholder";
export const PLACEHOLDER_MODEL_ID = "offerlens-placeholder-v1";
export const PLACEHOLDER_MODEL_REF = `${PLACEHOLDER_PROVIDER}/${PLACEHOLDER_MODEL_ID}`;

interface TaskPayload {
	role: "collector" | "verifier" | "contrarian";
	payload: {
		hypothesis?: string;
		queries?: string[];
		urls?: string[];
		sourcePlan?: SourcePlanEntry[];
		evidence?: Array<Record<string, unknown>>;
		claim?: string;
		evidence_ids?: string[];
	};
}

function lastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const m = context.messages[i];
		if (m.role === "user") {
			const parts = (m.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "");
			return parts.join("\n");
		}
	}
	return "";
}

function parseTask(context: Context): TaskPayload | null {
	const text = lastUserText(context);
	const m = text.match(/Task:\s*([\s\S]+)/);
	if (!m) return null;
	try {
		return JSON.parse(m[1]) as TaskPayload;
	} catch {
		return null;
	}
}

function hasToolResults(context: Context): boolean {
	return context.messages.some((m) => m.role === "toolResult");
}

/** 从 toolResult 消息提取 JSON（fetch_* 工具的 content 是 JSON 字符串）。 */
function toolResultJsons(context: Context): Array<{ tool: string; json: unknown }> {
	const out: Array<{ tool: string; json: unknown }> = [];
	for (const m of context.messages) {
		if (m.role !== "toolResult") continue;
		const text = (m.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
		try {
			out.push({ tool: (m as { toolName?: string }).toolName ?? "", json: JSON.parse(text) });
		} catch {
			/* 非 JSON 输出忽略 */
		}
	}
	return out;
}

function collectorResultFromToolResults(context: Context, queries: string[], urls: string[]): CollectorResult {
	const items: (RawItem & { viaHypothesis?: string })[] = [];
	const degraded: CollectorResult["degraded"] = [];
	for (const { tool, json } of toolResultJsons(context)) {
		if (Array.isArray(json)) {
			items.push(...(json as RawItem[]));
		} else if (json && typeof json === "object" && "error" in (json as Record<string, unknown>)) {
			degraded.push({
				channel: tool.replace("fetch_", ""),
				query: "",
				reason: String((json as Record<string, unknown>).error),
			});
		}
	}
	return {
		items,
		degraded,
		plan: { queries, urls, bilibili: queries.length, web: [], rss: [] },
	};
}

/** 简化发射：把消息按单 chunk 推入目标流（占位模型无需逐 token 流式）。 */
type StreamEvent = Parameters<AssistantMessageEventStream["push"]>[0];
function emitInto(stream: AssistantMessageEventStream, message: AssistantMessage): void {
	stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } } as StreamEvent);
	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];
		if (block.type === "text") {
			stream.push({
				type: "text_start",
				contentIndex: i,
				partial: { ...message, content: [...message.content.slice(0, i), { type: "text", text: "" }] },
			} as StreamEvent);
			stream.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: message } as StreamEvent);
			stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: message } as StreamEvent);
		} else if (block.type === "toolCall") {
			stream.push({
				type: "toolcall_start",
				contentIndex: i,
				partial: { ...message, content: [...message.content.slice(0, i), { ...block, arguments: {} }] },
			} as StreamEvent);
			stream.push({
				type: "toolcall_delta",
				contentIndex: i,
				delta: JSON.stringify(block.arguments),
				partial: message,
			} as StreamEvent);
			stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: message } as StreamEvent);
		}
	}
	stream.push({ type: "done", reason: message.stopReason, message } as StreamEvent);
	stream.end(message);
}

function textMessage(text: string): AssistantMessage {
	return fauxAssistantMessage(text, { stopReason: "stop" });
}

function toolCallMessage(calls: Array<{ name: string; args: Record<string, unknown> }>): AssistantMessage {
	const toolCalls: ToolCall[] = calls.map((c, i) => ({
		type: "toolCall",
		id: `offerlens-tool-${Date.now()}-${i}`,
		name: c.name,
		arguments: c.args,
	}));
	return fauxAssistantMessage(toolCalls, { stopReason: "toolUse" });
}

/** 占位 stream：按会话内容确定性决定下一动作。 */
const placeholderStream: StreamFunction<string, SimpleStreamOptions> = (_model: Model<string>, context: Context) => {
	const outer = createAssistantMessageEventStream();
	const task = parseTask(context);
	queueMicrotask(() => {
		let message: AssistantMessage;
		if (!task) {
			message = textMessage(
				JSON.stringify({ error: "OfferLens 占位模型：缺少 Task 载荷（应由 offerlens 派发工具提供）" }),
			);
		} else if (task.role === "collector") {
			if (!hasToolResults(context)) {
				// 首轮：重放 sourcePlan 的内容源工具调用（真实网络）
				const plan = task.payload.sourcePlan ?? [];
				message = toolCallMessage(plan.map((p) => ({ name: p.tool, args: p.args })));
			} else {
				const result = collectorResultFromToolResults(context, task.payload.queries ?? [], task.payload.urls ?? []);
				message = textMessage(JSON.stringify(result));
			}
		} else if (task.role === "verifier") {
			const raws = (task.payload.evidence ?? []).map((r) => ({
				id: String(r.id),
				title: String(r.title ?? ""),
				rawSnippet: String(r.rawSnippet ?? ""),
				publishedAt: (r.publishedAt as string | null) ?? null,
				author: (r.author as string | null) ?? null,
				comments: (r.comments as string[] | null) ?? null,
			}));
			const result: VerifierResult = runVerifier({ evidence: raws, claim: task.payload.claim });
			message = textMessage(JSON.stringify(result));
		} else if (task.role === "contrarian") {
			const raws = (task.payload.evidence ?? []).map((r) => ({
				id: String(r.id),
				title: String(r.title ?? ""),
				rawSnippet: String(r.rawSnippet ?? ""),
				publishedAt: (r.publishedAt as string | null) ?? null,
				platform: (r.platform as string | undefined) ?? undefined,
				channelAuthority: (r.channelAuthority as string | undefined) ?? undefined,
			}));
			const result: ContrarianResult = runContrarian({ claim: task.payload.claim ?? "", evidence: raws });
			message = textMessage(JSON.stringify(result));
		} else {
			message = textMessage(JSON.stringify({ error: `未知角色: ${(task as { role: string }).role}` }));
		}
		emitInto(outer, message);
	});
	return outer;
};

export interface PlaceholderHandle {
	provider: ReturnType<typeof createProvider>;
	model: Model<string>;
}

let handle: PlaceholderHandle | null = null;

export function getPlaceholderProvider(): PlaceholderHandle {
	if (handle) return handle;
	const models = [
		{
			id: PLACEHOLDER_MODEL_ID,
			name: "OfferLens Placeholder（确定性占位，未接入 API）",
			api: "offerlens-placeholder-api",
			provider: PLACEHOLDER_PROVIDER,
			baseUrl: "http://localhost:0",
			reasoning: false,
			input: ["text"] as "text"[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		},
	] as unknown as [Model<string>, ...Model<string>[]];
	const provider = createProvider({
		id: PLACEHOLDER_PROVIDER,
		name: "OfferLens Placeholder",
		auth: { apiKey: { name: "OfferLens placeholder (no auth)", resolve: async () => ({ auth: {} }) } },
		models,
		api: {
			stream: placeholderStream,
			streamSimple: placeholderStream,
		},
	});
	handle = { provider, model: models[0] };
	return handle;
}

export { runContrarian, runVerifier, type SourceTools };
