# OfferLens — 校招/实习信息多智能体甄别助手（Pi 版需求文档）

> 本文档替代上一版（CubePi 方案）。两处根本变化：**内核换成 Pi 本体**，以及**按你的要求移除了全部实验/评测内容**（消融实验、标注集、指标对比）。移除带来的影响在第七节和第十一节明确标注，没有悄悄淡化。

## Context：为什么做这个项目，为什么是 Pi

**你的处境**：武汉理工软件工程硕士，求职定位是**多智能体 / Agent 工程化**，不是 RAG。面试官对这个方向有一个固定的深挖套路——"你这个为什么必须是多 Agent？一个 Agent 加个循环不行吗？"绝大多数候选人答不上来，因为他们项目里的多 Agent 只是**并行提速**，而并行提速可以被单 Agent 替代。

**原始想法的三个硬伤**：你最初提的"贴小红书/视频链接 → 总结资料"不能作为项目主体：

| 硬伤 | 原因 |
|---|---|
| 难点错位 | 90% 工作量在反爬、登录态、风控对抗上，Agent 工程含量接近零。面试官问编排，你答 cookie 池 |
| 演示不可靠 | Agent-Reach 文档记录了 `yt-dlp` 在 2026-06 被 B 站风控打死、一批单平台 CLI 在 2026-03 集体失效 |
| 天然不需要多 Agent | "抓取 → 清洗 → 摘要"是线性管道，单 Agent 顺序调三个工具就能做完 |

**保留内核、替换问题**：你的真实洞察是对的——**多源非结构化内容 → 用户决策**这个链路有价值。但核心问题要从「**怎么抓到**」换成「**抓到之后怎么判断真假**」。换成甄别问题后，多 Agent 立刻有了硬需求，反爬退化为可替换的工具层。

**场景真实性**：你自己就在找实习。校招信息恰好是**软广、过期信息、幸存者偏差**的重灾区。你是第一个真实用户，需求不用编。

### 为什么换成 Pi（已核实源码，不是印象）

| 维度 | Pi | CubePi |
|---|---|---|
| Subagent 上下文隔离 | **进程级**，`spawn` 独立 `pi` 子进程 | 进程内 `SubagentSpec`，需验证中间件不夹带历史 |
| 会话树 | 原生：`getTree()` / `getPath()` / `getChildren()` / `branch()` / `createBranchedSession()` / labels | **无树**，只有线程级 `fork()` |
| 分支摘要 | 原生：`branchWithSummary(id, summary)`、`navigateTree(t,{summarize:true})`、LCA、5 段 prompt | **完全没有** |
| 扩展机制 | `pi.on` / `registerTool` / `registerCommand` / `appendEntry` / `setLabel` / `exec` / `registerEntryRenderer` 等 | `Middleware` 9 个 hook |
| 分发渠道 | `pi install npm:/git:` + **pi.dev/packages gallery** | 无 |
| 你已有的学习投入 | ch07–ch10 已验证到行号 | 需重学一套组合语义 |

**Pi 的 `docs/usage.md:309` 原文**（这条决定了整个项目的形态）：

> "It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash. You can build or install those workflows as extensions or packages."

Pi 和 CubePi 同源，但对「什么该进内核」做了**相反的决定**：Pi 故意把这些全推到扩展层（`examples/extensions/` 下约 90 个示例），CubePi 把 Compaction 和 Subagent 做成一等中间件。**这意味着 Pi 的 subagent 是示例代码、不是 API 契约**——第 7–8 周必须决定是 symlink 还是 vendor 一份自己维护（本方案选 vendor，理由见第四节）。

**已确认的选型前提**：
- 时间预算：12 周以上（充裕）
- 数据源：零配置四源（B 站 / YouTube / 通用网页 / RSS），**不碰任何需登录态的平台**
- 内核：**Pi 本体**（`@earendil-works/pi-coding-agent`，MIT，Copyright (c) 2025 Mario Zechner，v0.84.4）
- 语言：**TypeScript**（Pi 是 TS，扩展经 jiti 加载，无需编译步骤）
- 交付形态：**Pi 包（CLI/TUI 内运行）+ Web SSE 单文件前端**
- 前端：单文件 `static/index.html` + 原生 `EventSource`，零构建、零 npm 依赖
- 排期：正式开工前先做 1 周 spike
- **范围排除：不做消融实验、不做人工标注评测集、不做指标对比**（你的决定）

---

## 一、项目是什么

**一句话**：输入一个岗位方向或一条待核实的说法，主管 Agent 在**会话树上为每个假设开一个分支**，每个分支派发三个目标互相冲突的子 Agent（采集/质检/反方）在**独立进程**中工作，被放弃的假设用 Pi 的分支摘要压缩后留在树上；最终输出一份带证据溯源、带结构化置信度、并**强制标注「我不知道什么」**的决策报告。

### 交付形态：这是一个 Pi 包，不是一个独立 CLI

这是换 Pi 之后最大的形态变化——**你不用写 CLI**。`pi install git:github.com/<you>/offerlens` 之后，用户在 pi 里直接输入 `/check "..."` 就能用。CLI、TUI、会话持久化、模型管理、键位、主题全部由 Pi 提供。

按 `docs/packages.md:160-165` 的约定目录组织：

```
offerlens/
├── package.json              # "keywords": ["pi-package"], "pi": {...} manifest
├── extensions/
│   ├── sources.ts            # 4 个 ContentSource 工具（pi.exec / fetch）
│   ├── evidence.ts           # pi.appendEntry("evidence", ...) + entry renderer
│   ├── hypotheses.ts         # ★ Tree-of-Hypotheses 编排（核心贡献）
│   ├── isolation.ts          # ★ schema 强制的上下文隔离（核心贡献）
│   ├── report.ts             # 5 段报告契约 + 「信息缺口」校验
│   ├── calibration.ts        # 结构化置信度 + 敏感性分析
│   └── doctor.ts             # /doctor 通道自检
├── agents/                   # 子 Agent 角色定义（Markdown + YAML frontmatter）
│   ├── collector.md          # 采集：目标「全」
│   ├── verifier.md           # 质检：目标「准」
│   └── contrarian.md         # 反方：目标「反」
├── prompts/
│   ├── check.md              # /check 工作流预设
│   └── scan.md               # /scan 主动扫描预设
└── web/                      # 可选：SDK + SSE 桥 + static/index.html
```

### 输入

```
/check 字节 2027 届前端实习转正率
/check --url https://... --claim "这个博主说的内推码是真的"
/scan 多智能体方向 2027 届秋招
/doctor                                  # 通道自检
/tree                                    # Pi 内置：查看假设树（label 就是假设名）
```

### 输出契约（5 段，第 5 段强制，缺失即视为运行失败）

| 段 | 内容 | 为什么必须有 |
|---|---|---|
| **1. 结论摘要** | 一句话结论 + **结构化置信度**（由可数特征算出的后验，附敏感性标注），不是"高/中/低" | LLM 自报置信度与真实准确率几乎不相关 |
| **2. 证据清单表** | 每条：来源 URL / 平台 / 发布时间 / 作者历史发文特征 / **时效判定** / 样本量标注 / `evidence_id` | 溯源是审计前提 |
| **3. 反面证据** | 反方 Agent 原始输出，**不被主管改写、不被折叠** | 多 Agent 必要性的可见产物 |
| **4. 行动建议** | 具体到"去哪个官方渠道二次确认"、"问哪三个问题" | 决策辅助而非信息堆砌 |
| **5. ⚠️ 信息缺口** | 明确列出无法判定的部分及**为什么**（源不可达 / 需登录 / 样本量不足 / 证据矛盾且无法仲裁 / 后验对单一争议特征高度敏感） | 本项目最独特的设计 |

---

## 二、为什么必须是多 Agent（面试核心论证）

**必要性来自「独立上下文 + 对立目标」，不是来自并行。**

### 单 Agent 的失败模式：上下文污染 → 确认偏误

让一个 Agent 顺序执行"搜集 → 判断 → 自我反驳"。走到反驳环节时，上下文里已经堆了 20 条支持性证据和它自己刚才的推理链。**模型无法真正反驳自己**——它会生成"虽然存在一定风险，但综合来看……"的伪反驳，因为注意力已被自己的前文锚定。这不是 prompt 能修的，是上下文结构问题。

### Pi 让隔离成为架构必然而非纪律要求

`examples/extensions/subagent/index.ts:300` 的派发命令是：

```ts
const args: string[] = ["--mode", "json", "-p", "--no-session"];
// :303  --model <m>          :305  --thinking <level>
// :307  --tools <a,b,c>      :338  --append-system-prompt <tmpPromptPath>
// :341  args.push(`Task: ${task}`)
// :346  spawn(invocation.command, invocation.args, {...})
```

一个全新的 `pi` 进程、`--no-session`、只带自己的角色 system prompt 和一句 `Task: ...`。**父 Agent 的对话历史在物理上没有任何通道可以泄漏进去。** 这比进程内隔离强一个量级——上一版方案里"验证 CubePi 中间件是否夹带历史"这个风险点，在 Pi 下不存在。

### ★ 但隔离的质量取决于主管传什么——所以要用 schema 强制

进程隔离保证了"传不过去"，但**没保证主管只传原始证据**。如果主管在 `task` 字符串里顺手写上"质检 Agent 认为这批内容可信度 0.8"，隔离就白费了。

**解法：让泄漏在类型层面无法表达。** 不给反方 Agent 用通用的 `subagent` 工具，而是注册一个专用工具：

```ts
pi.registerTool({
  name: "dispatch_contrarian",
  parameters: Type.Object({
    claim: Type.String({ description: "待反驳的主张原文" }),
    evidence_ids: Type.Array(Type.String(), { description: "原始证据 ID，由扩展解析为原文" }),
    // ★ 没有 verdicts / no reasoning / no summary 字段
  }),
  execute: async (_id, p) => {
    // 扩展侧用 evidence_ids 从 session 里取回 RAW snippet，
    // 主管无法传入它拿不到句柄的东西
    const raw = p.evidence_ids.map(id => lookupEvidence(id).rawSnippet);
    return runSubagent("contrarian", { claim: p.claim, evidence: raw });
  },
});
```

**主管无法表达它就无法泄漏。** 这比在 system prompt 里写"请不要传递前序结论"可靠得多，而且是可以给面试官看代码的硬设计。

### 四个角色的目标函数刻意冲突

| 角色 | 目标 | `agents/*.md` frontmatter 要点 | 与谁冲突 |
|---|---|---|---|
| **采集** `collector.md` | **全** | `tools: fetch_bili, fetch_youtube, fetch_web, fetch_rss`；宁多收不漏收，**禁止**丢弃"看起来像软广"的内容 | 与质检冲突（它收的垃圾增加质检工作量） |
| **质检** `verifier.md` | **准** | `tools: read_evidence`；逐条打分：时效/作者可信度/样本量/软广特征。允许判定"全部不可信" | 与采集冲突；与反方冲突（它给正向评分） |
| **反方** `contrarian.md` | **反** | `tools:` 空（**只推理不检索**，防止它自己去找支持性证据）；唯一目标是构造能推翻主张的最强论证。若确实无法推翻，必须明说"未能构造出反驳"而**不是**改口支持 | 与质检正面冲突 |
| **主管**（pi 主会话） | **收敛但不调和** | 明确指令：**看到冲突不要调和**。冲突本身是信号，要体现在置信度和「信息缺口」里 | — |

**反方 Agent 的职责被精确化**：它不攻击结论，它**攻击似然比的取值**（见第五节）。这比"你来挑毛病"可执行、可检查得多。

**主管"不调和"是刻意保留的张力**。传统 orchestrator 倾向综合出四平八稳的结论，那就把反方的价值抹掉了。

### 一句话面试答法

> "多 Agent 在这里不是为了并行提速，是为了**制造独立的采样上下文**。一个 Agent 无法反驳自己——上下文里充满支持性证据和自己的推理链时，自我批评必然退化成修辞。Pi 的 subagent 派发是 `spawn` 一个带 `--no-session` 的全新进程，父历史物理上无法泄漏；我进一步把反方工具的参数 schema 限制成只接受 `claim` 和 `evidence_ids`，由扩展侧解析原文——**主管无法表达它就无法泄漏**，隔离从纪律要求变成了类型约束。"

---

## 三、上游已提供 vs 自主实现（诚信边界）

### Pi 已提供（**不是**贡献，README 要显式致谢）

| 能力 | 位置 | 备注 |
|---|---|---|
| Agent 循环 / 事件系统 | `packages/agent/src/agent-loop.ts` | 10 种 `AgentEvent`，4 层嵌套 |
| Compaction | `core/compaction/compaction.ts` | 6 段 prompt(`:467-498`)、增量更新(`:500-539`)、`findCutPoint`(`:403-461`)、三处检查点 |
| **分支摘要** | `core/compaction/branch-summarization.ts` | LCA(`:108-146`)、5 段 prompt(`:258-285`)、maxTokens 2048(`:350`) |
| **会话树持久化** | `core/session-manager.ts` | JSONL append-only、`id`/`parentId`/`leafId`、v1→v2→v3 迁移、`flushed` 懒建文件 |
| Subagent 派发 | `examples/extensions/subagent/index.ts`（1038 行） | **示例代码，非 API 契约**。parallel(max 8, 4 concurrent) / chain(`{previous}`) / abort 传播 / 50KB per-task cap |
| 扩展 API | `docs/extensions.md`（1700+ 行） | `pi.on`、`registerTool`、`registerCommand`、`appendEntry`、`setLabel`、`exec`、`registerEntryRenderer`、`ctx.fork`、`ctx.navigateTree` |
| 输出截断 | `core/tools/truncate.ts:11-13` | 双限（2000 行 / 50KB）先触者胜 |
| 工具层 | `defineTool` + `typebox` | `docs/sdk.md:582-603` |
| 剥离 coding 语义 | `systemPromptOverride` + `noTools:"all"` | `docs/sdk.md:508-513`、`:522-526` |
| RPC / 远程会话 | `runRpcMode`、`pi-protocol`(CBOR)、`pi-client` | `docs/sdk.md:1111-1165` |
| TUI | `@earendil-works/pi-tui` | 差分渲染 |
| 测试 | `packages/ai/src/providers/faux.ts` + `test/suite/harness.ts` | 无需真实 API key |

**明确不用**：`@earendil-works/pi-server`（package.json 里自标 **"experimental"**）。Web 层自己写 SSE。

### 自主实现（真实贡献区，5 项）

**① ★ Tree-of-Hypotheses：把会话树从「人类导航」改造成「多 Agent 假设搜索」**

Pi 的分支摘要是为 TUI 里的人类用户设计的——`navigateTree()` 返回 `{ editorText?, cancelled }`，这是交互式编辑器语义。**它从没被用于多 Agent 编排。**

本项目天然需要它：主管在甄别中会形成多个假设（"这是软广" / "真实分享但已过期" / "样本量不足无法判定"），每个假设值得一棵独立分支去验证，失败的分支要压缩留在树上而不是丢掉。

**两级架构**（这是设计的核心）：

```
树级（持久，主管独占）      = 假设搜索
  ├─ 分支 A: "HR 软文"      label: hyp/softad
  ├─ 分支 B: "真实但过期"   label: hyp/stale      ← 放弃时 branchWithSummary
  └─ 分支 C: "样本不足"     label: hyp/insufficient

进程级（临时，子 Agent）    = 角色执行
  每个分支内派发 collector / verifier / contrarian
  --no-session，跑完即弃，输出回传给主管
```

实现（`extensions/hypotheses.ts`）：

```ts
pi.registerCommand("hypothesize", { ... });   // 或作为工具暴露给主管

// 开新假设分支
pi.setLabel(entryId, `hyp/${slug}`);                       // extensions.md:1508
await ctx.fork(entryId, { ... });                          // extensions.md:1172

// 放弃当前假设：Pi 原生摘要，不需要自己写 LCA
await ctx.navigateTree(targetId, {
  summarize: true,                                         // extensions.md:1198
  customInstructions: HYPOTHESIS_ABANDON_PROMPT,           // ← 这是你的增量
  label: `hyp/${slug}/abandoned`,
});
```

**你的增量不是"实现分支摘要"（Pi 已有），而是三件事**：
1. `HYPOTHESIS_ABANDON_PROMPT` —— Pi 的 5 段 prompt(`branch-summarization.ts:258-285`)是通用会话摘要，要改写成**假设裁决语义**：这个假设是什么 / 支持它的证据 / 推翻它的证据 / 放弃的具体理由 / 对其它分支的启示（避免重复探索）
2. **假设状态机** —— `open` / `supported` / `refuted` / `abandoned` / `insufficient-evidence`，用 `pi.setLabel` 编码进树，`/tree` 里直接可读
3. **跨分支去重** —— 分支 B 放弃时如果发现某条证据已被分支 A 采信，摘要里要标注而不是重复计入似然比

**为什么 CubePi 做不了这个**：它没有会话树，`fork()` 是线程级物理拷贝，两个 thread 之间只有 `parent_thread_id` 血缘，没有 LCA、没有 `branchWithSummary`。

**② ★ Schema 强制的上下文隔离**（见第二节）—— 专用 `dispatch_contrarian` 工具，参数 schema 里物理上不存在传递前序结论的字段。

**③ 证据溯源层：用 `pi.appendEntry` 而不是独立数据库**

`docs/extensions.md:1473` 的关键性质：

> "Persist extension data. **Custom entries do NOT participate in LLM context.** In interactive mode, they can also render inside the chat transcript when paired with `pi.registerEntryRenderer()`."

**这正好是证据溯源需要的语义**：证据原文要能被审计、能被工具按 ID 取回，但**不能污染 LLM 上下文**（否则 20 条证据全文进上下文，就又回到确认偏误的老问题了）。

```ts
pi.appendEntry("evidence", {
  id, source, url, platform, fetchedAt, publishedAt,
  authorFeatures: { recentPostDensity, hasPromoCode, ... },
  rawSnippet, contentHash,          // 去重靠 hash
  staleness: "current" | "stale" | "unknown",
  sampleSize: "personal" | "small" | "unlabelled",
});
```

好处：证据与会话树**同一份 JSONL**，天然版本化、天然可 diff、天然随分支一起 fork；`session_start` 时按 `entry.customType === "evidence"` 重建索引（`extensions.md:1480-1486` 给了范式）；配 `registerEntryRenderer` 在 TUI 里直接渲染成卡片。**不需要 SQLite，少一个依赖。**

上一版方案里的独立 Evidence Store 因此**取消**。

**④ 内容源工具层（4 个适配器 + 三级降级）**

用 `pi.exec(command, args, options?)`（`extensions.md:1668`）包装上游 CLI，Node 24 的全局 `fetch` 处理 HTTP：

| 源 | 实现 | 登录 | 备注 |
|---|---|---|---|
| Bilibili | `pi.exec("bili", ["search", q])` | 否 | Agent-Reach 记录的零配置通道 |
| YouTube | `pi.exec("yt-dlp", ["--write-auto-sub","--skip-download",url])` | 否 | 只取字幕 |
| 通用网页 | `fetch("https://r.jina.ai/" + url)` | 否 | Jina Reader |
| RSS | `rss-parser` | 否 | 官方公告源，**最高可信度权重** |
| ~~小红书~~ | — | **是** | **明确不做** |

三级降级：主通道 → 备用通道 → **标记为「信息缺口」并在报告里显式说明该源不可达**。最后一级是关键：**通道失效不是错误，是要报告给用户的事实**。

工程细节：磁盘缓存（TTL 24h，避免 demo 时重复请求触发风控）、限速、UA 轮换、`contentHash` 去重。**不做**任何反爬对抗、验证码绕过、登录态注入。

**⑤ `/doctor` 通道自检**（借 Agent-Reach 的模式，不依赖其代码）—— 逐条探测四个通道，输出可用性和版本，不可用的说明原因。**小红书要显式列出并标注 `not supported by design (requires login)`**，把"不做"变成可见的设计决定而不是能力缺失。

---

## 四、依赖清单

按 `docs/packages.md:171`，Pi 核心包必须放 `peerDependencies` 且用 `"*"` 范围，**不能 bundle**：

```json
{
  "name": "offerlens",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions"], "prompts": ["./prompts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "dependencies": { "rss-parser": "^3.x" }
}
```

| 依赖 | 用途 | 备注 |
|---|---|---|
| `@earendil-works/pi-coding-agent` | Agent 内核 + 扩展 API + SessionManager | peer，MIT |
| `@earendil-works/pi-ai` | 模型/凭据（`StringEnum` 等） | peer |
| `@earendil-works/pi-tui` | Evidence 卡片的自定义渲染 | peer |
| `typebox` | 工具参数 schema | peer |
| `rss-parser` | RSS 解析 | **唯一的运行时依赖** |
| `node:child_process` / 全局 `fetch` | 通道调用 | 内置，零依赖 |
| `node:http` | Web SSE 桥 | 内置，**不用 Express/Fastify/Hono** |
| `vitest` | 测试，配 Pi 的 faux provider | devDependency |
| 外部 CLI：`bili`、`yt-dlp`、`curl` | 内容源 | 用户环境自备，`/doctor` 检测 |

**`agents/` 目录不放 `pi` manifest 里**——按 subagent 扩展的约定，角色定义装在 `~/.pi/agent/agents/` 或 `.pi/agents/`（`subagent/README.md:142-146`）。安装脚本要处理这一步。

**不引入**：LangChain.js / Mastra / VoltAgent 等任何第二个编排框架。理由写进 README——引入第二个框架会让"你到底理解不理解 Agent 编排"这个问题无法回答。**这是加分项。**

**前端同样零依赖**：无 React/Vue、无 Vite、无 ECharts/D3，**连 `package.json` 都没有**。单个 `static/index.html`（预计 400–600 行，内联 CSS+JS），原生 `EventSource`，置信度曲线用**内联 SVG 手绘 `polyline`**。由 `node:http` 直接托管。好处：面试官 clone 下来 `npm install && pi install .` 就能跑，没有 Node 工具链版本地狱。

**vendor 而非 symlink `subagent` 扩展**：因为要改三处（Windows spawn 兼容、发 evidence 事件、假设树集成），而且 `docs/usage.md:309` 明确说这是扩展层能力、不是内核契约——symlink 意味着上游一改你就崩。**vendor 之后它就是你的代码，README 里注明衍生自 `examples/extensions/subagent/`。**

**参考但不 fork**：
- `Agent-Reach` —— 只借"通道清单 + doctor 自检 + 有序降级"这个**模式**，它本质是 installer + `SKILL.md`，不是库
- `OpenBiliClaw` —— **不要 fork**。88 MB、156 forks、日更，fork 等于永久 merge conflict；而且它是**推荐系统**不是**甄别系统**，方向就是错的

---

## 五、置信度：结构化而非"校准"

> **诚实标注**：上一版方案里这一层叫"贝叶斯校准"，先验从 50 条人工标注集拟合。**移除实验内容后，标注集没有了，"校准"这个词就不能再用了**——没有 ground truth 就没有校准。这一层降级为**结构化启发式置信度**，简历和 README 里都必须这么写。

保留的部分（这些不需要标注集）：

**不让模型自报置信度**。改为对一组可数特征做朴素贝叶斯形式的加权，**似然比手工设定并写进配置文件**，明确标注为启发式：

| 特征 | 取值 | 对"软广"的方向 | 权重来源 |
|---|---|---|---|
| 作者近 30 天同主题发文密度 | 计数 | 高密度 → 强正向 | 手工设定，可调 |
| 是否含优惠码/内推码/联系方式 | 布尔 | 含 → 正向 | 手工设定 |
| 发布时间与官方公告的时间差 | 天数 | 早于公告 → 强正向（预测式软文） | 手工设定 |
| 评论区是否存在反驳 | 布尔 | 无反驳且阅读量高 → 弱正向 | 手工设定 |
| 声称的样本量 | 枚举 | "我认识的人都" → 正向 | 手工设定 |

**保留的两个真正有价值的能力**（都不需要标注集）：

1. **可复现性**：同样的证据 → 同样的数字。这已经比"让 LLM 说它 80% 确定"强，因为后者同样输入两次会给不同答案。
2. **敏感性分析**：计算后验对每个特征的偏导，如果**后验高度依赖单个争议特征**，这条自动进入第 5 段「信息缺口」。这是纯数学，不需要 ground truth，而且是本项目最实用的输出之一——它告诉用户"这个结论悬在一根线上，去核实这根线"。

**反方 Agent 的职责因此精确化为：攻击似然比的取值，而不是攻击结论。** 它可以主张"发文密度高不等于软广，垂类博主也这样"，这条主张会被记录并体现在敏感性标注里。

---

## 六、系统架构

```
   /check "字节 2027 届前端实习转正率"
                    │
                    ▼
   ┌────────────────────────────────────────────┐
   │  主管 Agent（pi 主会话，持久，持有会话树）  │  目标：收敛但不调和
   │  extensions/hypotheses.ts 驱动              │  持有 fork/label 决策权
   └───────────────────┬────────────────────────┘
                       │ 每个假设 = 树上一个分支
      ┌────────────────┼────────────────┐
      ▼                ▼                ▼
 hyp/softad      hyp/stale        hyp/insufficient
 (open)          (abandoned)      (supported)
      │          └─ branchWithSummary(HYPOTHESIS_ABANDON_PROMPT)
      │             摘要留在树上，/tree 可见
      │
      │ 每个分支内，用专用工具派发（进程级隔离）
      ├─▶ dispatch_collector   → spawn pi --mode json -p --no-session
      ├─▶ dispatch_verifier    → spawn ...（干净上下文）
      └─▶ dispatch_contrarian  → spawn ...（schema 只收 claim + evidence_ids）
                    │
                    ▼
      ┌─────────────────────────────────┐
      │  ContentSource 工具层           │  pi.exec / fetch
      │  bili / yt-dlp / jina / rss     │  三级降级 + 磁盘缓存 + 限速
      └──────────────┬──────────────────┘
                     ▼
      ┌─────────────────────────────────┐
      │  pi.appendEntry("evidence",{})  │  ★ 不进 LLM 上下文
      │  与会话树同一份 JSONL           │  registerEntryRenderer 渲染
      └──────────────┬──────────────────┘
                     ▼
      ┌─────────────────────────────────┐
      │  calibration.ts                 │  结构化置信度 + 敏感性
      │  敏感项 → 第 5 段「信息缺口」   │
      └──────────────┬──────────────────┘
                     ▼
             5 段式报告（report.ts 校验第 5 段必填）

  Web 侧（可选）：node:http + session.subscribe + createEventBus
                  → SSE → static/index.html
```

### Web SSE（第 12 周，2–3 天）

`node:http` 起一个服务，用 SDK 的 `createAgentSession` + `session.subscribe`（`docs/sdk.md:80`）+ `createEventBus()`（`:658-670`）桥接：

事件类型：`agent_state` / `evidence` / `confidence` / `rebuttal` / `hypothesis` / `degraded` / `done`

- 四宫格 CSS grid 渲染三个子 Agent + 主管的状态机，`data-state` 驱动颜色
- **假设树侧栏**：从 `sessionManager.getTree()` 读，label 就是假设名，abandoned 的显示摘要——这是 Pi 方案独有的可视化，CubePi 版没有
- 证据时间线：每条 `evidence` append 一张卡片，点击展开 `rawSnippet`
- **置信度曲线：内联 `<svg>` 手绘 `polyline`**，x 轴 evidence 序号，y 轴后验。**反方 Agent 出手的点标红**——这是 demo 最有说服力的一帧
- `rebuttal` 用等宽字体原样渲染加醒目边框，视觉强调"这段没被主管改写"
- `degraded` 顶部横幅提示，呼应第 5 段

---

## 七、★ 移除实验内容的影响（必须知道）

上一版把「消融实验」列为核心竞争力第 2 位，理由是**它是唯一能定量证明多 Agent 必要性的硬证据**。移除之后：

| 影响 | 程度 |
|---|---|
| 多 Agent 必要性论证**只剩定性的架构论证**（第二节） | 中等——论证本身是自洽的，且 Pi 的进程级隔离 + schema 强制让它比大多数项目讲得实 |
| 简历 bullet 里那个 `__%` 数字**永久消失** | 已按你的决定接受 |
| 面试被追问"你怎么证明多 Agent 比单 Agent 好"时，**没有数据可给** | 这是最实际的风险 |

**零成本的替代方案（建议采纳，不额外花时间）**：做一个**定性对照演示**，不是实验。同一个输入跑两遍——一遍完整系统，一遍把 `contrarian.md` 从 `agents/` 里删掉——把两份报告的第 3 段并排放进 README 或录屏。**不测量、不声称统计显著性、只展示差异**。这保留了大部分说服力，成本约半小时。

措辞纪律：只能说"**去掉反方 Agent 后，第 3 段退化为对前文的修辞性复述**"（这是可直接观察的事实），**不能说**"假阴性率上升 X%"（这是你没做的测量）。

> 顺带记一笔，以免将来忘掉这个选项：Pi 自带 `packages/evals`，其 `evalHarnessTable(...)` 已经实现了 baseline/candidate/repetitions/judges/**pass-rate lift** 的完整对比方法论（`packages/evals/README.md:106-150`）。**如果哪天你想补上消融实验，基础设施是白送的，只需写三个 judge。** 本方案按你的决定不做。

---

## 八、13 周路线图（Week 0 spike + 12 周）

| 周 | 阶段 | 交付物（可验收） |
|---|---|---|
| **0** | **★ Spike** | 验证三个可能翻车的假设（见下节）。**产出一页决策记录。**不写生产代码，允许全部丢弃 |
| **1–2** | **内核与扩展机制** | 读完 `docs/extensions.md` 全文（1700+ 行）+ `docs/sdk.md`；跑通 `examples/sdk/01-minimal.ts` → `13-session-runtime.ts`；跑通 `examples/extensions/hello.ts` 和 `structured-output.ts`。**产出：一篇笔记，讲清 `pi.on` 的 5 个决策型 hook 与通知型 hook 的分发差异（`emitToolCall` 裸调用 = fail-closed），以及 `appendEntry` 为什么不进 LLM 上下文** |
| **3–4** | **工具层** | `extensions/sources.ts` 四个适配器 + 磁盘缓存 + 限速 + 三级降级；`extensions/doctor.ts` 与 `/doctor`。**验收：断网/通道失效时不崩溃，返回结构化的"源不可达"** |
| **5–6** | **证据层 + 单 Agent 打通** | `extensions/evidence.ts`（`appendEntry` + `registerEntryRenderer` + `session_start` 重建索引）；`extensions/report.ts` 5 段契约 + 第 5 段必填校验。**这一步刻意先用单 Agent**，作为第 7–8 周的对照 |
| **7–8** | **多 Agent 拆分** | vendor `examples/extensions/subagent/`；写 `agents/collector.md`、`verifier.md`、`contrarian.md`；`extensions/isolation.ts` 三个专用 dispatch 工具（★ schema 强制隔离）。**验收：反方工具的参数 schema 里不存在能传递前序结论的字段；实际运行中反方输出与单 Agent 基线的自我批评段有肉眼可见的实质差异** |
| **9–10** | **★ Tree-of-Hypotheses** | `extensions/hypotheses.ts`：`ctx.fork` 开假设分支 + `pi.setLabel` 编码状态机 + `ctx.navigateTree({summarize:true, customInstructions: HYPOTHESIS_ABANDON_PROMPT})` 放弃分支 + 跨分支证据去重。**技术含量最高的两周，预留 buffer** |
| **11** | **置信度 + 信息缺口** | `extensions/calibration.ts`：结构化置信度（手工权重，配置文件可调）+ 敏感性分析 + 敏感项自动进第 5 段 |
| **12** | **Web + 打包 + 收尾** | `web/` 的 `node:http` SSE 桥 + `static/index.html`（2–3 天）；`package.json` 的 `pi` manifest；本地 `pi install ./` 验证；README（含诚信边界与上游致谢）；asciinema 录屏；简历 bullet 定稿；面试问答卡 |

### Week 0 Spike：三个假设

**假设 A：subagent 的 spawn 派发在 Windows 上能跑通** ← ★ 这是换 Pi 后**新出现的、最大的**风险

`index.ts:250-259` 用 `process.execPath` + `process.argv[1]` 重新调用自己：

```ts
const currentScript = process.argv[1];
return { command: process.execPath, args: [currentScript, ...args] };
const execName = path.basename(process.execPath).toLowerCase();
return { command: process.execPath, args };
```

这段逻辑区分了"node 跑脚本"和"编译后的单二进制"两种情况。你的环境是 **win32**，仓库根目录有 `pi-test.bat` / `pi-test.ps1`，说明 Windows 是被支持的，但**bun 编译产物在 Windows 上的 `process.argv[1]` 行为、以及 `.ts` 扩展经 jiti 加载后能否被子进程再次解析，都必须实测**。

- **验证方法**：symlink subagent 扩展，在 PowerShell 和 Git Bash 两种 shell 下各跑一次 `Run 2 scouts in parallel`，看子进程是否正常返回、`--append-system-prompt` 的临时文件路径在 Windows 上是否正确。
- **若成立**：按计划推进。
- **若不成立**：改派发方式为固定 `pi` 可执行文件路径 + `--mode rpc`（`docs/rpc.md`），或退化为**同进程串行调用**——注意这会**牺牲进程级隔离**，第二节的论证需要相应弱化为"靠 schema 约束保证隔离"（schema 强制那部分仍然成立，因为它与进程模型无关）。

**假设 B：`systemPromptOverride` + `noTools:"all"` 能否把 coding 语义剥干净**

- **验证方法**：写 20 行 SDK 代码，`systemPromptOverride` 换成"你是信息甄别助手"、`noTools:"all"`、`customTools` 只放一个假工具，问它"你是谁、你能做什么"。检查回答里有没有残留的编程语义（提文件、提 bash、提代码库）。同时确认 `AGENTS.md` 上下文文件是否仍被注入（`DefaultResourceLoader` 会向上递归找 `AGENTS.md`，这在你的场景里可能是噪声）。
- **若不干净**：用 `agentsFilesOverride` 清掉上下文文件（`docs/sdk.md:709-716` 有范式），或传自定义 `ResourceLoader` 完全接管资源发现（`:365` 明确说传了自定义 loader 后 `cwd`/`agentDir` 不再控制资源发现）。

**假设 C：四路零配置内容源在你的网络环境下能跑通**

- **验证方法**：不写抽象层，四条命令手敲——`bili search "实习"`、`yt-dlp --write-auto-sub --skip-download <某视频>`、`curl https://r.jina.ai/<某招聘页>`、`rss-parser` 解析某官方公告 RSS。记录耗时、返回质量、是否需要代理。
- **若某路不通**（`yt-dlp` 最可能）：**直接删掉这一路，不要花时间对抗**。三路仍够支撑项目——数据源数量不是核心竞争力，甄别逻辑才是。把这次失败写进第 3–4 周的降级设计动机里，这反而是好面试素材（"我实测过通道失效，所以降级是一等公民不是兜底"）。
- **若 Jina Reader 不通**（国内网络可能有问题）：换本地正文抽取（`node-html-parser` + 自己写 readability 启发式），代价是多一个依赖，不影响架构。

**Spike 结束标准**：能回答"subagent 在 Windows 上能不能用"、"coding 语义剥干净了吗"、"最终数据源是几路"这三个问题。答不上来就再花两天，**不要带着未验证的假设进入第 1 周**。

### 弹性安排

如果第 9–10 周延期，**砍的顺序是**：① Web SSE 前端（TUI 里 `/tree` 已经能展示假设树，demo 够用）→ ② 跨分支证据去重 → ③ 假设状态机简化为只有 open/abandoned 两态。

**不能砍的是 schema 强制隔离（第 7–8 周）**——那是第二节整个论证的落点，砍了项目就退化成"一个 Agent 分四步走"。

---

## 九、核心竞争力（按面试价值排序）

| # | 独特点 | 为什么别人没有 | 一句话讲法 |
|---|---|---|---|
| **1** | **★ Tree-of-Hypotheses** | Pi 提供了会话树 + `branchWithSummary` + LCA 全套原语，但它们是为**人类在 TUI 里手动导航**设计的（`navigateTree` 返回 `{editorText?, cancelled}` 是编辑器语义）。没有任何地方把它们组合成多 Agent 假设搜索。CubePi 无树，根本做不了 | "我把 Pi 的会话树从人类导航改造成假设搜索机制：每个假设一个分支，`setLabel` 编码状态机，放弃时用改写过的 `customInstructions` 生成**假设裁决语义**的摘要留在树上，`/tree` 里直接可读" |
| **2** | **★ Schema 强制的上下文隔离** | 通行做法是在 system prompt 里写"请不要传递前序结论"，靠模型自觉 | "反方工具的参数 schema 里只有 `claim` 和 `evidence_ids`，原文由扩展侧解析。**主管无法表达它就无法泄漏**——隔离从纪律要求变成了类型约束" |
| **3** | **强制「信息缺口」段** | 所有同类系统的输出都是"给结论"，没有一个把"我判定不了什么"做成**契约级必填字段** | "过度自信是决策辅助系统的致命缺陷。我把不可知性做成输出 schema 的必填段，`report.ts` 里缺了就算运行失败" |
| **4** | **结构化置信度 + 敏感性分析** | 通用做法是让 LLM 说"我 80% 确定"，而 LLM 自报置信度与真实准确率几乎不相关 | "我不用模型自报的数字，用可数特征算。更重要的是**敏感性分析**：如果结论悬在单个争议特征上，这条自动进「信息缺口」，告诉用户去核实哪根线" |
| **5** | **证据用 `appendEntry` 而非独立数据库** | 通行做法是外挂 SQLite/向量库 | "Pi 的 custom entry **不进 LLM 上下文**，正好是证据溯源要的语义——可审计、可按 ID 取回，但不污染上下文。而且它和会话树同一份 JSONL，天然随分支一起 fork" |
| **6** | **反方职责被精确化** | 通常的批判 Agent prompt 是"你来挑毛病"，输出质量随机 | "反方不攻击结论，它攻击似然比的取值。这让它的工作可检查" |

**什么不是竞争力**（心里要有数，别在简历上吹）：
- 抓取能力 —— 全是现成 CLI，且随时可能失效
- Compaction / 会话树 / 分支摘要算法 / subagent 派发机制 / RPC / TUI —— **Pi 已提供**
- 多 Agent 必要性的**定量**证据 —— 按你的决定不做实验，**没有数据**

---

## 十、诚信边界（README 必须包含）

**禁止**：把 Pi 的能力（会话树、分支摘要、Compaction、subagent 派发）说成自己实现的；用"自研 Agent 框架"这类措辞；把 vendor 来的 1038 行 subagent 扩展当原创。

**必须**：README 顶部有「致谢与边界」段，明确列出上游提供了什么、你在哪一层做增量、`extensions/subagent/` 衍生自 `examples/extensions/subagent/`。

**措辞模板**（与简历保持一致）：
> "基于 Pi（MIT, Mario Zechner）构建的 Pi 包。**Pi 提供了会话树与分支摘要原语，但其语义面向人类在 TUI 中手动导航；在此前提下**，自主设计了面向多 Agent 假设搜索的 Tree-of-Hypotheses 编排层，改写了摘要 prompt 为假设裁决语义并实现跨分支证据去重。**在上游 subagent 示例仅提供通用派发参数的前提下**，实现了 schema 强制的上下文隔离。子 Agent 派发机制衍生自 `examples/extensions/subagent/`。"

**为什么这条比技术本身更重要**：面试官只要看一眼你的 `package.json` 里的 `peerDependencies`，就能判断你有没有夸大。主动划清边界的人，其余每句话都会被当成可信的；反之，一处夸大导致的信任崩塌会污染整个项目。**基于 MIT 项目做增量是完全正当的工程实践，把它包装成原创才是致命的。**

`docs/packages.md:20` 的安全声明也要在 README 里回应一句——Pi 包以完整系统权限运行，你的包**只读网络、不写用户文件、不执行任意命令**（`pi.exec` 的调用目标是固定的四个 CLI，参数经过校验），这本身是个可信度加分项。

---

## 十一、验证方案（不含实验/评测）

### 端到端 demo 脚本（录屏用）

```bash
# 0. 安装（README Quick Start 就这三行）
npm install
pi install ./                      # 或 pi install git:github.com/<you>/offerlens

# 1. 自检：证明通道降级是设计过的，不是运气
#    在 pi 里输入：
/doctor
#   ✓ bilibili   ok (bili 1.4.2)
#   ✓ youtube    ok (yt-dlp 2026.08.xx)
#   ✓ web        ok (jina reader)
#   ✓ rss        ok (rss-parser)
#   ✗ xiaohongshu  not supported by design (requires login)

# 2. 主流程
/check 字节 2027 届前端实习转正率

# 3. ★ 展示假设树（Pi 内置命令，零成本）
/tree
#   hyp/softad          (abandoned)  ← 展开可见假设裁决摘要
#   hyp/stale           (supported)
#   hyp/insufficient    (open)

# 4. ★ 展示隔离：反方工具的 schema
#    让主管尝试在派发反方时夹带质检结论，展示它在类型层面无处可放

# 5. 展示第 5 段：故意查一个信息极度稀缺的主题
/check 某小众公司 2027 实习待遇
#    报告第 5 段应列出"样本量不足"+"后验对'发文密度'单一特征敏感"

# 6. 展示证据溯源：从报告第 2 段任取一个 evidence_id
#    TUI 里 Evidence 卡片可展开原文（registerEntryRenderer）

# 7. Web 可视化（可选）
node web/server.js                 # 浏览器开 localhost:8000，无需 npm
# ★ 录屏重点：反方 Agent 出手时 SVG 置信度曲线出现红点、概率被明显拉低
```

### 定性对照演示（替代已移除的消融实验，约半小时）

同一输入跑两遍，第二遍把 `agents/contrarian.md` 移走，把两份报告的第 3 段并排放进 README。**只展示差异，不测量、不声称统计显著性。**

措辞：✅"去掉反方 Agent 后第 3 段退化为对前文的修辞性复述" ❌"假阴性率上升 X%"

### 故障注入测试（第 3–4 周验收项）

- 断网 / 单通道 5xx → 不崩溃，报告出现"源不可达"并计入「信息缺口」
- `yt-dlp` 被风控（真实会发生）→ 自动降级，TUI/SSE 推送降级事件
- 子进程非零退出 / `stopReason: "error"` / `stopReason: "aborted"` → 按 `subagent/README.md:165-170` 的语义正确处理；chain 模式在首个失败步骤停止并报告是哪一步
- Ctrl+C → abort 传播到所有子进程（上游已实现，验证它在本项目里仍生效）
- Evidence 出现重复 `contentHash` → 去重生效，似然比不被重复计入
- 第 5 段缺失 → `report.ts` 校验失败，运行判定为失败

### 单元测试（`vitest` + Pi 的 faux provider，不用真实 API key）

- `isolation.ts`：断言三个 dispatch 工具的参数 schema **不含**任何可传递前序结论的字段；断言 `evidence_ids` 被解析为 `rawSnippet` 而非质检结果
- `hypotheses.ts`：断言 `setLabel` 写入的状态机编码可被 `getLabel` 读回；断言放弃分支时 `navigateTree` 收到的 `customInstructions` 是 `HYPOTHESIS_ABANDON_PROMPT`
- `evidence.ts`：断言 `appendEntry` 的自定义 entry 不出现在发给 LLM 的 messages 里；断言 `session_start` 能从 JSONL 重建索引
- `calibration.ts`：给定特征向量断言后验与敏感性标注；断言单特征主导时产出「信息缺口」条目
- `sources.ts`：mock `pi.exec` 输出，断言解析与三级降级
- `report.ts`：断言第 5 段缺失时抛错

---

## 十二、简历 bullet 定稿（第 12 周产出，先固定口径）

> **OfferLens — 校招/实习信息多智能体甄别助手**（个人项目，TypeScript / Pi 扩展 / 已发布为 Pi 包）
> - 基于 Pi（MIT）构建四角色交叉验证系统，通过**独立上下文 + 对立目标**的编排解决单 Agent 自我反驳退化为修辞的问题；**将反方 Agent 的派发工具参数 schema 限制为仅接受主张与证据 ID，使编排者无法在类型层面泄漏前序结论**
> - **在 Pi 的会话树与分支摘要原语仅面向人类 TUI 导航的前提下**，自主设计 Tree-of-Hypotheses 编排层：每个假设对应一个树分支，`setLabel` 编码假设状态机，放弃分支时以改写的假设裁决 prompt 生成摘要留存，实现跨分支证据去重
> - 利用 Pi 自定义 entry **不进入 LLM 上下文**的特性实现证据溯源层，使证据可审计、可按 ID 取回而不污染推理上下文，且与会话树共享同一份 JSONL
> - 实现结构化置信度与**敏感性分析**替代不可靠的 LLM 自报置信度，将「信息缺口」设计为输出契约的强制字段并由扩展校验
> - 封装四路零配置内容源（Bilibili / YouTube / Jina Reader / RSS），实现三级降级、磁盘缓存与 `/doctor` 通道自检

**填写纪律**：
1. **不得出现任何百分比数字**。你没做测量，写了就是编造。
2. **「四路」以 Week 0 spike 的实测结果为准**。不通就改成实际的三路/两路并列出真实通道名。**宁少勿虚。**
3. **"已发布为 Pi 包"只有在 `pi install git:...` 真的能被第三方跑通之后才能写**。
4. 若假设 A（Windows spawn）不成立、退化为同进程串行，**第 1 条里"独立进程"相关表述必须删掉**，只保留 schema 强制隔离那半句（它与进程模型无关，仍然成立）。

---

## 关键路径速查

`pi-src/` 已确认保留在工作区：`C:\Users\86186\Documents\Qoder\2026-09-02\9fc6ad4b\pi-src\`

| 用途 | 路径 |
|---|---|
| ★ subagent 派发实现（vendor 源） | `packages/coding-agent/examples/extensions/subagent/index.ts`（1038 行）：`:250-259` Windows/execPath 分支、`:300` `["--mode","json","-p","--no-session"]`、`:307` `--tools`、`:338` `--append-system-prompt`、`:341` `Task:`、`:346` `spawn`、`:442-472` TypeBox schema + `registerTool` |
| ★ subagent 使用说明 | 同目录 `README.md`：`:96` parallel(max 8, 4 concurrent)、`:116` 50KB cap、`:127-146` agents/*.md frontmatter 与 `agentScope`、`:165-170` 错误语义 |
| ★ 扩展 API 全文 | `packages/coding-agent/docs/extensions.md`：`:139-152` Available Imports、`:1471-1487` `appendEntry`（**不进 LLM 上下文**）、`:1508-1523` `setLabel`、`:1172` `ctx.fork`、`:1198` `ctx.navigateTree`、`:1668` `pi.exec`、`:1361` `pi.on`、`:1365` `registerTool`、`:1525` `registerCommand`、`:1618` `registerEntryRenderer` |
| ★ SDK | `packages/coding-agent/docs/sdk.md`：`:80` `subscribe`、`:100` `navigateTree` 签名、`:508-513` `systemPromptOverride`、`:522-526` 工具开关、`:582-603` `defineTool`、`:658-670` `createEventBus`、`:709-716` `agentsFilesOverride`、`:822-825` `runtime.fork`、`:830-853` SessionManager 树 API、`:1111-1165` RPC 模式 |
| ★ Pi 的架构哲学（面试引用） | `packages/coding-agent/docs/packages.md:20`（安全声明）、`:120-131`（`pi` manifest）、`:137`（pi.dev/packages gallery）、`:160-165`（约定目录）、`:171`（peerDependencies 规则）；`docs/usage.md:309`（**故意不含 MCP/subagent/plan mode/todo**） |
| 分支摘要原语 | `packages/coding-agent/src/core/compaction/branch-summarization.ts`：`:108-146` LCA、`:258-285` 5 段 prompt（改写基础）、`:350` maxTokens 2048 |
| Compaction | `packages/coding-agent/src/core/compaction/compaction.ts`：`:467-498` 6 段、`:500-539` 增量更新、`:403-461` `findCutPoint` |
| 会话树持久化 | `packages/coding-agent/src/core/session-manager.ts`：`:1016-1043` `_persist`、`:1045-1049` `_appendEntry`、`:931-957` `newSession` |
| SDK 示例（第 1–2 周逐个跑） | `packages/coding-agent/examples/sdk/01-minimal.ts` … `13-session-runtime.ts` |
| 其它可参考扩展示例 | `examples/extensions/`：`structured-output.ts`、`custom-compaction.ts`、`trigger-compact.ts`、`event-bus.ts`、`dynamic-tools.ts`、`tool-override.ts`、`permission-gate.ts`、`plan-mode/`、`handoff.ts`、`todo.ts` |
| 测试基建 | `packages/ai/src/providers/faux.ts`、`packages/coding-agent/test/suite/harness.ts`、`test/suite/regressions/8261-subagent-project-trust.test.ts` |
| （范围外，备查）评测基建 | `packages/evals/README.md:106-150` `evalHarnessTable` baseline/candidate/lift |
