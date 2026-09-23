/**
 * LLM 主管路径的共享运行态（同一 pi 进程内单例）。
 *
 * 背景：/check 在真实模型下由主管 LLM 驱动，按"采集→登记→质检→反方→出报告"逐步调用工具。
 * 每一步把产物累积到这里，finalize_report 再用**确定性尾段**（置信度引擎 + 5 段报告契约）收尾，
 * 从而"主管是 LLM、但算分与报告仍是代码"。占位/程序化路径不经过这里（它有自己的局部状态）。
 */
import { planHypotheses, verdict } from "./roles.ts";
import type { Assessment, ContrarianResult, DegradedChannel, Hypothesis, RawItem, VerifierResult } from "./types.ts";

export interface BranchState {
	hypothesis: Hypothesis;
	newEvidenceIds: string[];
	assessments: Assessment[];
	corpus?: VerifierResult["corpus"];
	contrarian: ContrarianResult | null;
	degraded: DegradedChannel[];
	state: string;
}

export interface PendingCollection {
	items: RawItem[];
	degraded: DegradedChannel[];
}

export interface RunState {
	question: string;
	claim: string;
	startedAt: number;
	branches: Map<string, BranchState>;
	/** evidence id → 所属分支 slug，供质检/反方工具反查分支。 */
	branchOfId: Map<string, string>;
	/**
	 * 采集产物暂存：collector 的原始条目**不经过主管 LLM 的手**，只回一个句柄给它。
	 * 否则主管要把上万字符的证据原样重打进 register_evidence 的参数里——
	 * 实测那一步占掉整轮模型输出的 91%（11,245 / 12,318 字符），纯粹是机械复读。
	 */
	collections: Map<string, PendingCollection>;
}

const registry = globalThis as { __offerlensRunState?: RunState | null };

export function resetRun(question: string, claim: string): RunState {
	const plan = planHypotheses(question, claim === question ? null : claim, null);
	const branches = new Map<string, BranchState>();
	for (const h of plan.hypotheses) {
		branches.set(h.slug, {
			hypothesis: h,
			newEvidenceIds: [],
			assessments: [],
			contrarian: null,
			degraded: [],
			state: "open",
		});
	}
	const st: RunState = {
		question,
		claim,
		startedAt: Date.now(),
		branches,
		branchOfId: new Map(),
		collections: new Map(),
	};
	registry.__offerlensRunState = st;
	return st;
}

export function runState(): RunState {
	const st = registry.__offerlensRunState;
	if (!st) throw new Error("OfferLens 运行态未初始化：先调用 begin_check");
	return st;
}

export function hasRunState(): boolean {
	return !!registry.__offerlensRunState;
}

export function clearRunState(): void {
	registry.__offerlensRunState = null;
}

/** 登记一批证据到某分支：记录 id→branch 归属。调用方负责 appendEntry + index.register。 */
export function recordEvidence(branch: string, ids: string[]): BranchState {
	const st = runState();
	const b = st.branches.get(branch);
	if (!b) throw new Error(`未知分支 ${branch}（begin_check 生成的分支为：${[...st.branches.keys()].join(", ")}）`);
	for (const id of ids) {
		st.branchOfId.set(id, branch);
		if (!b.newEvidenceIds.includes(id)) b.newEvidenceIds.push(id);
	}
	return b;
}

/** 质检产物并入分支（按 evidence_ids 反查分支），并用确定性裁决规则更新状态。 */
export function recordVerifier(assessments: Assessment[], corpus: VerifierResult["corpus"]): string[] {
	const st = runState();
	const touched = new Set<string>();
	for (const a of assessments) {
		const br = st.branchOfId.get(a.id);
		if (!br) continue;
		const b = st.branches.get(br)!;
		if (!b.assessments.some((x) => x.id === a.id)) b.assessments.push(a);
		b.corpus = corpus;
		touched.add(br);
	}
	for (const br of touched) {
		const b = st.branches.get(br)!;
		b.state = verdict(br, { evidenceCount: b.newEvidenceIds.length, corpus: b.corpus });
	}
	return [...touched];
}

/** 反方产物并入分支：反方工具知道它收到的 evidence_ids，据此反查所属分支。 */
export function recordContrarian(evidenceIds: string[], result: ContrarianResult): string | null {
	const st = runState();
	const branch = evidenceIds.map((id) => st.branchOfId.get(id)).find((b): b is string => !!b) ?? null;
	if (branch) st.branches.get(branch)!.contrarian = result;
	return branch;
}

/** 采集产物留在扩展侧，只给主管一个句柄。 */
export function stashCollection(items: RawItem[], degraded: DegradedChannel[]): string {
	const st = runState();
	const handle = `col_${st.collections.size + 1}`;
	st.collections.set(handle, { items, degraded });
	return handle;
}

/** 按句柄取回采集产物；未知句柄直接报错，不静默当空集（那会把一次采集失败洗成"没有证据"）。 */
export function getCollection(handle: string): PendingCollection {
	const st = runState();
	const found = st.collections.get(handle);
	if (!found) {
		throw new Error(`未知采集句柄 ${handle}（本轮已暂存：${[...st.collections.keys()].join(", ") || "无"}）`);
	}
	return found;
}
