/** 通用工具（零依赖）。 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha1(text: string): string {
	return createHash("sha1").update(String(text), "utf8").digest("hex");
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(text: unknown, max = 400): string {
	const s = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return s.length <= max ? s : s.slice(0, max) + "…";
}

const BLOCK_RE = /<(script|style|noscript)[\s\S]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;

/** 朴素 HTML→正文抽取（零依赖降级通道用；不追求可读性指标，只保证原文可审计）。 */
export function htmlToText(html: string): string {
	return String(html ?? "")
		.replace(BLOCK_RE, " ")
		.replace(TAG_RE, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

export function stripBiliEmphasis(title: string): string {
	return String(title ?? "").replace(/<em[^>]*>|<\/em>/g, "");
}

export function ensureDir(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** 包根目录（extensions/lib 的上两级）。 */
export function packageRoot(): string {
	return path.resolve(import.meta.dirname, "..", "..");
}

export function readJsonIfExists<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}
