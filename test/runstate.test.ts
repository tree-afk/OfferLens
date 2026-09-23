/**
 * runstate 的采集暂存：证据原文走扩展侧句柄，不经主管 LLM 的手。
 *
 * 被验的分支：句柄往返、句柄递增、未知句柄 fail-closed、resetRun 清空、
 * 以及"零条目但有降级"这一采集全不可达场景仍能被登记。
 */
import { describe, expect, it } from "vitest";
import { getCollection, resetRun, runState, stashCollection } from "../extensions/lib/runstate.ts";
import type { DegradedChannel, RawItem } from "../extensions/lib/types.ts";

function item(url: string, title = "t"): RawItem {
	return {
		source: `bilibili:${url}`,
		url,
		platform: "bilibili",
		title,
		rawSnippet: `${title}。`,
		publishedAt: "2026-09-01T00:00:00.000Z",
		author: "a",
		channelAuthority: "ugc",
		comments: null,
	};
}

const degraded: DegradedChannel[] = [{ channel: "bilibili", query: "字节 实习", reason: "TypeError: fetch failed" }];

describe("stashCollection / getCollection", () => {
	it("句柄往返取回原条目与降级记录，主管无需重传内容", () => {
		resetRun("q", "claim");
		const items = [item("http://www.bilibili.com/video/av1"), item("http://www.bilibili.com/video/av2")];
		const handle = stashCollection(items, degraded);

		expect(handle).toBe("col_1");
		const back = getCollection(handle);
		expect(back.items).toEqual(items);
		expect(back.degraded).toEqual(degraded);
	});

	it("多次采集得到互不冲突的句柄", () => {
		resetRun("q", "claim");
		const h1 = stashCollection([item("http://www.bilibili.com/video/av1")], []);
		const h2 = stashCollection([item("http://www.bilibili.com/video/av2")], []);

		expect([h1, h2]).toEqual(["col_1", "col_2"]);
		expect(getCollection(h1).items[0].url).toBe("http://www.bilibili.com/video/av1");
		expect(getCollection(h2).items[0].url).toBe("http://www.bilibili.com/video/av2");
	});

	it("未知句柄直接报错并列出已知句柄，不静默当空集", () => {
		resetRun("q", "claim");
		stashCollection([item("http://www.bilibili.com/video/av1")], []);

		expect(() => getCollection("col_9")).toThrow(/未知采集句柄 col_9/);
		expect(() => getCollection("col_9")).toThrow(/暂存：col_1/);
	});

	it("全通道不可达（零条目 + 有降级）仍可被句柄取回并登记", () => {
		resetRun("q", "claim");
		const handle = stashCollection([], degraded);

		const back = getCollection(handle);
		expect(back.items).toHaveLength(0);
		expect(back.degraded).toHaveLength(1);
	});

	it("resetRun 清空上一轮的句柄", () => {
		resetRun("q", "claim");
		stashCollection([item("http://www.bilibili.com/video/av1")], []);
		expect(runState().collections.size).toBe(1);

		resetRun("q2", "claim2");
		expect(runState().collections.size).toBe(0);
		expect(() => getCollection("col_1")).toThrow(/col_1/);
	});
});
