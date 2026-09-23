/**
 * 内容源工具层测试（迁移自 test/sources.test.js → vitest + 注入式 fetch）。
 *
 * 全部测试注入假 fetch：不访问真实网络。覆盖三级降级、磁盘缓存、RSS 解析、wbi 签名确定性。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { OfferLensConfig } from "../extensions/lib/config.ts";
import {
	ChannelUnavailableError,
	createChannels,
	createRateLimiter,
	DiskCache,
	type FetchLike,
	parseFeed,
	wbiSign,
} from "../extensions/lib/sources.ts";

function tmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 测试配置：缓存落到临时目录，限速归零，不抓评论（避免额外网络调用）。 */
function testConfig(cacheDir: string): OfferLensConfig {
	return {
		dispatchMode: "stub",
		subagentRetries: 2,
		sources: {
			cacheTtlMs: 60_000,
			cacheDir,
			maxItemsPerSource: 6,
			fetchTimeoutMs: 3_000,
			bilibili: { enabled: true, minIntervalMs: 0, maxPages: 1, fetchComments: false },
			web: { enabled: true, minIntervalMs: 0, jinaBaseUrl: "https://r.jina.ai/" },
			rss: { enabled: true, minIntervalMs: 0, feeds: [] },
			youtube: { enabled: true, minIntervalMs: 0 },
		},
		calibration: { priorLogodds: 0, sensitivityDeltaThreshold: 0.2, contrarianAdjustmentCap: { min: 0.2, max: 5 } },
		reportsDir: cacheDir,
		sessionDir: cacheDir,
		web: { host: "127.0.0.1", port: 0 },
	};
}

const LONG_HTML = `<html><body><article>${"正文内容 ".repeat(50)}</article></body></html>`;

describe("sources / web 三级降级", () => {
	test("jina 失败 → 直连成功（via=direct，两次调用）", async () => {
		let calls = 0;
		const channels = createChannels(testConfig(tmpDir("ol-web-")), (async (url: string) => {
			calls += 1;
			if (String(url).startsWith("https://r.jina.ai/")) throw new Error("fetch failed");
			return new Response(LONG_HTML, { status: 200, headers: { "content-type": "text/html" } });
		}) as FetchLike);

		const items = await channels.fetch_web("https://example.com/x");
		expect(calls).toBe(2);
		expect(items).toHaveLength(1);
		expect(items[0].extra?.via).toBe("direct");
		expect(items[0].channelAuthority).toBe("web");
	});

	test("jina 与直连全失败 → ChannelUnavailableError（不可达是事实不是崩溃）", async () => {
		const channels = createChannels(testConfig(tmpDir("ol-web2-")), (async () => {
			throw new Error("fetch failed");
		}) as FetchLike);
		await expect(channels.fetch_web("https://example.com/x")).rejects.toBeInstanceOf(ChannelUnavailableError);
	});

	test("降级失败的错误信息聚合了两级原因", async () => {
		const channels = createChannels(testConfig(tmpDir("ol-web3-")), (async () => {
			throw new Error("network down");
		}) as FetchLike);
		await expect(channels.fetch_web("https://example.com/x")).rejects.toThrow(/jina.*direct|direct.*jina/s);
	});

	test("磁盘缓存命中时不发网络请求", async () => {
		let calls = 0;
		const channels = createChannels(testConfig(tmpDir("ol-web4-")), (async () => {
			calls += 1;
			return new Response(LONG_HTML, { status: 200, headers: { "content-type": "text/html" } });
		}) as FetchLike);

		await channels.fetch_web("https://example.com/c");
		const afterFirst = calls;
		await channels.fetch_web("https://example.com/c");
		expect(calls).toBe(afterFirst); // 第二次走缓存
	});
});

describe("sources / rss", () => {
	test("内置解析器：RSS2.0 与 Atom 都能解析", () => {
		const rssXml = `<rss><channel><item><title><![CDATA[公告一]]></title><link>https://a/1</link><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate><description>招聘公告正文</description></item></channel></rss>`;
		const atomXml = `<feed><entry><title>公告二</title><link href="https://a/2"/><published>2026-09-02T10:00:00Z</published><summary>摘要</summary></entry></feed>`;
		const a = parseFeed(rssXml);
		const b = parseFeed(atomXml);
		expect(a[0].title).toBe("公告一");
		expect(a[0].url).toBe("https://a/1");
		expect(b[0].title).toBe("公告二");
		expect(b[0].url).toBe("https://a/2");
	});

	test("fetched via injected fetch：channelAuthority=official（最高可信权重）", async () => {
		const xml = `<rss><channel><item><title>2027 届校招启动</title><link>https://a/1</link><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate><description>官方公告正文内容</description></item></channel></rss>`;
		const channels = createChannels(
			testConfig(tmpDir("ol-rss-")),
			(async () => new Response(xml, { status: 200, headers: { "content-type": "application/xml" } })) as FetchLike,
		);

		const items = await channels.fetch_rss("https://a/feed.xml");
		expect(items.length).toBeGreaterThan(0);
		expect(items[0].channelAuthority).toBe("official");
		expect(items[0].title).toContain("校招");
	});

	test("RSS HTTP 失败 → 抛出（由上层计入信息缺口）", async () => {
		const channels = createChannels(
			testConfig(tmpDir("ol-rss2-")),
			(async () => new Response("nope", { status: 500 })) as FetchLike,
		);
		await expect(channels.fetch_rss("https://a/feed.xml")).rejects.toThrow(/500/);
	});

	test("无 item 的 feed → 空数组（不是崩溃）", () => {
		expect(parseFeed("<rss><channel></channel></rss>")).toEqual([]);
		expect(parseFeed("不是 XML")).toEqual([]);
	});
});

describe("sources / 基础设施", () => {
	test("DiskCache：写入后可读回，TTL 过期后失效", () => {
		const cache = new DiskCache(tmpDir("ol-cache-"), 60_000);
		cache.set("k", { hello: "world" });
		expect(cache.get<{ hello: string }>("k")?.hello).toBe("world");
		expect(cache.get("missing")).toBeNull();

		const expired = new DiskCache(tmpDir("ol-cache-exp-"), -1);
		expired.set("k", { hello: "world" });
		expect(expired.get("k")).toBeNull();
	});

	test("DiskCache：损坏文件静默降级为未命中（坏缓存不拖垮运行）", () => {
		const dir = tmpDir("ol-cache-bad-");
		const cache = new DiskCache(dir, 60_000);
		cache.set("k", { a: 1 });
		const file = fs.readdirSync(dir)[0];
		fs.writeFileSync(path.join(dir, file), "{ 不是合法 JSON", "utf8");
		expect(cache.get("k")).toBeNull();
	});

	test("createRateLimiter：串行调用被节流，间隔不小于设定值", async () => {
		const gate = createRateLimiter(30);
		const t0 = Date.now();
		await gate();
		await gate();
		expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
	});

	test("createRateLimiter(0) 不引入等待", async () => {
		const gate = createRateLimiter(0);
		const t0 = Date.now();
		await gate();
		await gate();
		expect(Date.now() - t0).toBeLessThan(20);
	});

	test("wbi 签名确定性：同参数同密钥 → 同 w_rid，且为 32 位十六进制", () => {
		const imgKey = "7cd084941338484aae1ad9425b84077c";
		const subKey = "4932caff0ff746eab6f01bf08b70ac45";
		const params = { keyword: "实习", wts: 1700000000 };
		const a = wbiSign(params, imgKey, subKey);
		const b = wbiSign({ ...params }, imgKey, subKey);
		expect(a.wRid).toBe(b.wRid);
		expect(a.wRid).toMatch(/^[0-9a-f]{32}$/);
		// 契约：query 只含排序后的参数串，w_rid 由调用方拼接（`?${query}&w_rid=${wRid}`）
		expect(a.query).toBe(b.query);
		expect(a.query).toMatch(/^keyword=/);
		expect(a.query).not.toContain("w_rid");
	});

	test("wbi 签名对参数变化敏感（不同关键词 → 不同签名）", () => {
		const imgKey = "7cd084941338484aae1ad9425b84077c";
		const subKey = "4932caff0ff746eab6f01bf08b70ac45";
		expect(wbiSign({ keyword: "实习" }, imgKey, subKey).wRid).not.toBe(
			wbiSign({ keyword: "校招" }, imgKey, subKey).wRid,
		);
	});
});
