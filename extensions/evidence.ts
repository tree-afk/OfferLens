/**
 * extensions/evidence.ts —— 证据溯源层（Pi 扩展入口）。
 *
 * ★ appendEntry 语义：证据以 customType="evidence" 写入会话 JSONL，
 *   **不进 LLM 上下文**——这正是它的设计目的：可审计、可按 ID 取回，
 *   但不污染推理上下文（否则 20 条证据全文进上下文，又回到确认偏误）。
 *   证据与会话树同一份 JSONL，天然随会话持久化。
 *
 * session_start 重建索引 + registerEntryRenderer 渲染证据卡片（TUI 可展开原文）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { sharedEvidenceIndex } from "./lib/evidence.ts";
import type { EvidenceRecord } from "./lib/types.ts";

export default function (pi: ExtensionAPI) {
	const index = sharedEvidenceIndex();

	// session_start：从会话 JSONL 重建证据索引（含跨进程重启；运行期登记由
	// hypotheses/isolation 在 appendEntry 后调用 index.register 完成）
	pi.on("session_start", async (_event, ctx) => {
		index.rebuild(
			ctx.sessionManager.getEntries().map((e) => ({
				id: e.id,
				type: e.type,
				customType: (e as { customType?: string }).customType,
				data: (e as { data?: unknown }).data,
			})),
		);
	});

	// TUI 证据卡片：折叠显示元数据，展开显示原文片段（可审计性的一等公民）
	pi.registerEntryRenderer("evidence", (entry, { expanded }, theme) => {
		const ev = entry.data as EvidenceRecord;
		const box = new Box(1, 0, (text: string) => theme.bg("customMessageBg", text));
		const head =
			`📄 ${theme.bold(String(ev.title ?? ev.url).slice(0, 72))}` +
			`\n   ${ev.platform} · ${ev.publishedAt?.slice(0, 10) ?? "时间未知"} · ${ev.author ?? "未知"} · ${ev.id} · ${ev.channelAuthority}`;
		box.addChild(new Text(theme.fg("dim", head), 0, 0));
		if (expanded) {
			box.addChild(new Text(theme.fg("dim", `   ${(ev.rawSnippet ?? "").slice(0, 500)}`), 0, 0));
		}
		return box;
	});
}
