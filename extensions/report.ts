/**
 * extensions/report.ts —— 报告呈现层（Pi 扩展入口）。
 *
 * /check 的报告以 custom message 呈现（offerlens-report customType，参与 LLM
 * 上下文——主管可以就报告继续对话），渲染用 Markdown 组件；
 * /report 把最近一次报告导出为 markdown 文件。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./lib/config.ts";
import { runtime, setLastReport } from "./lib/runtime.ts";
import { ensureDir } from "./lib/util.ts";

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	pi.registerMessageRenderer("offerlens-report", (message, _options, _theme) => {
		const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return new Markdown(text, 0, 0, getMarkdownTheme());
	});

	pi.registerCommand("report", {
		description: "导出最近一次甄别报告为 markdown 文件（默认 .offerlens/reports/）",
		handler: async (args, ctx) => {
			let last = runtime().lastReport;
			if (!last) {
				// 从 reportsDir 找最新文件兜底
				if (fs.existsSync(config.reportsDir)) {
					const files = fs.readdirSync(config.reportsDir).filter((f) => f.endsWith(".md")).sort();
					if (files.length) {
						const text = fs.readFileSync(path.join(config.reportsDir, files[files.length - 1]), "utf8");
						last = { markdown: text, posterior: -1 };
						setLastReport(last);
					}
				}
			}
			if (!last) {
				ctx.ui.notify("没有可导出的报告（先运行 /check）", "error");
				return;
			}
			const target = args.trim() || path.join(config.reportsDir, `report-export-${Date.now()}.md`);
			ensureDir(path.dirname(path.resolve(ctx.cwd, target)));
			fs.writeFileSync(path.resolve(ctx.cwd, target), last.markdown, "utf8");
			ctx.ui.notify(`报告已导出: ${target}`, "info");
		},
	});
}
