/**
 * Schema 强制的上下文隔离测试（迁移自 test/isolation.test.js → vitest）。
 *
 * ★ 核心命题：反方派发工具的载荷 schema 里**物理上不存在**能传递前序结论的字段，
 *   因此"主管把质检结论夹带进反方上下文"这件事无法表达；一旦尝试，fail-closed 拒绝。
 */
import { describe, expect, test } from "vitest";
import { assertContrarianSchemaIsolation, DispatchSchemas, validateDispatchPayload } from "../extensions/lib/schema.ts";

describe("isolation", () => {
	test("反方工具的 schema 里不存在任何能传递前序结论的字段", () => {
		const { props } = assertContrarianSchemaIsolation();
		expect([...props].sort()).toEqual(["claim", "evidence_ids"]);
		expect(DispatchSchemas.dispatch_contrarian.additionalProperties).toBe(false);
	});

	test("主管在派发载荷里夹带质检结论 → fail-closed 拒绝", () => {
		expect(() =>
			validateDispatchPayload("dispatch_contrarian", {
				claim: "x",
				evidence_ids: ["ev_1"],
				verdicts: "质检认为可信度 0.8",
			}),
		).toThrow(/无法表达它就无法泄漏/);
	});

	test("合法载荷通过校验", () => {
		const r = validateDispatchPayload("dispatch_contrarian", { claim: "x", evidence_ids: ["ev_1"] });
		expect(r.ok).toBe(true);
	});

	test("质检工具的载荷也拒绝 schema 外字段", () => {
		expect(() =>
			validateDispatchPayload("dispatch_verifier", { evidence_ids: ["a"], verifierSummary: "整体可信" }),
		).toThrow(/verifierSummary/);
	});

	test("采集工具的载荷拒绝 schema 外字段", () => {
		expect(() =>
			validateDispatchPayload("dispatch_collector", { hypothesis: "h", queries: ["q"], priorConclusion: "已证实" }),
		).toThrow(/priorConclusion/);
	});

	test("缺必填字段被拒绝", () => {
		expect(() => validateDispatchPayload("dispatch_contrarian", { evidence_ids: ["a"] })).toThrow(/claim/);
	});

	test("evidence_ids 类型错误被拒绝", () => {
		expect(() => validateDispatchPayload("dispatch_contrarian", { claim: "x", evidence_ids: "ev_1" })).toThrow(/array/);
	});

	test("数组元素类型错误被拒绝", () => {
		expect(() => validateDispatchPayload("dispatch_contrarian", { claim: "x", evidence_ids: ["ok", 42] })).toThrow(
			/数组元素/,
		);
	});

	test("非对象载荷被拒绝", () => {
		expect(() => validateDispatchPayload("dispatch_contrarian", ["claim", "evidence_ids"])).toThrow(/必须是对象/);
	});

	test("三个工具的 schema 全部是封闭对象（additionalProperties=false）", () => {
		for (const [name, schema] of Object.entries(DispatchSchemas)) {
			expect(schema.additionalProperties, `${name} 不是封闭 schema`).toBe(false);
		}
	});
});
