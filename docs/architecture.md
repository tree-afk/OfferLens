# OfferLens 架构

> 从 README 拆出。README 只留一句话概要与链接；本文承载流水线图与模块边界。

## 流水线

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

主管的调用序列由 `prompts/check.md` 约束：`begin_check` →（每分支）`dispatch_collector` →
`register_evidence` → `dispatch_verifier` → `dispatch_contrarian` → `finalize_report`。
前四步是编排决策，最后一步是确定性尾巴：`finalize_report` 内部依次跑
`computePosterior` → 敏感性分析 → `buildReport` → 第 5 段校验，主管不参与打分与措辞。

## 模块边界

依赖关系由 import 实测得出（非手工整理）。

### 扩展层（持有 Pi 运行时 API）

| 模块 | 做什么 | 怎么用 | 依赖（仓内） |
|---|---|---|---|
| `extensions/hypotheses.ts` | 注册 `/check` `/scan` `/abandon` `/offerlens-setup`，接 Tree-of-Hypotheses 与 Pi 会话树 | 用户命令 | `isolation` `orchestrator` `provider-placeholder` `runtime` `evidence` `config` `roles` `util` |
| `extensions/checkflow.ts` | LLM 主管的编排工具：`begin_check` / `register_evidence` / `finalize_report` | 主管调用 | `calibration` `config` `evidence` `report` `runstate` `runtime` |
| `extensions/isolation.ts` | 三个封闭 schema 的 `dispatch_*` 工具 + 子进程"提交结果"的 `emit_*` 工具 | 主管调用 | `schema` `roles` `runstate` `runtime` `evidence` `config` |
| `extensions/sources.ts` | 四路 `fetch_*` 工具、`/doctor`、placeholder provider 注册 | 子 Agent 调用 | `lib/sources` `provider-placeholder` `runtime` `config` `util` |
| `extensions/evidence.ts` | `evidence` entry 渲染器 + `session_start` 索引重建 | Pi 事件驱动 | `lib/evidence` |
| `extensions/report.ts` | `/report` 导出 + 报告 message 渲染 | 用户命令 / 事件 | `runtime` `config` `util` |
| `extensions/subagent/` | **vendored**：派生子进程，隔离上下文 | 被 `isolation` 使用 | （上游 Pi examples，不参与格式化与覆盖率口径） |

### 纯逻辑层（`extensions/lib/`）

| 模块 | 做什么 | 依赖（仓内） | 是否有 Pi 耦合 |
|---|---|---|---|
| `orchestrator.ts` | `runCheckFlow`：规划→分支→派发→裁决→聚合→报告（程序化路径） | `calibration` `config` `evidence` `report` `roles` `sources` | 否 |
| `roles.ts` | 三角色执行逻辑（桩 + 混合质检）+ 裁决摘要 prompt | `features` `util` | 否 |
| `calibration.ts` | 后验 / tanh 饱和 / 语料级调整 / 敏感性分析 | `config` | 否 |
| `report.ts` | 5 段报告装配 + 第 5 段强制校验 | `config` `util` | 否 |
| `features.ts` | 确定性特征抽取（促销码 / 样本量 / 时效 / 密度 / 反驳） | `util` | 否 |
| `evidence.ts` | `EvidenceIndex`（contentHash 跨分支去重） | `util` | 否 |
| `sources.ts` | 四通道 + 三级降级 + 磁盘缓存 + 限速 + wbi 签名 | `config` `util` | 否 |
| `schema.ts` | TypeBox 封闭 schema + fail-closed 校验 | — | 否 |
| `config.ts` / `util.ts` / `types.ts` | 配置装载、杂项、类型 | — | 否 |
| `runstate.ts` | LLM 主管路径的进程内运行态（分支↔证据映射） | `roles` | 否 |
| `runtime.ts` | Pi 扩展上下文的适配/取用 | `sources` | **仅 type-only**（编译期擦除） |
| `provider-placeholder.ts` | 离线确定性 provider，让全链路无 key 可跑 | `roles` | **有值导入**（`createProvider` 等） |

> 因此"lib 层零 Pi 依赖"这句话**不成立**：`types.ts` 之外，`runtime.ts` 是类型级耦合（可擦除），
> `provider-placeholder.ts` 是真实的值级耦合。单测不需要 Pi，是因为没有测试导入这两个文件——
> 不是因为它们不依赖 Pi。

## 两条编排路径

同一组封闭 schema、同一个确定性尾巴，区别只在"谁决定调用顺序"：

| 路径 | 谁编排 | 触发条件 | 入口 |
|---|---|---|---|
| 程序化 | `lib/orchestrator.ts` 的 `runCheckFlow` 固定顺序 | `dispatchMode: "stub"`，或占位模型 | `extensions/hypotheses.ts` |
| LLM 主管 | 模型按 `prompts/check.md` 依次调用工具 | `dispatchMode: "subagent"` + 真实模型 | `extensions/checkflow.ts` + `extensions/isolation.ts` |

两条路径产出的 `ContributionRow[]` 与报告契约相同，因此 `finalize_report` / 置信度引擎不需要知道走了哪条。

### 主管的数据可见面（2026-09-23 起）

LLM 主管**只搬运句柄，不搬运数据**：

| 环节 | 主管收到 | 实体留在 |
|---|---|---|
| `dispatch_collector` | `collect_id` + 条数 + `degraded_count` | 运行态 `collections` |
| `register_evidence` | `evidence_ids`（约 427 字符） | 证据库（custom entry，本就不进上下文） |
| `dispatch_verifier` | `on_topic / tangent / unknown` 计数 | 分支 `assessments` |
| `dispatch_contrarian` | 是否构造出反驳 + 调整条数 | 分支 `contrarian` |

这一层收窄同时买到了两样东西：一是把"主管重打证据"的开销去掉（实测那一步曾占整轮模型输出的
九成以上），二是让**「不调和」成为数据流约束而不是提示词请求**——主管看不到逐条评估与反方全文，
就没有可被它调和的对象。报告第 3 段的反方原文由 `finalize_report` 直接从运行态取，不经过主管。

