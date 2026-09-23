/**
 * 证据溯源层 —— appendEntry 语义的纯逻辑核心：
 *   - contentHash 去重（跨分支全局，同一内容只计一次，似然比不被重复计入）；
 *   - 子 Agent 只通过 evidence_ids 取回 rawSnippet，取不到任何评分/结论；
 *   - 持久化由 Pi 的 pi.appendEntry("evidence", data) 完成（custom entry 不进
 *     LLM 上下文）—— 本模块只维护进程内索引，session_start 时从
 *     ctx.sessionManager.getEntries() 重建。
 */
import { nowIso, sha1, truncate } from "./util.ts";
import type { EvidenceRecord, RawItem } from "./types.ts";

export interface EvidenceEntryLike {
	id: string;
	type: string;
	customType?: string;
	data?: unknown;
}

export class EvidenceIndex {
	private index = new Map<string, EvidenceRecord>();
	private hashIndex = new Map<string, string>();

	/** session_start 重建索引：扫描会话里 customType === "evidence" 的条目。 */
	rebuild(entries: Iterable<EvidenceEntryLike>): void {
		this.index.clear();
		this.hashIndex.clear();
		for (const e of entries) {
			if (e.type === "custom" && e.customType === "evidence") {
				const ev = e.data as EvidenceRecord;
				if (ev?.id && ev?.contentHash) {
					this.index.set(ev.id, ev);
					this.hashIndex.set(ev.contentHash, ev.id);
				}
			}
		}
	}

	/**
	 * 准备入库：重复 contentHash 直接返回已有 ID（去重），新内容生成 EvidenceRecord。
	 * 返回的 record 由调用方（扩展层）负责 pi.appendEntry 持久化。
	 */
	prepare(raw: RawItem): { record: EvidenceRecord; deduped: boolean } {
		const contentHash = sha1(
			`${raw.platform}::${raw.url ?? ""}::${truncate(raw.rawSnippet ?? raw.title ?? "", 2000)}`,
		);
		const existingHash = this.hashIndex.get(contentHash);
		if (existingHash) {
			return { record: this.index.get(existingHash)!, deduped: true };
		}
		const id = `ev_${sha1(`${raw.url}${raw.title}${nowIso()}${Math.random()}`).slice(0, 10)}`;
		const record: EvidenceRecord = {
			id,
			source: raw.source,
			url: raw.url,
			platform: raw.platform,
			title: raw.title,
			publishedAt: raw.publishedAt ?? null,
			author: raw.author ?? null,
			authorFeatures: {
				recentSameTopicCount: (raw.extra?.recentSameTopicCount as number) ?? null,
			},
			rawSnippet: raw.rawSnippet,
			contentHash,
			staleness: "unknown", // 质检判定后回填
			sampleSize: "unlabelled",
			channelAuthority: raw.channelAuthority,
			comments: raw.comments ?? null,
			fetchedAt: nowIso(),
		};
		this.index.set(id, record);
		this.hashIndex.set(contentHash, id);
		return { record, deduped: false };
	}

	/** 已持久化条目登记进索引（appendEntry 之后的统一入口，保证索引与会话一致）。 */
	register(record: EvidenceRecord): void {
		this.index.set(record.id, record);
		this.hashIndex.set(record.contentHash, record.id);
	}

	get(id: string): EvidenceRecord | null {
		return this.index.get(id) ?? null;
	}

	/** 派发侧解析：evidence_ids -> 原文片段（★ 子 Agent 拿到的只有原文，别无他物）。 */
	resolveRawSnippets(ids: string[]): Array<Pick<EvidenceRecord, "id" | "platform" | "title" | "publishedAt" | "author" | "rawSnippet">> {
		return ids.map((id) => {
			const ev = this.get(id);
			if (!ev) throw new Error(`evidence_id 不存在: ${id}`);
			return {
				id: ev.id,
				platform: ev.platform,
				title: ev.title,
				publishedAt: ev.publishedAt,
				author: ev.author,
				rawSnippet: ev.rawSnippet,
			};
		});
	}

	list(): EvidenceRecord[] {
		return [...this.index.values()];
	}

	size(): number {
		return this.index.size;
	}
}

/** 进程级单例：同一 pi 进程内的多个扩展文件共享同一索引（jiti 按解析路径共享模块）。 */
const globalRegistry = globalThis as { __offerlensEvidenceIndex?: EvidenceIndex };
export function sharedEvidenceIndex(): EvidenceIndex {
	if (!globalRegistry.__offerlensEvidenceIndex) {
		globalRegistry.__offerlensEvidenceIndex = new EvidenceIndex();
	}
	return globalRegistry.__offerlensEvidenceIndex;
}
