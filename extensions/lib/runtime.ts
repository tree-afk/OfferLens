/** 扩展间共享的运行时引用（同一 pi 进程内）。 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChannelSet } from "./sources.ts";

const registry = globalThis as {
	__offerlensRuntime?: {
		pi: ExtensionAPI;
		channels: ChannelSet;
		/** 最近一次 /check 的结果（/report 导出用）。 */
		lastReport?: { markdown: string; posterior: number };
	};
};

export function setRuntime(pi: ExtensionAPI, channels: ChannelSet): void {
	if (registry.__offerlensRuntime?.pi === pi) return;
	registry.__offerlensRuntime = { ...(registry.__offerlensRuntime ?? {}), pi, channels } as never;
}

export function runtime(): {
	pi: ExtensionAPI;
	channels: ChannelSet;
	lastReport?: { markdown: string; posterior: number };
} {
	if (!registry.__offerlensRuntime) throw new Error("OfferLens runtime 未初始化（extension 加载顺序错误）");
	return registry.__offerlensRuntime;
}

export function setLastReport(r: { markdown: string; posterior: number }): void {
	if (registry.__offerlensRuntime) registry.__offerlensRuntime.lastReport = r;
}

export type { ExtensionContext };
