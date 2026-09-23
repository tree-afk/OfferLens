# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

条目只记录**可验证的行为变化**。性能类描述必须带实测口径，未测量的数字不写。

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
- CI 四格矩阵（含 `windows-latest`）**尚未被 GitHub Actions 实际跑过**：本机无 remote，
  仅本地 `npm ci` + `npm run verify` 通过。
- `extensions/` 胶水层与 `web/` 覆盖率仍为 0（刻意保留在分母内，不靠排除项把数字做高）。

[0.2.0]: https://github.com/tree-afk/OfferLens/releases/tag/v0.2.0
