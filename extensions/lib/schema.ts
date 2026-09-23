/**
 * ★ Schema 强制的上下文隔离（核心贡献 ②）—— 纯逻辑层。
 *
 * 问题：进程隔离保证"父历史传不过去"，但没保证主管只传原始证据。
 * 解法：让泄漏在类型层面无法表达 —— 派发工具的载荷 schema 是封闭的
 * （additionalProperties: false），schema 外字段 = fail-closed 拒绝。
 * evidence_ids 由扩展侧解析为 rawSnippet：主管只能传"句柄"，传不了内容。
 *
 * 本文件维护 schema 的规范描述（与 isolation.ts 里注册进 pi 的 TypeBox schema
 * 一一对应）；运行时校验在占位/程序化路径上仍然执行（真实 LLM 路径由 Pi 的
 * validateToolArguments 在框架层执行同一约束）。
 */

export interface FieldSpec {
	type: "string" | "number" | "array" | "boolean";
	items?: { type: "string" };
	description: string;
	optional?: boolean;
}

export interface DispatchSchema {
	type: "object";
	additionalProperties: false;
	required: string[];
	description: string;
	properties: Record<string, FieldSpec>;
}

export const DispatchSchemas = {
	dispatch_collector: {
		type: "object",
		additionalProperties: false,
		required: ["hypothesis", "queries"],
		description: "采集派发：只收假设描述与查询计划。没有任务之外的字段。",
		properties: {
			hypothesis: { type: "string", description: "当前假设的自然语言描述（这是给采集的上下文，不是结论）" },
			queries: { type: "array", items: { type: "string" }, description: "查询关键词" },
			urls: { type: "array", items: { type: "string" }, description: "用户直接给定的待核实链接（可选输入，非结论）", optional: true },
			sourcePlan: { type: "array", items: { type: "string" }, description: "内容源调用计划（可选；占位模式下由扩展解析）", optional: true },
		},
	},
	dispatch_verifier: {
		type: "object",
		additionalProperties: false,
		required: ["evidence_ids"],
		description: "质检派发：只收证据 ID。质检的输入=原文片段（扩展侧解析），不是主管的任何结论。",
		properties: {
			evidence_ids: { type: "array", items: { type: "string" }, description: "证据句柄，由扩展侧解析为原文" },
			claim: { type: "string", description: "用户主张原文（相关性判定的对象本身，不是任何前序结论）", optional: true },
			focus: { type: "string", description: "质检关注点提示（可选）——禁止携带评分/结论", optional: true },
		},
	},
	dispatch_contrarian: {
		type: "object",
		additionalProperties: false,
		required: ["claim", "evidence_ids"],
		description: "反方派发：★ 只收 claim + evidence_ids。没有 verdicts / reasoning / summary 字段。",
		properties: {
			claim: { type: "string", description: "待反驳的主张原文" },
			evidence_ids: { type: "array", items: { type: "string" }, description: "原始证据 ID，由扩展侧解析为原文" },
		},
	},
} satisfies Record<string, DispatchSchema>;

export type DispatchToolName = keyof typeof DispatchSchemas;

/** 校验载荷：未知字段直接抛错（fail-closed）——"无法表达即无法泄漏"的执行点。 */
export function validateDispatchPayload(toolName: DispatchToolName, payload: unknown): { ok: true; sanitized: Record<string, unknown> } {
	const schema = DispatchSchemas[toolName];
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error(`${toolName} 载荷必须是对象`);
	}
	const known = new Set(Object.keys(schema.properties));
	// ★ 泄漏尝试在此处被拒绝：schema 外的任何字段（如 verdicts / verifierSummary）都无法通过
	const illegal = Object.keys(payload).filter((k) => !known.has(k));
	if (illegal.length) {
		throw new Error(
			`${toolName} 载荷校验失败：schema 不允许字段 [${illegal.join(", ")}]。` +
				`派发工具是封闭 schema（additionalProperties=false），主管无法表达它就无法泄漏。`,
		);
	}
	for (const req of schema.required) {
		if (!(req in payload)) throw new Error(`${toolName} 缺少必填字段: ${req}`);
	}
	for (const [k, spec] of Object.entries(schema.properties)) {
		if (!(k in payload)) continue;
		const v = (payload as Record<string, unknown>)[k];
		const t = spec.type as string;
		if (t === "string" && typeof v !== "string") throw new Error(`${toolName}.${k} 必须是 string`);
		if (t === "number" && typeof v !== "number") throw new Error(`${toolName}.${k} 必须是 number`);
		if (t === "boolean" && typeof v !== "boolean") throw new Error(`${toolName}.${k} 必须是 boolean`);
		if (t === "array" && !Array.isArray(v)) throw new Error(`${toolName}.${k} 必须是 array`);
		if (t === "array" && Array.isArray(v) && (spec as FieldSpec).items?.type === "string") {
			if (v.some((x) => typeof x !== "string")) throw new Error(`${toolName}.${k} 数组元素必须是 string`);
		}
	}
	return { ok: true, sanitized: payload as Record<string, unknown> };
}

/** 断言：反方工具的 schema 里不存在任何能传递前序结论的字段（测试与启动自检用）。 */
export function assertContrarianSchemaIsolation(): { props: string[]; ok: true } {
	const props = Object.keys(DispatchSchemas.dispatch_contrarian.properties);
	const forbidden = ["verdict", "verdicts", "reasoning", "summary", "score", "confidence", "analysis", "quality"];
	const leaked = props.filter((p) => forbidden.includes(p.toLowerCase()));
	if (leaked.length) {
		throw new Error(`反方 schema 出现可疑字段: ${leaked.join(", ")}`);
	}
	return { props, ok: true };
}
