# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

条目只记录**可验证的行为变化**。性能类描述必须带实测口径，未测量的数字不写。

## [Unreleased]

### Changed

- **证据不再经过主管 LLM 的手**：`dispatch_collector` 把条目暂存到运行态、只返回 `collect_id`，
  `register_evidence` 改收句柄而非 `items`。动机是测量结果——一支 `register_evidence` 让模型
  生成 **11,245 字符**，而该轮模型生成总量为 12,432 字符，**占 90.5%**（上一轮同比例 91.8%），
  单这一步流了约 150 秒。复制的还是它不需要读的数据。
- **`dispatch_verifier` / `dispatch_contrarian` 的返回值收敛为计数与布尔**：明细已进运行态、
  由 `finalize_report` 确定性取用，回灌只是白占上下文。实测回灌体积
  verifier **合计 13,625 字符（单次最大 7,788）**、contrarian **合计 1,354 字符（单次最大 691）**。
  副作用是把"不调和"从提示词纪律变成数据流约束：主管看不见评估明细，就没有可调和的对象。
- 删除 `RawItemSchema`（随 `items` 参数一起失去消费者）。

### Fixed

- **第 3 段对反方输出做 URL 白名单去链**。2026-09-23 真跑第 3 段出现 3 个假链接
  （形如 `https://www.bilibili.com/video/ev_563c4275d6`）：反方把手上的内部证据句柄
  （`sha1` 前 10 位十六进制）拼进了真实链接模板，而 B 站视频 ID 是 `av<数字>` / `BV…` 形态，
  这类 URL 不可能存在。上一轮为 0 处。
  处理边界：**只摘链接、论证文字一字不动**，段内标注被去链处数，具体 URL 列入第 5 段缺口——
  第 3 段的"不被改写"契约不因安全处理而悄悄失效。
  匹配用精确 + 前缀关系放行，避免误伤带 `spm_id_from` 等参数的真实链接；证据表为空时不放行任何链接。

### Added

- `AGENTS.md`：项目级指令（每次改动即提交、收尾清临时文件、验证须穿过被改路径、精确 peer 锁版本）。
- 测试 71 → **83 项**：新增 `test/runstate.test.ts` 句柄往返/未知句柄 fail-closed 5 项，
  `test/report.test.ts` 去链与第 5 段披露 7 项。

### Notes（口径与更正）

- 覆盖率 47.84 → **49.45**（statements，vitest 4 同口径）来自新增代码被测试覆盖，门槛未下调。
- **更正**：commit `09406f9` 的 message 把上述回灌体积写成"13,021 / 8,003 字符"，
  实测值是 **13,625（verifier 合计）/ 1,354（contrarian 合计）**。该 commit 未推送，
  但按"不重写已发布历史"的纪律保留原样，以本条为准。

## [0.2.0] - 2026-09-23

### Added

- **LLM 主管编排路径**：`begin_check` → 每分支 `dispatch_collector` / `register_evidence` /
  `dispatch_verifier` / `dispatch_contrarian` → `finalize_report`。调用序列由 `prompts/check.md` 约束，
  打分与措辞仍由 `finalize_report` 的确定性尾巴完成。
- **子 Agent 结果改用 function-calling 捕获**：`emit_verifier_result` / `emit_contrarian_result`
  工具入参即校验契约，取代"提示词里要 JSON + 父侧 `JSON.parse`"；采集侧改为收割 `fetch_*` 工具结果。
- **质检混合模式**：可确定性计算的特征（时效 / 样本量 / 引流要素 / 作者密度 / 渠道权威）由扩展侧算，
  模型只输出 `on-topic | tangent | unknown` 的相关性判定。
- **父侧结构性守卫 + 重试**：子进程未通过 emit 工具提交即返回错误（不静默放行），
  按 `config.subagentRetries`（出厂 2）重试；不设 schema 兜底。
- **反方有界权重调整**：`lrAdjustments.multiplier` 限定 0.2~5.0，超出即裁剪；反方原始输出不被主管改写。
- **`majorityPersonal` 语料级特征**：接入置信度引擎（此前 `config/likelihood-ratios.json` 已声明、代码未实现）。
- **Windows 子进程派发加固**：`windowsHide`；vendored subagent 的上游修改在 `VENDOR-NOTES.md` 逐条登记。
- **工程基线**：MIT `LICENSE`；Biome（lint + format 单工具）；GitHub Actions
  `ubuntu × windows × node 22/24` 四格矩阵；覆盖率棘轮（v8，门槛见 `vitest.config.ts`）；`docs/` 归位。

### Changed

- **vitest 3.2.7 → 4.1.11**（连同 `@vitest/coverage-v8` 同步到 4.1.11，两者**精确锁版本**
  而非 `^`：coverage 的 peer 要求 vitest 精确相等，用 `^` 会在上游发补丁版时重演 peer 冲突）。
  清掉 `npm audit` 的 3 个 moderate（`Vitest: Path Traversal / Arbitrary File Read via
  @vitest/mocker`，范围 `>=2.1.0 <4.1.11`）。
- **覆盖率口径改为显式白名单**：vitest 3 的 `coverage.all` 在 v4 被整个删除，默认口径退化为
  "只统计被测试导入过的文件"，未测文件从分母消失会让 statements 从 45.40 虚涨到 68.85。
  现由 `coverage.include: ["extensions/**/*.ts", "web/**/*.ts"]` 钉死。
- **覆盖率门槛重设**为 45 / 40 / 45 / 45（实测 47.84 / 43.75 / ≈50 / 47.81）。
  ⚠️ v4 改了 branch 与 functions 的计数定义，**与 0.2.0 的 vitest 3 数字不可比**，
  门槛下调不代表覆盖率退步。
- `vitest.config.ts` 纳入 `tsconfig.include`——此前该文件完全不受类型检查，
  这是"coverage 写成顶层键被静默忽略"能潜伏一轮的原因。

### Fixed

- **工具白名单泄漏**：`tools: []` 的子 Agent 此前不下发 `--tools`，因而**继承了全部内置工具**
  （含 bash / read / edit）。现区分"声明为空集"与"未声明"，前者下发 `--no-tools`。
- **子进程扩展未加载**：派发时未传 `--approve`，导致 Pi 不加载项目本地包，子 Agent 看不到
  `fetch_*` / `emit_*` 工具。曾被误判为"模型不听指令"。
- **`pi.extensions` glob 不展开**：Pi 将 manifest 条目按字面路径处理，`./extensions/*.ts` 匹配不到；
  改为显式列出六个扩展文件。
- **`@types/node` 隐式依赖**：`tsconfig` 声明 `types: ["node"]` 却依赖 `pi-coding-agent` 把它带进来，
  上游一旦移除则 `tsc` 失败。改为显式 devDependency。
- **`engines.node` 与实际不符**：原 `>=20`，但 Web 桥使用 `--experimental-transform-types`
  （v22.7.0 加入，v26.0.0 移除）。改为 `>=22.7`，并在 README 注明实际上限。
- **`lib/provider-placeholder.ts` 未使用 import**：`sharedEvidenceIndex` 只出现在 import 行、全文无引用，删除。
- **`web/static/index.html` 三处 Biome error**：svg 缺可访问名、button 缺 `type`、`forEach` 回调返回值。

### Removed

- `vitest.config.ts` 中冗余的覆盖率默认排除项（`node_modules` / `dist` / `coverage` / `*.config.*`）：
  `include` 已是白名单且与它们无交集，实测精简前后数字逐位一致。

### Known issues

- 端到端真跑目前只在 Windows + 阿里百炼（qwen-turbo/plus/max）验证过一次；查询面偏宽导致
  29 条采纳证据之外有 54 条被判跑题，B 站以外通道在该次运行中未产出可用结果。
- `extensions/` 胶水层与 `web/` 覆盖率仍为 0（刻意保留在分母内，不靠排除项把数字做高）。

[0.2.0]: https://github.com/tree-afk/OfferLens/releases/tag/v0.2.0
