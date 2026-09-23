# OfferLens 迁移计划：从独立 JS 应用到 Pi 包

> **本文档的目标读者**：执行迁移的 AI 模型或开发者。
> **前提**：当前代码（`src/` 下的 JavaScript 实现）功能逻辑已基本完成，但形态是独立 CLI 应用，不是 Pi 包。本计划覆盖两件事：① 把现有功能迁移为真正的 Pi 包（`pi install ./` 可安装）；② 补齐原计划文档（`grounded-tide-robin.md`）中尚未实现的部分。
> **Pi 框架**：`@earendil-works/pi-coding-agent`（MIT，v0.84.4）。Pi 源码参考路径：`C:\Users\86186\Documents\Qoder\2026-09-02\9fc6ad4b\pi-src\packages\coding-agent\`

---

## 一、当前状态评估

### 已完成（功能逻辑层，需迁移而非重写）

| 模块 | 当前文件 | 状态 | 迁移目标 |
|---|---|---|---|
| 编排器（Tree-of-Hypotheses） | `src/core/orchestrator.js` | 完整：假设规划→分支→派发→裁决→聚合→报告 | `extensions/hypotheses.ts` |
| Schema 强制隔离 | `src/core/schema.js` | 完整：三个封闭 schema + fail-closed 校验 | `extensions/isolation.ts` |
| 子 Agent 派发 | `src/core/dispatcher.js` + `src/agents/runner.js` | 完整：spawn 子进程 + tmp 文件载荷 | vendor Pi subagent 扩展后改写 |
| 占位模型桩 | `src/agents/stubs.js` | 完整：采集/质检/反方三个确定性桩 | 保留为 Pi 扩展的工具实现 |
| Provider 抽象 | `src/core/provider.js` | 完整：placeholder + openai-compatible | **删除**——Pi 提供模型管理 |
| 会话树 | `src/session/tree.js` | 完整：JSONL append-only + label 状态机 | **删除**——Pi 的 SessionManager 替代 |
| 证据存储 | `src/evidence/store.js` | 完整：contentHash 去重 + appendEntry 语义 | `extensions/evidence.ts`（用 Pi 的 `pi.appendEntry`） |
| 特征抽取 | `src/evidence/features.js` | 完整：确定性规则 | 保留为工具函数，移入 extensions |
| 置信度引擎 | `src/calibration/calibration.js` | 完整：log-odds + tanh 饱和 + 敏感性分析 | `extensions/calibration.ts` |
| 5 段报告 | `src/report/report.js` | 完整：第 5 段强制校验 | `extensions/report.ts` |
| 内容源工具层 | `src/sources/*.js`（6 个文件） | 完整：4 通道 + 三级降级 + 磁盘缓存 | `extensions/sources.ts` |
| /doctor 自检 | `src/sources/index.js` 内的 `runDoctor` | 完整 | `extensions/doctor.ts` |
| Web SSE 前端 | `web/server.js` + `web/static/index.html` | 完整 | 保留，适配 Pi SDK |
| CLI 入口 | `src/index.js` | 完整：check/scan/doctor/tree/isolation-demo/web | **删除**——Pi 提供 CLI/TUI |
| Agent 角色定义 | `agents/collector.md` `verifier.md` `contrarian.md` | 完整：YAML frontmatter | 保留，安装时复制到 `.pi/agents/` |
| Prompt 模板 | `prompts/check.md` `scan.md` | 完整 | 保留，纳入 `pi` manifest |
| 配置 | `config/config.json` `likelihood-ratios.json` | 完整 | 保留，作为扩展运行时配置 |
| 测试 | `test/*.test.js`（5 个文件） | 完整：覆盖核心模块 | 迁移为 vitest + Pi faux provider |

### 尚未实现（原计划中的缺失项）

| 缺失项 | 原计划位置 | 说明 |
|---|---|---|
| Pi 包形态 | 第一节 | `package.json` 没有 `pi` manifest、没有 `peerDependencies` |
| `extensions/` 目录 | 第一节 | 不存在——所有功能在 `src/` 下 |
| TypeScript | 排期前提 | 全部是 JS，Pi 是 TS 生态 |
| vendor subagent 扩展 | 第四节 | 未从 Pi 源码 vendor `examples/extensions/subagent/` |
| `HYPOTHESIS_ABANDON_PROMPT` | 第三节 ① | 当前 `buildAbandonSummary()` 是硬编码字符串拼接，不是 Pi `navigateTree` 的 `customInstructions` |
| `registerEntryRenderer` | 第三节 ③ | 未实现——TUI 里没有证据卡片渲染 |
| 定性对照演示 | 第十一节 | 未做：同一输入跑有/无反方两遍，并排展示第 3 段 |
| README 诚信边界 | 第十节 | 当前 README 没有上游致谢与诚信边界段 |
| 简历 bullet 定稿 | 第十二节 | 未定稿 |
| asciinema 录屏脚本 | 第十一节 | 未写 |
| Web SSE 用 Pi SDK | 第六节 | 当前 `web/server.js` 直接调 Orchestrator，不用 Pi SDK 的 `createAgentSession` / `session.subscribe` / `createEventBus` |

---

## 二、迁移总体原则

1. **不重写功能逻辑，只做形态转换**。当前 `src/` 下的编排、schema、置信度、报告等模块的逻辑是正确的，迁移是把它们从"自己搭的架子"搬到"Pi 提供的架子"上。
2. **删除所有 Pi 已提供的自建替代**：CLI（`src/index.js`）、会话树（`src/session/tree.js`）、模型管理（`src/core/provider.js`）、子进程派发（`src/core/dispatcher.js` + `src/agents/runner.js`）。这些代码的设计初衷就是"模型占位期的临时替代"（代码注释里明确写了），现在要切回 Pi 内核。
3. **保留所有 Pi 不提供的自建贡献**：schema 强制隔离、置信度引擎、特征抽取、报告契约、内容源工具层、假设裁决逻辑。这些是真实贡献区。
4. **语言转换为 TypeScript**。Pi 是 TS，扩展经 jiti 加载，`.ts` 文件无需编译步骤。
5. **测试框架从 `node:test` 迁移到 `vitest`**，配 Pi 的 faux provider（`packages/ai/src/providers/faux.ts`），不需要真实 API key。

---

## 三、目录结构变更（当前 → 目标）

```
当前：                              目标：
offerlens/                          offerlens/
├── package.json (独立 CLI)          ├── package.json (Pi 包 manifest)
├── src/                             ├── extensions/
│   ├── index.js (CLI 入口) ← 删     │   ├── sources.ts        ← src/sources/*.js 合并
│   ├── config.js                    │   ├── evidence.ts       ← src/evidence/store.js + features.js
│   ├── util.js                      │   ├── hypotheses.ts     ← src/core/orchestrator.js 核心
│   ├── agents/                      │   ├── isolation.ts      ← src/core/schema.js
│   │   ├── runner.js ← 删           │   ├── calibration.ts    ← src/calibration/calibration.js
│   │   └── stubs.js                 │   ├── report.ts         ← src/report/report.js
│   ├── calibration/                 │   └── doctor.ts         ← src/sources/index.js 的 runDoctor
│   ├── core/                        │
│   │   ├── dispatcher.js ← 删       ├── agents/ (保留)
│   │   ├── orchestrator.js          ├── prompts/ (保留)
│   │   ├── provider.js ← 删         ├── config/ (保留)
│   │   └── schema.js                ├── extensions/
│   ├── evidence/                    │   └── subagent/         ← vendor from Pi examples
│   ├── report/                      ├── web/ (保留，适配 Pi SDK)
│   ├── session/                     ├── test/ (迁移为 vitest)
│   │   └── tree.js ← 删            └── package.json
│   └── sources/
├── agents/
├── prompts/
├── config/
├── test/
└── web/
```

---

## 四、分步迁移详细

### 步骤 1：`package.json` 转换为 Pi 包格式

**当前**（`package.json`）：
```json
{
  "name": "offerlens",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "keywords": ["offerlens", "multi-agent", "verification", "career"],
  "license": "MIT"
}
```

**目标**：
```jsonc
{
  "name": "offerlens",
  "version": "0.2.0",
  "description": "校招/实习信息多智能体甄别助手 —— 基于 Pi 的 Pi 包",
  "type": "module",
  "keywords": ["pi-package"],          // ★ Pi 包标识，pi install 靠这个发现
  "pi": {
    "extensions": ["./extensions"],     // ★ 扩展加载路径
    "prompts": ["./prompts"]            // ★ /check /scan 命令预设
  },
  "peerDependencies": {                 // ★ Pi 核心包，"*" 范围，不能 bundle
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "dependencies": {
    "rss-parser": "^3.x"               // ★ 唯一运行时依赖
  },
  "devDependencies": {
    "vitest": "^3.x"
  },
  "license": "MIT",
  "engines": { "node": ">=20" }
}
```

**关键变化**：
- `"keywords": ["pi-package"]` —— Pi 包发现机制靠这个 keyword
- `"pi"` manifest —— 声明扩展和 prompt 的加载路径
- `peerDependencies` 用 `"*"` —— 按 `docs/packages.md:171` 的要求
- 不再 `"private": true` —— Pi 包需要可被 `pi install`
- 删除所有 `scripts` —— Pi 提供 CLI，不需要 `npm start`

---

### 步骤 2：删除 Pi 已提供的自建模块

以下文件/模块要**完全删除**，因为 Pi 内核已经提供等价能力：

| 删除 | 原因 | Pi 替代 |
|---|---|---|
| `src/index.js` | 自建 CLI | Pi 的 CLI/TUI + `pi.registerCommand` |
| `src/session/tree.js` | 自建会话树 | Pi 的 `SessionManager`（JSONL append-only、`getTree()`/`branch()`/`setLabel()`/`branchWithSummary()` 全有） |
| `src/core/provider.js` | 自建模型管理 | Pi 的模型/凭据管理（`pi` 进程自带模型切换） |
| `src/core/dispatcher.js` | 自建子进程派发 | vendor 后的 Pi subagent 扩展（`spawn pi --mode json -p --no-session`） |
| `src/agents/runner.js` | 子进程入口桩 | 不再需要——Pi subagent 就是完整的 `pi` 进程 |
| `src/config.js` | 自建配置加载 | 保留为扩展内部配置工具（`config/config.json` 仍然需要），但不再管理模型配置 |

**注意**：`src/agents/stubs.js` 不删。它的三个桩函数（`collectorStub`、`verifierStub`、`contrarianStub`）包含真实的业务逻辑（内容源调用、特征抽取、反方论证构造），要迁移到 extensions 里作为工具实现。

---

### 步骤 3：Vendor Pi Subagent 扩展

从 Pi 源码 vendor subagent 扩展到 `extensions/subagent/`：

```bash
# 源文件位置（已确认在工作区）
cp -r "C:\Users\86186\Documents\Qoder\2026-09-02\9fc6ad4b\pi-src\packages\coding-agent\examples\extensions\subagent" \
      ./extensions/subagent
```

**vendor 后需要改的三处**（计划文档第四节说明了 vendor 而非 symlink 的理由）：

1. **Windows spawn 兼容**：`index.ts:250-259` 的 `process.execPath` + `process.argv[1]` 逻辑需要验证在 win32 上行为正确。当前 `src/core/dispatcher.js` 已经处理了 Windows 兼容（`windowsHide: true`、不依赖 `argv[1]` 自举），这些经验要带入 vendor 版本。

2. **发 evidence 事件**：subagent 返回结果后，主管侧需要把证据写入 `pi.appendEntry` 并发 SSE 事件。当前 `src/core/orchestrator.js:241-251` 的逻辑要在 vendor 版本的回调里实现。

3. **假设树集成**：subagent 的结果要回写到 Pi 的会话树分支上（`setLabel`、`appendSummary`），这需要在 subagent 完成回调里调用 Pi 的树 API。

**README 里必须注明**：`extensions/subagent/` 衍生自 Pi 的 `examples/extensions/subagent/`（MIT）。

---

### 步骤 4：`extensions/isolation.ts` —— Schema 强制隔离

**来源**：`src/core/schema.js`（逻辑完整，直接转换为 TS）

**转换要点**：
- `DispatchSchemas` 对象改用 TypeBox（Pi 的工具参数 schema 用 TypeBox）
- `validateDispatchPayload` 改为 Pi 的 `registerTool` 的 `parameters` 参数（TypeBox schema 直接传入，Pi 在工具调用前自动校验）
- `assertContrarianSchemaIsolation` 保留为启动自检

**关键代码示意**：
```ts
import { Type } from "typebox";
import pi from "@earendil-works/pi-coding-agent";

pi.registerTool({
  name: "dispatch_contrarian",
  description: "派发反方 Agent：★ 只收 claim + evidence_ids。没有 verdicts/reasoning/summary 字段。",
  parameters: Type.Object({
    claim: Type.String({ description: "待反驳的主张原文" }),
    evidence_ids: Type.Array(Type.String(), { description: "原始证据 ID，由扩展解析为原文" }),
    // ★ 物理上不存在 verdicts / reasoning / summary 字段
  }),
  execute: async (_id, p, ctx) => {
    // evidence_ids 由扩展侧解析为 rawSnippet —— 主管只能传句柄
    const raw = p.evidence_ids.map(id => lookupEvidence(id).rawSnippet);
    // 通过 vendor 的 subagent 扩展派发
    return runSubagent("contrarian", { claim: p.claim, evidence: raw });
  },
});
```

**迁移后不变的核心性质**：`additionalProperties: false` 由 TypeBox 的 schema 保证；fail-closed 校验由 Pi 的工具调用框架保证（schema 不通过则不调用）。

---

### 步骤 5：`extensions/evidence.ts` —— 证据溯源层

**来源**：`src/evidence/store.js` + `src/evidence/features.js`

**核心变化**：从自建 JSONL 写入改为 Pi 的 `pi.appendEntry`。

```ts
// 证据写入（不进 LLM 上下文 —— 这是 appendEntry 的核心语义）
pi.appendEntry("evidence", {
  id,
  source, url, platform, title,
  publishedAt, author, authorFeatures,
  rawSnippet, contentHash,   // contentHash 去重保留
  staleness, sampleSize, channelAuthority, comments,
  fetchedAt: nowIso(),
});
// inLLMContext: false 是 appendEntry 的默认行为，不需要显式设置
```

**`session_start` 重建索引**：用 Pi 的 `pi.on("session_start", ...)` 钩子扫描已有 entries：

```ts
pi.on("session_start", (ctx) => {
  for (const entry of ctx.session.entries()) {
    if (entry.customType === "evidence") {
      evidenceIndex.set(entry.evidence.id, entry);
      hashIndex.set(entry.evidence.contentHash, entry.evidence.id);
    }
  }
});
```

**`registerEntryRenderer`**（★ 当前未实现，需新增）：让证据在 TUI 里渲染为卡片。

```ts
pi.registerEntryRenderer("evidence", (entry) => {
  const ev = entry.evidence;
  return [
    `📄 ${ev.title ?? ev.url}`,
    `   ${ev.platform} · ${ev.publishedAt?.slice(0, 10) ?? "时间未知"} · ${ev.author ?? "未知"}`,
    `   ${ev.id} · staleness=${ev.staleness} · ${ev.rawSnippet?.slice(0, 80)}…`,
  ].join("\n");
});
```

**`features.js` 的转换**：`extractFeatures`、`detectPromoCode`、`classifySampleSize`、`classifyStaleness`、`classifyDensity`、`detectCommentRebuttal`、`parseQuestion` 这些纯函数直接搬到 `extensions/evidence.ts` 或单独的 `extensions/features.ts`。

---

### 步骤 6：`extensions/sources.ts` —— 内容源工具层

**来源**：`src/sources/*.js`（bilibili.js、web.js、rss.js、youtube.js、pipeline.js、degrade.js、index.js）

**转换要点**：
- 每个源的搜索函数注册为 Pi 工具（`pi.registerTool`），供 collector 子 Agent 使用
- `pi.exec(command, args)` 替代当前的 `child_process.spawn` 调用（bili CLI、yt-dlp）
- `fetch` 调用（Jina Reader）保持不变
- `DiskCache` 和 `createRateLimiter` 从 `pipeline.js` 直接搬过来
- `runDoctor` 搬到 `extensions/doctor.ts`

**工具注册示意**：
```ts
pi.registerTool({
  name: "fetch_bilibili",
  description: "搜索 B 站视频（UGC 主力源）",
  parameters: Type.Object({ keyword: Type.String() }),
  execute: async (_id, p) => {
    const result = await pi.exec("bili", ["search", p.keyword]);
    return parseBilibiliResults(result.stdout);
  },
});
// 同理注册 fetch_youtube, fetch_web, fetch_rss
```

---

### 步骤 7：`extensions/hypotheses.ts` —— Tree-of-Hypotheses（★ 核心贡献）

**来源**：`src/core/orchestrator.js`

**这是迁移量最大的模块**。当前 orchestrator 自己管理会话树（`SessionTree`）、自己派发子进程（`dispatchSubagent`）。迁移后要改为：
- 用 Pi 的 `SessionManager` 替代 `SessionTree`（`ctx.fork`、`pi.setLabel`、`ctx.navigateTree`）
- 用 vendor 的 subagent 扩展替代 `dispatchSubagent`
- 保留的自建逻辑：假设规划（`_planHypotheses`）、裁决规则（`_verdict`）、放弃摘要（`buildAbandonSummary`）

**关键 API 映射**：

| 当前代码 | Pi 替代 |
|---|---|
| `tree.fork(parentId, {label, meta})` | `ctx.fork(entryId, {...})` |
| `tree.setLabel(id, label, state)` | `pi.setLabel(entryId, label)` —— 注意 Pi 的 setLabel 只接受一个 label 字符串，状态机编码进 label 本身（如 `hyp/softad/abandoned`） |
| `tree.appendSummary(branchId, summary)` | `ctx.navigateTree(targetId, { summarize: true, customInstructions: HYPOTHESIS_ABANDON_PROMPT })` |
| `tree.renderTree()` | Pi 内置 `/tree` 命令 |
| `dispatchSubagent({role, payload})` | vendor subagent 的 `runSubagent(role, task)` |

**`HYPOTHESIS_ABANDON_PROMPT`**（★ 当前未实现为 Pi 语义）：

当前 `buildAbandonSummary()` 是硬编码的 5 段字符串拼接。迁移后要改为 Pi 的 `customInstructions`，让 Pi 的分支摘要机制用这个 prompt 生成摘要：

```ts
const HYPOTHESIS_ABANDON_PROMPT = `
为被放弃的假设生成分支摘要，包含以下 5 段：
1. 【假设】这个假设是什么
2. 【支持它的证据】有哪些证据支持
3. 【推翻它的证据】有哪些证据反对
4. 【放弃的具体理由】为什么放弃
5. 【对其它分支的启示】其它分支应该从这次探索中学到什么（避免重复探索相同查询面）
`;
```

然后在放弃分支时：
```ts
await ctx.navigateTree(branchId, {
  summarize: true,
  customInstructions: HYPOTHESIS_ABANDON_PROMPT,
});
```

**假设状态机编码**：当前用 `setLabel(id, label, state)` 分开存 label 和 state。Pi 的 `setLabel` 只接受一个字符串，所以要把状态编码进 label：`hyp/softad/open` → `hyp/softad/abandoned`。

---

### 步骤 8：`extensions/calibration.ts` —— 置信度引擎

**来源**：`src/calibration/calibration.js`

**转换量最小**：纯计算逻辑，不依赖任何外部 API。直接转 TS + 类型标注。

保留的核心函数：
- `evidenceContributions()` —— 单条证据的特征贡献
- `corpusContributions()` —— 语料级结构特征
- `computePosterior()` —— log-odds 聚合 + tanh 饱和 + 反方有界调整
- `sensitivityAnalysis()` —— 逐特征中和 → ΔP → 阈值标注

**唯一变化**：`loadLikelihoodRatios()` 从读 `config/likelihood-ratios.json` 改为扩展内部 import JSON（TS 支持 `import lrTable from "../config/likelihood-ratios.json" with { type: "json" }`）。

---

### 步骤 9：`extensions/report.ts` —— 5 段报告

**来源**：`src/report/report.js`

**转换要点**：
- `buildReport()` 和 `validateSection5()` 直接转 TS
- `assembleGaps()` 直接转 TS
- 报告不再写到文件 —— 由 Pi 的对话输出机制呈现
- 但保留写文件能力（`pi.registerCommand("report", ...)` 可以导出 markdown）
- `ReportValidationError` 保留

---

### 步骤 10：`extensions/doctor.ts` —— /doctor 通道自检

**来源**：`src/sources/index.js` 的 `runDoctor` 函数

**转换**：
```ts
pi.registerCommand("doctor", {
  description: "通道自检 —— 逐条探测四个内容源 + 显式声明小红书不做",
  execute: async () => {
    const results = await probeAllChannels();
    // 输出格式与当前 CLI 版一致
    return results.map(r => `${r.ok ? "✓" : "✗"} ${r.channel} — ${r.detail}`).join("\n");
  },
});
```

---

### 步骤 11：Agent 角色定义迁移

**当前**：`agents/collector.md`、`agents/verifier.md`、`agents/contrarian.md` 已经正确定义了 YAML frontmatter。

**迁移**：按 subagent 扩展的约定（`subagent/README.md:142-146`），角色定义需要放在 `~/.pi/agent/agents/` 或项目的 `.pi/agents/`。安装脚本（或 README 说明）要处理这一步：

```bash
# 安装时
mkdir -p .pi/agents
cp agents/*.md .pi/agents/
```

或者在 `package.json` 的 `pi` manifest 里声明（如果 Pi 支持 agent 目录配置）。

---

### 步骤 12：Web SSE 适配 Pi SDK

**当前**：`web/server.js` 直接 `new Orchestrator(config)` 然后 `orch.runCheck()`。

**迁移后**：改为用 Pi SDK 的 `createAgentSession` + `session.subscribe` + `createEventBus()`：

```ts
import { createAgentSession, createEventBus } from "@earendil-works/pi-coding-agent";

// POST /api/check
const session = await createAgentSession({ prompt: q, ... });
const bus = createEventBus(session);
bus.on("agent_event", (evt) => { /* 转 SSE */ });

// GET /api/events
session.subscribe((event) => { /* 推 SSE */ });
```

**前端 `web/static/index.html` 不需要改**——SSE 事件格式保持一致。

---

### 步骤 13：测试迁移

**当前**：5 个 `node:test` 文件。

**目标**：`vitest` + Pi 的 faux provider。

| 测试文件 | 覆盖内容 | 迁移变化 |
|---|---|---|
| `test/calibration.test.js` | 后验可复现、tanh 饱和、敏感性分析 | 直接转 vitest，import 路径改 |
| `test/isolation.test.js` | schema 隔离断言 | 直接转 vitest |
| `test/report-features.test.js` | 第 5 段校验、信息缺口组装 | 直接转 vitest |
| `test/sources.test.js` | 降级、缓存、解析 | mock `pi.exec` 替代 mock `fetch` |
| `test/tree-evidence.test.js` | label 状态机、证据 custom entry | 改为用 Pi 的 faux SessionManager 测试 |

---

## 五、缺失功能实现详细

### 5.1 定性对照演示（替代已移除的消融实验）

**目标**：同一输入跑两遍——一遍完整系统，一遍禁用反方 Agent——把两份报告的第 3 段并排展示。

**实现**：写一个脚本 `scripts/compare-contrarian.sh`（或 `.ps1`）：

```bash
# 第一遍：完整系统
/check 字节 2027 届前端实习转正率
cp .offerlens/reports/latest.md reports/with-contrarian.md

# 第二遍：临时移走反方角色定义
mv agents/contrarian.md agents/contrarian.md.bak
/check 字节 2027 届前端实习转正率
cp .offerlens/reports/latest.md reports/without-contrarian.md
mv agents/contrarian.md.bak agents/contrarian.md

# 提取第 3 段并排
echo "## 有反方 Agent" > README-comparison.md
sed -n '/## 3\./,/^## 4\./p' reports/with-contrarian.md >> README-comparison.md
echo "## 无反方 Agent" >> README-comparison.md
sed -n '/## 3\./,/^## 4\./p' reports/without-contrarian.md >> README-comparison.md
```

**措辞纪律**：
- ✅ "去掉反方 Agent 后第 3 段退化为对前文的修辞性复述"
- ❌ "假阴性率上升 X%"（没做测量不能说）

---

### 5.2 README 诚信边界段

**必须在 README 顶部包含**（原计划第十节）：

```markdown
## 致谢与边界

基于 [Pi](https://github.com/earendil-works/pi)（MIT, Copyright (c) 2025 Mario Zechner）构建的 Pi 包。

**Pi 提供的能力**（不是本项目的贡献）：
- Agent 循环 / 事件系统 / Compaction
- 会话树与分支摘要原语（`SessionManager`、`branchWithSummary`、LCA）
- Subagent 派发机制（`extensions/subagent/` 衍生自 `examples/extensions/subagent/`）
- 扩展 API（`pi.on`、`registerTool`、`appendEntry`、`setLabel`、`exec` 等）
- TUI / RPC / 测试基建

**本项目的增量贡献**：
- **Tree-of-Hypotheses**：将 Pi 的会话树从人类 TUI 导航改造成多 Agent 假设搜索；改写了摘要 prompt 为假设裁决语义；实现跨分支证据去重
- **Schema 强制的上下文隔离**：在上游 subagent 示例仅提供通用派发参数的前提下，实现了专用 dispatch 工具的封闭 schema
- **证据溯源层**：利用 `appendEntry` 不进 LLM 上下文的特性实现证据审计
- **结构化置信度 + 敏感性分析**：手工权重的似然比 + 逐特征中和分析
- **5 段报告契约**：第 5 段「信息缺口」为强制字段

**安全声明**：本包只读网络、不写用户文件、不执行任意命令（`pi.exec` 的调用目标是固定的四个 CLI，参数经过校验）。
```

---

### 5.3 简历 Bullet 定稿

```
OfferLens — 校招/实习信息多智能体甄别助手（个人项目，TypeScript / Pi 扩展 / 已发布为 Pi 包）
- 基于 Pi（MIT）构建四角色交叉验证系统，通过独立上下文 + 对立目标的编排解决单 Agent 自我反驳退化为修辞的问题；将反方 Agent 的派发工具参数 schema 限制为仅接受主张与证据 ID，使编排者无法在类型层面泄漏前序结论
- 在 Pi 的会话树与分支摘要原语仅面向人类 TUI 导航的前提下，自主设计 Tree-of-Hypotheses 编排层：每个假设对应一个树分支，setLabel 编码假设状态机，放弃分支时以改写的假设裁决 prompt 生成摘要留存，实现跨分支证据去重
- 利用 Pi 自定义 entry 不进入 LLM 上下文的特性实现证据溯源层，使证据可审计、可按 ID 取回而不污染推理上下文，且与会话树共享同一份 JSONL
- 实现结构化置信度与敏感性分析替代不可靠的 LLM 自报置信度，将「信息缺口」设计为输出契约的强制字段并由扩展校验
- 封装四路零配置内容源（Bilibili / YouTube / Jina Reader / RSS），实现三级降级、磁盘缓存与 /doctor 通道自检
```

**填写纪律**：
1. 不得出现任何百分比数字
2. "四路"以 Week 0 spike 实测为准，不通就改实际路数
3. "已发布为 Pi 包"只有在 `pi install git:...` 真的能被第三方跑通之后才能写
4. 若 Windows spawn 不成立、退化为同进程串行，第 1 条里"独立进程"相关表述必须删掉

---

### 5.4 asciinema 录屏脚本

```bash
#!/bin/bash
# scripts/record-demo.sh
# 用法：asciinema rec -c "bash scripts/record-demo.sh" demo.cast

set -e
echo "$ # 0. 安装"
echo "$ npm install && pi install ./"
echo ""
echo "$ # 1. 通道自检"
echo "$ /doctor"
echo "$ # ✓ bilibili  ✓ youtube  ✓ web  ✓ rss  ✗ xiaohongshu (not supported by design)"
echo ""
echo "$ # 2. 主流程"
echo "$ /check 字节 2027 届前端实习转正率"
echo ""
echo "$ # 3. 假设树"
echo "$ /tree"
echo "$ # hyp/softad (abandoned)  hyp/stale (supported)  hyp/insufficient (open)"
echo ""
echo "$ # 4. 报告第 5 段（信息缺口）"
echo "$ # 自动列出：样本量不足 / 后验对单一特征敏感 / 源不可达..."
```

---

## 六、迁移顺序与依赖关系

```
步骤 1 (package.json)
  ↓
步骤 2 (删除自建替代) ← 必须先删再建，避免两套并行
  ↓
步骤 3 (vendor subagent)
  ↓
步骤 4-6 (isolation + evidence + sources) ← 可并行
  ↓
步骤 7 (hypotheses) ← 依赖 3/4/5/6
  ↓
步骤 8-9 (calibration + report) ← 可并行
  ↓
步骤 10 (doctor)
  ↓
步骤 11 (agent 角色迁移)
  ↓
步骤 12 (Web SSE 适配)
  ↓
步骤 13 (测试迁移)
  ↓
第五章缺失功能（5.1-5.4 可并行）
```

---

## 七、关键文件参考索引

| 用途 | 路径 |
|---|---|
| 原计划文档（权威） | `./grounded-tide-robin.md` |
| Pi subagent vendor 源 | `C:\Users\86186\Documents\Qoder\2026-09-02\9fc6ad4b\pi-src\packages\coding-agent\examples\extensions\subagent\` |
| Pi 扩展 API 文档 | `pi-src\packages\coding-agent\docs\extensions.md`（1700+ 行） |
| Pi SDK 文档 | `pi-src\packages\coding-agent\docs\sdk.md` |
| Pi 包约定 | `pi-src\packages\coding-agent\docs\packages.md` |
| Pi 分支摘要原语 | `pi-src\packages\coding-agent\src\core\compaction\branch-summarization.ts` |
| Pi 会话树持久化 | `pi-src\packages\coding-agent\src\core\session-manager.ts` |
| Pi 测试 faux provider | `pi-src\packages\ai\src\providers\faux.ts` |

---

## 八、验收标准

迁移完成后，以下场景必须全部通过：

1. **安装**：`pi install ./` 成功，在 Pi 里输入 `/check "字节 2027 届前端实习转正率"` 能运行
2. **假设树**：`/tree` 能看到 `hyp/softad` / `hyp/stale` / `hyp/insufficient` 三个分支及其状态
3. **隔离**：让主管尝试在派发反方时夹带质检结论，展示它在类型层面无处可放
4. **证据**：TUI 里证据渲染为卡片（`registerEntryRenderer`），点击可展开原文
5. **报告**：第 5 段「信息缺口」非空；故意查信息稀缺主题时第 5 段列出多项缺口
6. **降级**：断网/单通道失效时不崩溃，报告出现"源不可达"并计入信息缺口
7. **/doctor**：输出四个通道的可用性 + 小红书显式标注 `not supported by design`
8. **Web**：`node web/server.js` 启动后浏览器可见，SVG 置信度曲线有反方红点
9. **测试**：`npx vitest` 全部通过，不需要真实 API key
10. **定性对照**：有/无反方的两份报告第 3 段有肉眼可见的实质差异
