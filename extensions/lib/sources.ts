/**
 * 内容源工具层 —— 四通道 + 三级降级 + 磁盘缓存 + 限速（纯逻辑，fetch 注入可测）。
 *
 * 降级语义：通道失效不是错误，是必须显式报告的事实 —— ChannelUnavailableError
 * 由上层计入报告第 5 段「信息缺口」。
 * 不做任何反爬对抗/验证码绕过/登录态注入；小红书显式 not supported by design。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { htmlToText, stripBiliEmphasis, truncate } from "./util.ts";
import type { RawItem } from "./types.ts";
import type { OfferLensConfig as Cfg } from "./config.ts";

const execFileAsync = promisify(execFile);

export class ChannelUnavailableError extends Error {
	channel: string;
	constructor(channel: string, reason: string) {
		super(`[${channel}] 不可达: ${reason}`);
		this.name = "ChannelUnavailableError";
		this.channel = channel;
	}
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/* ---------------- 缓存与限速 ---------------- */

export class DiskCache {
	constructor(private dir: string, private ttlMs: number) {
		fs.mkdirSync(dir, { recursive: true });
	}
	private file(key: string): string {
		return path.join(this.dir, `${createHash("sha1").update(key).digest("hex")}.json`);
	}
	get<T>(key: string): T | null {
		try {
			const { at, data } = JSON.parse(fs.readFileSync(this.file(key), "utf8")) as { at: number; data: T };
			if (Date.now() - at > this.ttlMs) return null;
			return data;
		} catch {
			return null;
		}
	}
	set(key: string, data: unknown): void {
		fs.mkdirSync(path.dirname(this.file(key)), { recursive: true });
		fs.writeFileSync(this.file(key), JSON.stringify({ at: Date.now(), data }), "utf8");
	}
}

export function createRateLimiter(minIntervalMs: number): () => Promise<void> {
	let lastAt = 0;
	return async () => {
		const wait = lastAt + minIntervalMs - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lastAt = Date.now();
	};
}

/* ---------------- Bilibili（wbi 签名直连，零登录） ---------------- */

const BILI_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MIXIN_KEY_ENC_TAB = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
	14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
	21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function md5(s: string): string {
	return createHash("md5").update(s, "utf8").digest("hex");
}

function mixinKey(imgKey: string, subKey: string): string {
	const raw = imgKey + subKey;
	return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join("").slice(0, 32);
}

/** wbi 签名：参数按 key 排序、去除 !'()* 字符后 md5。 */
export function wbiSign(params: Record<string, string | number>, imgKey: string, subKey: string): { query: string; wRid: string } {
	const full = mixinKey(imgKey, subKey);
	const filtered = Object.fromEntries(
		Object.entries(params).map(([k, v]) => [k, String(v).replace(/[!'()*]/g, "")]),
	);
	const query = Object.keys(filtered)
		.sort()
		.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(filtered[k])}`)
		.join("&");
	return { query, wRid: md5(query + full) };
}

interface BiliBootstrap {
	cookie: string;
	wbi: { imgKey: string; subKey: string };
	at: number;
}

let biliCache: BiliBootstrap | null = null;

async function biliBootstrap(fetchFn: FetchLike): Promise<BiliBootstrap> {
	if (biliCache && Date.now() - biliCache.at < 3600_000) return biliCache;
	const home = await fetchFn("https://www.bilibili.com/", { headers: { "user-agent": BILI_UA, accept: "text/html" } });
	const setCookies = typeof home.headers.getSetCookie === "function" ? home.headers.getSetCookie() : [];
	const cookie = setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
	const nav = await fetchFn("https://api.bilibili.com/x/web-interface/nav", {
		headers: { "user-agent": BILI_UA, cookie, referer: "https://www.bilibili.com/" },
	});
	const navJson = (await nav.json()) as { data?: { wbi_img?: { img_url: string; sub_url: string } } };
	const img = navJson?.data?.wbi_img;
	if (!img?.img_url || !img?.sub_url) throw new Error("无法获取 wbi 密钥（nav 接口返回异常）");
	biliCache = {
		cookie,
		wbi: {
			imgKey: img.img_url.split("/").pop()?.split(".")[0] ?? "",
			subKey: img.sub_url.split("/").pop()?.split(".")[0] ?? "",
		},
		at: Date.now(),
	};
	return biliCache;
}

interface BiliSearchItem {
	aid: number;
	bvid?: string;
	arcurl?: string;
	title: string;
	description?: string;
	author: string;
	mid?: number;
	pubdate?: number;
	play?: number;
	review?: number;
	comments?: string[] | null;
}

async function biliApiSearch(fetchFn: FetchLike, cookie: string, wbi: { imgKey: string; subKey: string }, keyword: string, page: number): Promise<BiliSearchItem[]> {
	const params = { search_type: "video", keyword, page, page_size: 20, wts: Math.floor(Date.now() / 1000) };
	const { query, wRid } = wbiSign(params, wbi.imgKey, wbi.subKey);
	const res = await fetchFn(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}&w_rid=${wRid}`, {
		headers: { "user-agent": BILI_UA, cookie, referer: "https://www.bilibili.com/", accept: "application/json" },
	});
	if (!res.ok) throw new Error(`B 站搜索 HTTP ${res.status}`);
	const json = (await res.json()) as { code: number; message?: string; data?: { result?: BiliSearchItem[] } };
	if (json.code !== 0) throw new Error(`B 站搜索 API code=${json.code}${json.message ? ` (${json.message})` : ""}`);
	return Array.isArray(json.data?.result) ? json.data.result : [];
}

async function biliComments(fetchFn: FetchLike, cookie: string, aid: number, limit = 20): Promise<string[] | null> {
	try {
		const res = await fetchFn(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&ps=${limit}&sort=1`, {
			headers: { "user-agent": BILI_UA, cookie, referer: "https://www.bilibili.com/" },
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { data?: { replies?: Array<{ content?: { message?: string } }> } };
		const replies = json?.data?.replies;
		if (!Array.isArray(replies)) return null;
		return replies.map((r) => r?.content?.message).filter(Boolean).slice(0, limit) as string[];
	} catch {
		return null;
	}
}

/* ---------------- RSS（零依赖内置解析器） ---------------- */

function xmlPick(xml: string, tag: string): string | null {
	const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
	if (!m) return null;
	return m[1]
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

export function parseFeed(xml: string): Array<{ title: string; url: string | null; publishedAt: string | null; rawSnippet: string; author: string | null }> {
	const isRss = /<rss[\s\S]*?<channel/i.test(xml) || /<channel[\s\S]*?<item/i.test(xml);
	const itemTag = isRss ? "item" : "entry";
	const items: Array<{ title: string; url: string | null; publishedAt: string | null; rawSnippet: string; author: string | null }> = [];
	const blocks = xml.split(new RegExp(`<${itemTag}[\\s>]`, "i")).slice(1);
	for (const block of blocks) {
		const closed = block.split(new RegExp(`</${itemTag}>`, "i"))[0];
		const title = xmlPick(closed, "title");
		const link = xmlPick(closed, "link") ?? closed.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ?? null;
		const pubDate = xmlPick(closed, "pubDate") ?? xmlPick(closed, "published") ?? xmlPick(closed, "updated");
		const description = xmlPick(closed, "description") ?? xmlPick(closed, "summary") ?? xmlPick(closed, "content");
		if (title || link) {
			items.push({
				title: title ?? "(untitled)",
				url: link,
				publishedAt: pubDate && Date.parse(pubDate) ? new Date(pubDate).toISOString() : null,
				rawSnippet: (description ?? title ?? "").slice(0, 1200),
				author: xmlPick(closed, "author") ?? xmlPick(closed, "dc:creator"),
			});
		}
	}
	return items;
}

/* ---------------- YouTube（yt-dlp 字幕，CLI 缺失如实报告） ---------------- */

let ytdlpProbe: { ok: boolean; version?: string; reason?: string } | null = null;

export async function probeYtDlp(): Promise<{ ok: boolean; version?: string; reason?: string }> {
	if (ytdlpProbe) return ytdlpProbe;
	try {
		const { stdout } = await execFileAsync("yt-dlp", ["--version"], { timeout: 10000 });
		ytdlpProbe = { ok: true, version: stdout.trim() };
	} catch {
		ytdlpProbe = { ok: false, reason: "yt-dlp 未安装（用户环境自备，/doctor 已提示）" };
	}
	return ytdlpProbe;
}

/* ---------------- 通道注册表 ---------------- */

export interface ChannelSet {
	fetch_bilibili(keyword: string): Promise<RawItem[]>;
	fetch_web(url: string): Promise<RawItem[]>;
	fetch_rss(feedUrl: string): Promise<RawItem[]>;
	fetch_youtube(videoUrl: string): Promise<RawItem[]>;
	probe(): Promise<Array<{ channel: string; ok: boolean; detail: string }>>;
}

export function createChannels(config: Cfg, fetchImpl: FetchLike = fetch as FetchLike): ChannelSet {
	const mkCache = (sub: string) => new DiskCache(path.join(config.sources.cacheDir, sub), config.sources.cacheTtlMs);
	const maxItems = config.sources.maxItemsPerSource;

	const biliCache = mkCache("bilibili");
	const biliGate = createRateLimiter(config.sources.bilibili.minIntervalMs);
	const webCache = mkCache("web");
	const webGate = createRateLimiter(config.sources.web.minIntervalMs);
	const rssCache = mkCache("rss");
	const rssGate = createRateLimiter(config.sources.rss.minIntervalMs);

	async function fetchBilibili(keyword: string): Promise<RawItem[]> {
		const key = `bili:${keyword}`;
		const hit = biliCache.get<BiliSearchItem[]>(key);
		let items = hit;
		if (!items) {
			await biliGate();
			const { cookie, wbi } = await biliBootstrap(fetchImpl);
			items = await biliApiSearch(fetchImpl, cookie, wbi, keyword, 1);
			biliCache.set(key, items);
		}
		if (config.sources.bilibili.fetchComments) {
			for (const item of items.slice(0, 3)) {
				if (item.comments === undefined) {
					const { cookie } = await biliBootstrap(fetchImpl);
					item.comments = (await biliComments(fetchImpl, cookie, item.aid)) ?? null;
					if (item.comments !== null) biliCache.set(key, items);
				}
			}
		}
		return items.slice(0, maxItems).map((it) => ({
			source: `bilibili:${it.bvid ?? it.aid}`,
			url: it.arcurl ?? `https://www.bilibili.com/video/${it.bvid}`,
			platform: "bilibili",
			title: stripBiliEmphasis(it.title),
			rawSnippet: `${stripBiliEmphasis(it.title)}。${stripBiliEmphasis(it.description ?? "")}`,
			publishedAt: it.pubdate ? new Date(it.pubdate * 1000).toISOString() : null,
			author: it.author,
			channelAuthority: "ugc" as const,
			comments: it.comments ?? null,
			extra: { play: it.play, review: it.review },
		}));
	}

	async function fetchWeb(url: string): Promise<RawItem[]> {
		const key = `web:${url}`;
		const hit = webCache.get<{ text: string; via: string }>(key);
		let text = hit?.text;
		let via = hit?.via;
		if (text == null) {
			await webGate();
			const failures: string[] = [];
			try {
				const res = await fetchImpl(`${config.sources.web.jinaBaseUrl}${url}`, {
					headers: { "user-agent": BILI_UA, accept: "text/plain" },
					signal: AbortSignal.timeout(config.sources.fetchTimeoutMs),
				});
				if (!res.ok) throw new Error(`Jina Reader HTTP ${res.status}`);
				const t = await res.text();
				if (!t || t.length < 40) throw new Error("Jina Reader 返回内容过短");
				text = t;
				via = "jina-reader";
			} catch (e) {
				failures.push(`jina: ${(e as Error).message}`);
			}
			if (text == null) {
				try {
					const res = await fetchImpl(url, {
						headers: { "user-agent": BILI_UA, accept: "text/html,*/*" },
						signal: AbortSignal.timeout(config.sources.fetchTimeoutMs),
					});
					if (!res.ok) throw new Error(`直连 HTTP ${res.status}`);
					const contentType = res.headers.get("content-type") ?? "";
					const body = /json/i.test(contentType) ? JSON.stringify(await res.json(), null, 1) : await res.text();
					const t = /json/i.test(contentType) ? body : htmlToText(body);
					if (t.length < 40) throw new Error("直连抓取正文过短");
					text = t;
					via = "direct";
				} catch (e) {
					failures.push(`direct: ${(e as Error).message}`);
				}
			}
			if (text == null) throw new ChannelUnavailableError("web", failures.join("; "));
			webCache.set(key, { text: truncate(text, 6000), via: via! });
		}
		return [
			{
				source: `web:${url}`,
				url,
				platform: "web",
				title: truncate(url, 80),
				rawSnippet: text,
				publishedAt: null,
				author: null,
				channelAuthority: "web" as const,
				extra: { via },
			},
		];
	}

	async function fetchRss(feedUrl: string): Promise<RawItem[]> {
		const key = `rss:${feedUrl}`;
		let items = rssCache.get<Array<{ title: string; url: string | null; publishedAt: string | null; rawSnippet: string; author: string | null }>>(key);
		if (!items) {
			await rssGate();
			const res = await fetchImpl(feedUrl, {
				headers: { "user-agent": "OfferLens/0.2 (+feed reader)" },
				signal: AbortSignal.timeout(config.sources.fetchTimeoutMs),
			});
			if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
			const xml = await res.text();
			items = parseFeed(xml).slice(0, 20);
			if (!items.length) throw new Error("RSS 解析得到 0 条（格式不支持或源为空）");
			rssCache.set(key, items);
		}
		return items.slice(0, maxItems).map((it) => ({
			source: `rss:${it.url}`,
			url: it.url ?? feedUrl,
			platform: "rss",
			title: it.title,
			rawSnippet: it.rawSnippet,
			publishedAt: it.publishedAt,
			author: it.author,
			channelAuthority: "official" as const,
		}));
	}

	async function fetchYoutube(videoUrl: string): Promise<RawItem[]> {
		const key = `ytdlp:${videoUrl}`;
		const hit = rssCache.get<string>(key);
		let text = hit;
		if (text == null) {
			const probe = await probeYtDlp();
			if (!probe.ok) throw new ChannelUnavailableError("youtube", probe.reason ?? "yt-dlp 不可用");
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "offerlens-yt-"));
			try {
				const { stdout } = await execFileAsync(
					"yt-dlp",
					["--write-auto-sub", "--skip-download", "--sub-lang", "en,zh-Hans,zh", "-o", path.join(tmpDir, "sub"), videoUrl],
					{ timeout: config.sources.fetchTimeoutMs * 2 },
				);
				const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".vtt"));
				if (!files.length) throw new Error(`yt-dlp 未产出字幕（${stdout.slice(0, 120)}）`);
				const vtt = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
				text = vtt
					.split("\n")
					.filter((l) => l && !l.startsWith("WEBVTT") && !l.includes("-->") && !/^\d+$/.test(l))
					.join(" ")
					.replace(/\s+/g, " ")
					.slice(0, 6000);
				rssCache.set(key, text);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		}
		return [
			{
				source: `youtube:${videoUrl}`,
				url: videoUrl,
				platform: "youtube",
				title: truncate(videoUrl, 80),
				rawSnippet: text,
				publishedAt: null,
				author: null,
				channelAuthority: "ugc" as const,
			},
		];
	}

	async function probe(): Promise<Array<{ channel: string; ok: boolean; detail: string }>> {
		const results: Array<{ channel: string; ok: boolean; detail: string }> = [];
		const run = async (channel: string, fn: () => Promise<string>) => {
			try {
				results.push({ channel, ok: true, detail: await fn() });
			} catch (e) {
				results.push({ channel, ok: false, detail: truncate((e as Error).message, 160) });
			}
		};
		await run("bilibili", async () => {
			const items = await fetchBilibili("实习");
			return `wbi 签名搜索正常，返回 ${items.length} 条`;
		});
		await run("web", async () => {
			const items = await fetchWeb("https://example.com/");
			return `网页抓取正常（via ${items[0].extra?.via}）`;
		});
		await run("rss", async () => {
			const feed = config.sources.rss.feeds[0];
			if (!feed) throw new Error("未配置任何 feed（config.sources.rss.feeds）");
			const items = await fetchRss(feed);
			return `解析 ${feed} 得到 ${items.length} 条`;
		});
		await run("youtube", async () => {
			const p = await probeYtDlp();
			if (!p.ok) throw new Error(p.reason);
			return `yt-dlp ${p.version}`;
		});
		results.push({ channel: "xiaohongshu", ok: false, detail: "not supported by design (requires login)" });
		return results;
	}

	return {
		fetch_bilibili: (keyword: string) => fetchBilibili(keyword),
		fetch_web: (url: string) => fetchWeb(url),
		fetch_rss: (feedUrl: string) => fetchRss(feedUrl),
		fetch_youtube: (videoUrl: string) => fetchYoutube(videoUrl),
		probe,
	};
}

export type { Cfg };
