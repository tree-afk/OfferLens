# OfferLens — 校招/实习信息多智能体甄别助手（Pi 包）

输入一个岗位方向或一条待核实的说法，主管 Agent 在**会话树上为每个假设开一个分支**，每个分支派发三个目标互相冲突的子 Agent（采集 / 质检 / 反方）在**独立上下文**中工作；被放弃的假设以**假设裁决语义的摘要**留在树上；最终输出一份带证据溯源、带**结构化置信度**、并**强制标注「我不知道什么」**的 5 段式决策报告。

> **当前版本状态：Pi 包形态 + 模型占位。** 本仓库已是一个可 `pi install` 的 Pi 包（`keywords: ["pi-package"]`）。四个角色默认走 `offerlens-placeholder` provider——**确定性、离线、不接任何 LLM API**，因此整条链路（假设规划 → 派发 → schema 强制 → 内容源 → 置信度 → 5 段报告）**不需要 API key 就能端到端跑通与验证**。要切到真实模型，只需在 Pi 里切模型（见下文「模型」）。

---

## 致谢与边界（诚信声明）

基于 [Pi](https://github.com/earendil-works/pi)（MIT, Copyright (c) 2025 Mario Zechner）构建的 Pi 包。

**Pi 提供的能力（不是本项目的贡献）：**

- Agent 循环 / 事件系统 / Compaction
- 会话树与分支摘要原语（`SessionManager`、`branchWithSummary`、LCA）
- Subagent 派发机制（`extensions/subagent/` 衍生自 Pi 的 `examples/extensions/subagent/`，见 `extensions/subagent/VENDOR-NOTES.md`）
- 扩展 API（`pi.on`、`registerCommand`、`registerTool`、`registerProvider`、`registerEntryRenderer`、`appendEntry`、`setLabel`、`exec` 等）
- TUI / RPC / 测试基建

**本项目的增量贡献：**

- **Tree-of-Hypotheses**：将 Pi 的会话树从人类 TUI 导航改造成多 Agent 假设搜索；把摘要 prompt 改写为假设裁决语义；实现跨分支证据去重（`contentHash` 全局去重）
- **Schema 强制的上下文隔离**：在上游 subagent 示例仅提供通用派发参数的前提下，实现了专用 dispatch 工具的封闭 schema，使编排者在类型层面**无法**泄漏前序结论
- **证据溯源层**：利用自定义 entry 不进 LLM 上下文的特性实现证据审计，可按 ID 取回原文而不污染推理上下文
- **结构化置信度 + 敏感性分析**：手工权重的似然比 + tanh 饱和 + 语料级结构调整 + 逐特征中和分析
- **5 段报告契约**：第 5 段「信息缺口」为强制字段，缺失即 `ReportValidationError`

**安全声明**：本包只读公开网络、不写用户文件（除 `.offerlens/` 会话与缓存目录）、不执行任意命令（子进程派发目标是固定的 `pi` 自身；网络侧只有固定的内容源与 `yt-dlp`，且仅处理用户显式给定的 URL）。小红书等需登录平台明确排除（by design）。

---

## 快速开始

### 1. 安装

```bash
npm install                 # 安装 @earendil-works/* peer deps 与 devDeps(vitest, typescript)
pi install ./ -l            # 安装为项目本地 Pi 包（写入 .pi/settings.json）
# 或：pi install ./          # 安装为全局 Pi 包
```

> **信任提示**：Pi 加载项目本地包（`-l`）时需要显式信任——在 TUI 里批准，或运行时加 `--approve`。这是 Pi 对本地代码的安全默认，不是本项目特有。
>
> 安装后建议先执行 `/offerlens-setup`，把 `agents/*.md`（三角色定义）同步到 `.pi/agents/`，供 subagent 派发发现。

### 2. 核心命令（在 Pi 会话内）

```
/doctor                                   # 通道自检：四路内容源 + 显式声明小红书不做 + 当前派发模式
/check 字节 2027 届前端实习转正率          # 主流程 → 5 段式甄别报告
/check --url <视频链接> --claim <待核实说法> <问题>
/scan 多智能体方向 2027 届秋招             # 主动扫描：行动建议权重加大
/report                                   # 把最近一次报告导出为 markdown（.offerlens/reports/）
/abandon <slug>                           # 放弃指定假设分支：navigateTree + 假设裁决 prompt 生成摘要（需真实模型）
/offerlens-setup                          # 同步 agents/*.md → .pi/agents/
```

### 3. 开发与验证

```bash
npm test                    # vitest，57 项单元测试（不打真实网络，不需要 API key）
npm run typecheck           # tsc --noEmit，0 错误
npm run web                 # Web SSE 可视化桥 → http://127.0.0.1:8787
```

> Web 桥以 `.ts` 直接托管（`node --experimental-transform-types`），需要 Node ≥ 22.7；扩展本身由 Pi 的 jiti 加载，Node ≥ 20 即可。

### 4. 核验安装是否成功

```bash
pi --offline --approve --list-models | grep offerlens     # 应出现 offerlens-placeholder-v1
pi --offline -p --no-session --approve \
   --model offerlens-placeholder/offerlens-placeholder-v1 "ping"
# 预期输出：{"error":"OfferLens 占位模型：缺少 Task 载荷（应由 offerlens 派发工具提供）"}
# —— 这条错误恰恰证明扩展已加载、provider 已注册、agent 循环离线可跑。
```

---

## 模型

模型与凭据由 **Pi 管理**，本项目不提供模型配置（迁移前 `config/config.json` 里的 `providers` 段已删除）。

- **默认（占位）**：扩展通过 `pi.registerProvider` 注册 `offerlens-placeholder/offerlens-placeholder-v1`。它是确定性的——`/check` 走**程序化编排**路径（`runProgrammaticCheck`），四个角色在进程内确定性执行。schema 约束与真实模型路径**完全一致**。
- **真实模型**：在 Pi 里切换到任一真实模型（如 `--model anthropic/...`）。`/check`、`/scan` 检测到非占位 provider 后，会**注入 `prompts/check.md` / `scan.md` 模板**，由该模型驱动同一组 dispatch 工具完成编排。角色定义（`agents/*.md`）即 system prompt。
- **子 Agent 的真实隔离**：`dispatchMode: "subagent"` 时，派发工具经 vendored subagent 扩展 `spawn pi --mode json -p --no-session --model offerlens-placeholder/...`，子进程继承父模型选择。Windows 兼容经验（`windowsHide`、不经 `argv[1]` 自举）已带入 vendor 版本。

---

## 命令与工具清单

| 类型 | 名称 | 说明 |
|---|---|---|
| 命令 | `/check` | 甄别主流程，产出 5 段式报告 |
| 命令 | `/scan` | 主动扫描某方向的当前机会面 |
| 命令 | `/abandon` | 放弃假设分支并生成 Pi 原生裁决摘要 |
| 命令 | `/report` | 导出最近一次报告为 markdown |
| 命令 | `/doctor` | 通道自检 + 派发模式 + 角色定义就位检查 |
| 命令 | `/offerlens-setup` | 同步角色定义到 `.pi/agents/` |
| 工具 | `dispatch_collector` | 派发采集（封闭 schema） |
| 工具 | `dispatch_verifier` | 派发质检，只收 `evidence_ids` + `claim` |
| 工具 | `dispatch_contrarian` | 派发反方，schema **物理上不存在** verdicts/reasoning/summary |
| 工具 | `fetch_bilibili` | B 站搜索（wbi 签名直连公开 API，零登录） |
| 工具 | `fetch_web` | 网页正文抓取（Jina Reader → 直连，三级降级） |
| 工具 | `fetch_rss` | RSS/Atom 官方源解析（`channelAuthority=official`，最高权重） |
| 工具 | `fetch_youtube` | YouTube 字幕（yt-dlp，未安装则如实降级） |
| 渲染 | `evidence` entry renderer | TUI 里把证据渲染为卡片，可展开原文 |
| 渲染 | `offerlens-report` message renderer | 报告在 TUI 里的呈现 |

---

## 输出契约（5 段，第 5 段强制）

| 段 | 内容 |
|---|---|
| 1. 结论摘要 | 一句话结论 + **结构化置信度**（可数特征的后验 + 敏感性标注），不是"高/中/低"，也不是模型自报 |
| 2. 证据清单表 | 每条：URL / 平台 / 发布时间 / 作者 / 时效 / 样本量 / 引流要素 / `evidence_id` |
| 3. 反面证据 | 反方 Agent 原始输出，**不被主管改写、不被折叠** |
| 4. 行动建议 | 具体到官方渠道与"问哪三个问题" |
| 5. ⚠️ 信息缺口 | **强制段**：无法判定的部分及为什么；缺失 = `ReportValidationError` = 运行失败 |

---

## 架构

```
/check "求职问题"
        │
        ▼
主管（supervisor，持会话树）── 目标：收敛但不调和
        │ 每个假设 = 树上一个分支（setLabel 状态机：open → supported/refuted/abandoned/insufficient-evidence）
   ┌────┼─────────────┐
   ▼    ▼             ▼
hyp/softad   hyp/stale   hyp/insufficient
（放弃的分支：navigateTree + 假设裁决 prompt 留下 5 段摘要，/tree 可读）
        │ 每个分支内派发（subagent 模式 = 独立 pi 进程，父历史物理不可达）
        ├─▶ dispatch_collector  → 四路内容源（真实网络 + 三级降级）
        ├─▶ dispatch_verifier   → 只收 evidence_ids（派发侧解析为原文）
        └─▶ dispatch_contrarian → schema 只收 claim + evidence_ids
        ▼
证据库（appendEntry 语义：custom entry 不进 LLM 上下文，与会话树同一份 JSONL，contentHash 跨分支去重）
        ▼
置信度引擎（朴素贝叶斯形式 + tanh 饱和 + 语料级结构调整 + 敏感性分析）
        ▼
5 段式报告（第 5 段缺失即失败）
```

---

## 核心设计（对应计划文档的自主实现部分）

### ① Tree-of-Hypotheses

Pi 的会话树/分支摘要原语面向人类 TUI 导航；本项目把它们改造成**多 Agent 假设搜索**：每个假设一个树分支，`setLabel` 编码状态机（`hyp/<slug>/<state>`），放弃分支时用假设裁决语义的 5 段摘要（假设 / 支持证据 / 推翻证据 / 放弃理由 / 对其它分支的启示）留存，跨分支证据靠 `contentHash` 全局去重。实现：`extensions/hypotheses.ts` + `extensions/lib/orchestrator.ts`。

### ② Schema 强制的上下文隔离

进程隔离保证"父历史传不过去"，但没保证主管只传原始证据。解法是**让泄漏在类型层面无法表达**：派发工具载荷是封闭 schema（`additionalProperties: false`），反方工具的参数里**物理上不存在** verdicts / reasoning / summary 字段；出现 schema 外字段 = 派发直接失败（fail-closed）。`evidence_ids` 由派发侧机械解析为原文，主管只能传"句柄"。**主管无法表达它就无法泄漏。** 实现：`extensions/isolation.ts` + `extensions/lib/schema.ts`。

### ③ 证据溯源层（appendEntry 语义）

证据以 `customType: "evidence"` 的自定义条目写进会话同一份 JSONL：可审计、可按 ID 取回原文，但**不进入 LLM 上下文**（否则 20 条证据全文进上下文，又回到确认偏误的老问题）。子 Agent 通过 `resolveRawSnippets` 拿到的只有原文字段。TUI 里由 `registerEntryRenderer("evidence")` 渲染为卡片。实现：`extensions/evidence.ts` + `extensions/lib/evidence.ts`。

### ④ 内容源工具层（三级降级）

Bilibili（`bili` CLI 优先 → **wbi 签名直连公开搜索 API**（cookie 引导 + `w_rid` 签名，零登录）→ 不可达）、Web（Jina Reader → 直连抓取 + 内置正文抽取 → 不可达）、RSS（官方公告源，最高可信权重，内置零依赖解析器）、YouTube（yt-dlp 只取字幕，未安装即如实报告）。通道失效**不是错误，是要报告给用户的事实**——不可达计入第 5 段信息缺口。磁盘缓存 TTL 24h + 每通道限速；不做任何反爬对抗、验证码绕过、登录态注入。实现：`extensions/sources.ts` + `extensions/lib/sources.ts`。

### ⑤ 结构化置信度 + 敏感性分析

不让模型自报置信度（LLM 自报置信度与真实准确率几乎不相关）。对可数特征做朴素贝叶斯形式的加权，似然比手工设定在 `config/likelihood-ratios.json`（可调、启发式、**非校准**——没有标注集就没有 ground truth）。三个保真设计：

- **相关性门**：质检判定跑题的证据被排除出后验（跑题的证据不是证据）；
- **tanh 饱和**：同特征 N 条证据的贡献不是独立的（同温层），30 条"无引流要素"不能当 30 条独立证据叠加；
- **语料级结构调整**：无官方口径、单平台等结构性缺陷直接计入后验。

敏感性分析逐特征中和重算后验，|ΔP| 超阈值 → 自动进第 5 段："这个结论悬在一根线上，去核实这根线"。实现：`extensions/lib/calibration.ts` + `config/likelihood-ratios.json`。

---

## 派发模式

`config/config.json` 的 `dispatchMode` 控制角色执行层的实现：

| 模式 | 含义 | 需要什么 |
|---|---|---|
| `stub`（默认） | 角色逻辑**进程内确定性执行**（占位期）。schema 约束与真实路径完全一致 | 无——离线可跑 |
| `subagent` | 经 vendored subagent 扩展 `spawn pi --mode json -p --no-session` 派发**真实独立进程** | Pi 运行时 + 真实模型 |

> 两种模式下「主管能传给子 Agent 什么」由同一组封闭 schema 决定，因此隔离性质不因模式而变。

---

## 目录结构

```
offerlens/
├── package.json            # Pi 包 manifest（keywords: pi-package + pi.extensions/pi.prompts）
├── extensions/             # ★ Pi 扩展（jiti 直接加载 .ts，无编译步骤）
│   ├── hypotheses.ts       # /check /scan /abandon /offerlens-setup + Tree-of-Hypotheses 集成
│   ├── isolation.ts        # dispatch_* 三个封闭 schema 工具（上下文隔离）
│   ├── evidence.ts         # 证据 entry renderer + session_start 索引重建
│   ├── sources.ts          # 四路 fetch_* 工具 + /doctor + placeholder provider 注册
│   ├── report.ts           # /report 命令 + 报告 message renderer
│   ├── lib/                # 纯逻辑层（可单测，零 Pi 依赖）
│   │   ├── orchestrator.ts # runCheckFlow：假设规划→分支→派发→裁决→聚合→报告
│   │   ├── roles.ts        # 三角色桩逻辑 + HYPOTHESIS_ABANDON_PROMPT
│   │   ├── calibration.ts  # 后验 / tanh 饱和 / 敏感性分析
│   │   ├── report.ts       # 5 段报告装配 + 第 5 段强制校验
│   │   ├── features.ts     # 确定性特征抽取（促销码/样本量/时效/密度/反驳）
│   │   ├── evidence.ts     # EvidenceIndex（contentHash 去重）
│   │   ├── sources.ts      # 四通道 + 三级降级 + 磁盘缓存 + 限速 + wbi 签名
│   │   ├── schema.ts       # TypeBox 封闭 schema + fail-closed 校验
│   │   ├── provider-placeholder.ts # 占位 provider（离线确定性）
│   │   ├── config.ts types.ts util.ts runtime.ts
│   └── subagent/           # vendor 自 Pi examples/extensions/subagent（MIT）
├── agents/                 # 三角色定义（YAML frontmatter），/offerlens-setup 同步到 .pi/agents/
├── prompts/                # check.md / scan.md 工作流模板
├── config/                 # config.json（运行时）+ likelihood-ratios.json（似然比表）
├── test/                   # vitest（56 项）
└── web/                    # server.ts（SSE 桥）+ static/index.html（单文件前端）
```

---

## 与计划文档（`grounded-tide-robin.md`）的对应与偏差

**如实标注偏差（没有悄悄淡化）：**

| 计划项 | 当前实现 | 说明 |
|---|---|---|
| Pi 包（`pi install git:…`） | ✅ 已达成：`pi install ./ -l` 实测通过；占位 provider 出现在 `--list-models` 中 | 真实模型仍需用户自行在 Pi 里配置 |
| `rss-parser` 依赖 | 内置极简 RSS/Atom 解析器（`extensions/lib/sources.ts`） | 零依赖运行；换回 `rss-parser` 只需改这一个文件 |
| `extensions/doctor.ts` 独立文件 | `/doctor` 注册在 `extensions/sources.ts` | 与四路通道探测同处一个文件更内聚，未拆独立文件 |
| 消融实验 / 评测 | **按计划不做** | 只保留定性对照（`scripts/compare-contrarian.sh`），不声称任何未测量的百分比 |
| 子进程派发 | `stub` / `subagent` 双模式，后者经 vendored Pi subagent | Windows 直跑经验（`windowsHide`、不经 `argv[1]` 自举）已带入 vendor 版本 |
| Web SSE 用 Pi SDK | `web/server.ts` 直接驱动 `extensions/lib` 的 `runCheckFlow`，并用进程内 hooks 复刻 `appendEntry`/`setLabel` 语义 | 独立托管的 Web 桥没有 Pi 运行时，故不能直接 `createAgentSession`；事件契约与前端**保持不变** |

---

## 安全声明

以 Pi 的 `docs/packages.md` 安全声明为参照：本包**只读公开网络、不写用户文件（除 `.offerlens/` 会话与缓存目录）、不执行任意命令**（子进程派发目标是 `pi` 自身；外部 CLI 只有 `yt-dlp` 且仅处理用户显式给定的 URL）。唯一写盘动作是**用户主动执行** `/offerlens-setup` 时把角色定义复制到项目内的 `.pi/agents/`。小红书等需登录平台明确排除（by design）。
