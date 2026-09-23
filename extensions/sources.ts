/**
 * extensions/sources.ts —— 内容源工具层注册（Pi 扩展入口）。
 *
 * 注册四个 fetch_* 工具（供采集 Agent 在自己的进程里调用）、OfferLens 占位
 * Provider（"专家背后的模型"占位，未接入任何 LLM API）、/doctor 通道自检。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./lib/config.ts";
import { createChannels, type ChannelUnavailableError } from "./lib/sources.ts";
import { truncate } from "./lib/util.ts";
import { getPlaceholderProvider } from "./lib/provider-placeholder.ts";
import { setRuntime } from "./lib/runtime.ts";
import type { RawItem } from "./lib/types.ts";

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const channels = createChannels(config);
	setRuntime(pi, channels);

	// 占位 Provider：dispatchMode=subagent 时，子 pi 进程以该模型运行角色逻辑。
	// 真实模型接入后切换 --model 即绕过它，编排层零改动。
	pi.registerProvider(getPlaceholderProvider().provider);

	const mkFetchTool = (
		name: string,
		label: string,
		description: string,
		run: (args: Record<string, string>) => Promise<RawItem[]>,
	) => {
		pi.registerTool({
			name,
			label,
			description,
			parameters: Type.Object({
				keyword_or_url: Type.String({ description: "查询关键词（bilibili/rss 源）或 URL（web/youtube 源）" }),
			}),
			async execute(_id, params) {
				try {
					const items = await run({ keyword_or_url: params.keyword_or_url });
					return { content: [{ type: "text" as const, text: JSON.stringify(items) }], details: { count: items.length, degraded: false } };
				} catch (e) {
					// 通道不可达是结构化事实（计入信息缺口），不是崩溃
					const err = e as ChannelUnavailableError | Error;
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ error: `${err.name}: ${err.message}` }) }],
						details: { count: 0, degraded: true },
						isError: false,
					};
				}
			},
		});
	};

	mkFetchTool("fetch_bilibili", "B站搜索", "搜索 B 站视频（UGC 主力源，wbi 签名直连公开 API，零登录）", (a) => channels.fetch_bilibili(a.keyword_or_url));
	mkFetchTool("fetch_web", "网页抓取", "抓取网页正文（Jina Reader → 直连抓取，三级降级）", (a) => channels.fetch_web(a.keyword_or_url));
	mkFetchTool("fetch_rss", "RSS解析", "解析 RSS/Atom 官方公告源（channelAuthority=official，最高可信权重）", (a) => channels.fetch_rss(a.keyword_or_url));
	mkFetchTool("fetch_youtube", "YouTube字幕", "取 YouTube 视频字幕（yt-dlp，未安装则如实降级）", (a) => channels.fetch_youtube(a.keyword_or_url));

	pi.registerCommand("doctor", {
		description: "OfferLens 通道自检：逐条探测四个内容源 + 显式声明小红书不做 + 当前派发模式",
		handler: async (_args, ctx) => {
			const lines = ["OfferLens 通道自检", "================="];
			for (const r of await channels.probe()) {
				lines.push(`  ${r.ok ? "✓" : "✗"} ${r.channel.padEnd(12)} ${r.detail}`);
			}
			lines.push(`  • dispatchMode  ${config.dispatchMode}（stub=占位模型进程内执行；subagent=派发子 pi 进程）`);
			const missing = await missingAgents(ctx.cwd);
			if (missing.length) {
				lines.push(`  ⚠ 角色定义缺失: ${missing.join(", ")} —— 运行 /offerlens-setup 同步 agents/*.md 到 .pi/agents/`);
			} else {
				lines.push(`  ✓ agents        collector / verifier / contrarian 已就位（.pi/agents/）`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

/** 检查项目 .pi/agents/ 下是否有三个角色定义。 */
export async function missingAgents(cwd: string): Promise<string[]> {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const dir = path.join(cwd, ".pi", "agents");
	const roles = ["collector", "verifier", "contrarian"];
	if (!fs.existsSync(dir)) return roles;
	return roles.filter((r) => !fs.existsSync(path.join(dir, `${r}.md`)));
}

export { truncate };
