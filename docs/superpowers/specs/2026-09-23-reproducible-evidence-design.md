# spec-2 可复现证据（OfferLens）

日期：2026-09-23 · 状态：待评审 · 取向：求职可展示（轴3 + 轴2 最小切片）
前置：依赖 spec-1 的 git 基线与 CI（没有 CI，回归无处落；没有 git，回归无处比）。

## 1. 目标与非目标

**目标**：把"这套东西真的有效"从一句 README 主张，变成两类各自诚实、且互不冒充的产物——**CI 里的确定性回归**，和**仓库里的一次真模型留证**。

**非目标**：

- 不做标注集与似然比校准。README 与 `config/config.json` 现已明确声明"手工权重、启发式、非校准"，本 spec **不改这个立场**，也不引入未测量的百分比。
- 不在 CI 里调用任何真实模型。
- 不把 `web/` 纳入回归范围（其事件契约由 `test/orchestrator.test.ts` 间接覆盖）。

## 2. 事实基线（2026-09-23 实测）

| 事实 | 证据 |
|---|---|
| 真模型端到端**跑通过**，但仓库层零留痕 | `.offerlens/sessions/` 最新目录停在 09-16 20:18；`.offerlens/reports/` 最新是 09-16 20:19 的 stub 产物（`派发模式 stub`、`P(可靠)=14.8%`、35.2s） |
| 今天的产物只以临时文件存在 | `.tmp_check_out3.jsonl` 1.7MB / 3492 行，内含 `subagent`、`555`、`P(可靠)=17.4`；`.tmp_report.md` 为 09-23 一次 66.6s 的产物；`.tmp_check_err*.log` 三个 0 字节 |
| 接缝已存在，无需新架构 | `createChannels(config, fetchImpl)` 可注入假 fetch（`test/sources.test.ts` 已在用）；`createStubExecutor` 进程内确定性；`runCheckFlow` 是纯逻辑入口 |
| 报告含非确定字段 | `运行耗时`、`生成于 <ISO 时间>`、session id、跨分支 `contentHash` 派生的 id |
| 测试里存在会被报告渲染的第三方文本 | `RawItem` 的 `author`、`title`、`rawSnippet`、`comments[]`；`report.ts:150-151` 渲染 `title` 与 `author` |

结论：**"跑通"与"留痕"是两件事，现在缺的是后者**。

## 3. 两条轨道，以及不许互相冒充的口径

这是本 spec 的核心设计，先把口径钉死：

| | 轨道 A：合成 golden 回归 | 轨道 B：真实数据脱敏留证 |
|---|---|---|
| 输入 | `test/fixtures/sources/*.json`，形状与 `RawItem` 一致但**内容合成** | 真模型一次跑落的原始事件流与报告 |
| 跑在哪 | CI，每次 push，4 个 job | 人工触发，产物入 `docs/evidence/` |
| 证明什么 | 改任何一处逻辑，结论会变（回归防护） | 真实网络 + 真实模型下端到端能出契约完整的报告 |
| **禁止** | 不得写成"真实案例的置信度"；A 的 P(可靠) 只用于比对，不用于叙事 | 不得充当回归基线（它不在 CI 跑、且模型非确定）；不得声称可复现 |

**为什么必须分两条**：脱敏会改变被测系统的输入。`detectCommentRebuttal` 和 `detectSampleSize` 要读评论与正文原文才能算——把原文替换掉，特征就变了，golden 不再等价于真实运行；把原文保留下来入库，等于把第三方 UGC 与 UP 主昵称发布到公开仓库。两头都要，只能是两个产物。

## 4. 设计

### 4.1 合成 fixture（轨道 A 输入）

新建 `test/fixtures/sources/synthetic-baseline.json`：一份覆盖四通道、可控数量与特征分布的 `RawItem[]`。设计约束：

- 形状字段齐全（`source/url/platform/title/rawSnippet/publishedAt/author/channelAuthority/comments/extra`），但 `author` 用 `synthetic_up_01` 这类显然非真名的值，`url` 用 `https://example.invalid/...`（保留前缀形态以便 `channelAuthority` 判定路径被真实走到）。
- 刻意覆盖边界：无官方源、单平台、含促销码、含明确样本量标注、评论含反驳、时效过期——每条特征至少一条命中与一条不命中，让 tanh 饱和与敏感性分析有可观察的差值。
- 头部注释写明"合成数据，不代表任何真实公司或岗位"。

`test/golden-report.test.ts` 用注入的假 `fetchImpl` 喂这份 fixture，走 `runCheckFlow`，不触网。

### 4.2 规范化后比对

新建 `test/helpers/normalize.ts`，剥离：`生成于` 时间戳、`运行耗时`、session id、报告文件名。
**不剥** `contentHash`、`evidence_id`、P(可靠)、特征贡献表、假设裁决状态。
存 `test/__golden__/report-synthetic.md`，逐字节比对。

判据：任何影响结论的改动必须显式更新 golden 文件，`git diff` 里那处改动就是这次改动的影响面陈述。

### 4.3 变异检查（防止这道门是假的）

快照测试最容易变成没人走的门。在 `test/golden-report.test.ts` 内加两项自检：

1. 临时把某条似然比权重乘 2 后重算，断言后验与 golden **不相等**（证明这道门对校准层敏感）。
2. 临时注入一条被质检判为 `tangent` 的证据，断言它不进后验贡献（证明相关性门真的在起作用）。

两项都通过内存副本做，不写文件。若哪天 golden 比对"永远绿"，这两项会先红。

### 4.4 真模型留证脚本（轨道 B）

新建 `scripts/evidence-run.ts`，`npm run evidence`：跑一次 `/check` 等价流程（`dispatchMode: subagent` + 真实模型），产物固定写到 `docs/evidence/<YYYY-MM-DD>-<model-slug>/`：

- `report.md`：脱敏后的 5 段报告（脱敏规则见 §5）
- `metrics.json`：模型标识、派发模式、耗时、evidence 条数、跨分支去重计数、每个特征的 log-odds 贡献、P(可靠)、敏感性标记、schema 拒绝次数、各通道 via 与降级列表
- `run.narrative.md`：人读的一段话，写清"这次跑用了什么模型、花了多久、结论是什么、哪些是它做不了的"

**不进 CI**。CI 里放 key 会烧钱，且模型输出非确定，跑出来的红绿无法归因到代码改动——那正好毁掉轨道 A 的价值。

### 4.5 历史留证回填

`.tmp_check_out3.jsonl`（3492 行真模型事件流）与 `.tmp_report.md` 是今天那次的唯一残留。用同一套脱敏规则从它们派生 `docs/evidence/2026-09-23-<model>/`，作为轨道 B 的第一份产物；源文件保持现状（`.tmp_*` 已 gitignore，不入库也不删）。
`metrics.json` 从事件流解析，不手工填数字。若解析出的字段与 `.tmp_report.md` 的自述不一致，以事件流为准并在 narrative 里记一句差异。

### 4.6 消融对照纳管

`scripts/compare-contrarian.sh` 已有，产物目前落在 gitignored 的 `.offerlens/compare/`。改为同时写 `docs/evidence/ablation/`，并沿用其现有的措辞纪律（✅ "去掉反方 Agent 后第 3 段退化为占位行"；❌ 任何未测量的百分比）。

### 4.7 轴2 最小切片

1. **删 `vitest.config.ts` 的 `fileParallelism: false` 及其注释**。注释称"各测试文件共享进程级证据索引"，而 vitest 默认 `isolate: true`，每个测试文件独立 worker 与 module registry，`globalThis.__offerlensEvidenceIndex` 实际不跨文件共享——前提不成立。
   收益如实写：**中位 7.25s → 5.70s，差 1.7s**，样本各 3 次。这不是性能工程，是清理一条无依据的配置。
   验收动作：随机文件顺序连跑 10 次全绿，而不是靠这次观察下结论。
2. **给 `EvidenceIndex` 加显式作用域参数**，`globalThis` 退化为默认作用域。运行时语义不变（同一次 `/check` 内跨分支去重**必须**共享索引，这是设计而非死码），只是让测试可以自己构造隔离作用域。
3. 补 `test/evidence-index.test.ts`（`contentHash` 跨分支去重的正反例）与 `test/features.test.ts` 中缺失的边界用例。

### 4.8 处置 `scripts/record-demo.sh`

它现在打印硬编码旁白（`p "Installed ./..."`），自己注明是解说稿。做法：改写成真实 smoke（`npm run verify` + `pi --offline --list-models | grep offerlens`），需要交互的部分改为显式的 `[MANUAL]` 前缀，不再伪装成已执行。

## 5. 字段级脱敏映射（轨道 B 与公开 fixture 通用）

依据 `RawItem` 实际字段与 `report.ts:150-151` 的渲染路径：

| 字段 | 处理 | 理由 |
|---|---|---|
| `author` | 替换为 `up_<sha1(author) 前 8 位>` | 真名/UP 主昵称是个人信息；哈希稳定以便同一作者在一份报告内可追踪 |
| 昵称→哈希 的映射表 | **不入库** | 入库即可反查，脱敏失效 |
| `comments[]` | 丢弃原文，只留 `commentsCount` 与 `commentRebuttal` 判定结果 | 评论是第三方 UGC 且常含自称 |
| `title` | 保留，截断 30 字（与 `report.ts` 现有一致） | 公开内容标题，是可溯源性的主要载体 |
| `url` / BV 号 | 保留，剥去 `utm_*` 等追踪参数 | 溯源价值高于风险 |
| `rawSnippet` | 保留前 120 字 + `[...]`，命中促销码/样本量的片段保留（那是特征判据本身） | 报告第 2 段的可核验性依赖它 |
| `pic` / `upic` / 头像与封面 URL | 丢弃 | 头像属生物特征素材，无论证价值 |
| `publishedAt` / 数值字段 | 保留 | 时效与密度判据依赖它，且非个人信息 |

## 6. 验收判据

| # | 命令 / 检查 | 期望 |
|---|---|---|
| 1 | `npm test` | 新增 golden 与 evidence-index 测试在内全绿，且**不访问网络**（断网跑一次确认） |
| 2 | 变异检查 | 手动改一条似然比 → `npm test` 必红；还原后必绿 |
| 3 | 顺序鲁棒性 | 随机文件顺序连跑 10 次，10/10 全绿 |
| 4 | `npm run evidence` | 产出 `docs/evidence/<date>-<model>/` 三件套，`metrics.json` 可被 `node -e` 解析 |
| 5 | 脱敏自检 | 对 `docs/evidence/**` grep 已知真实 UP 主昵称与 `.tmp_check_out3.jsonl` 中出现过的评论原文片段，命中 0 |
| 6 | CI | 轨道 A 在 4 个 job 上均绿；CI 日志中无模型调用 |
| 7 | README | "可复现"主张改为指向 `docs/evidence/` 与 golden 测试，而不是只写一句话 |

## 7. 风险与回退

- **合成 fixture 让 golden 变成自证**：轨道 A 只证明"逻辑变了结论会变"，不证明"结论对"。已在 §3 的禁止项里写死，避免 README 叙事越界。
- **真模型留证一次不够有说服力**：可跑 2–3 次放不同日期目录，展示的是稳定性区间而非挑选最好一次；每次都要完整三件套，不许只留最好那份。
- **脱敏规则漏字段**：`extra?: Record<string, unknown>` 是自由袋，可能夹带昵称。派生脚本对 `extra` 采用**白名单**（只保留已知的数值/枚举键），而不是黑名单。
- **随机顺序 10 次全绿仍可能有潜伏耦合**：那是概率结论；若 CI 出现偶发红，第一嫌疑是轨道 A 里新增的共享状态，按 §4.7 的显式作用域改造收敛。

## 8. 决策记录

1. **真模型不进 CI** —— CI 的价值在于红绿可归因到代码；模型非确定 + 计费 + key 管理三条都会破坏它。
2. **脱敏与回归分两条轨道** —— 保留原文则隐私不可控，替换原文则被测输入已变，不存在同时满足的单轨方案。
3. **`globalThis` 索引保留但可注入** —— 跨分支去重需要进程内共享，这是设计；要改的是"测试无法自己造隔离"，不是"共享本身"。
4. **不引入校准** —— 与项目既有立场一致；宁可 README 写"未校准"，也不做没有标注集支撑的数字。
