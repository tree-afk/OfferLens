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

### Fixed

- **工具白名单泄漏**：`tools: []` 的子 Agent 此前不下发 `--tools`，因而**继承了全部内置工具**
  （含 bash / read / edit）。现区分"声明为空集"与"未声明"，前者下发 `--no-tools`。
- **子进程扩展未加载**：派发时未传 `--approve`，导致 Pi 不加载项目本地包，子 Agent 看不到
  `fetch_*` / `emit_*` 工具。曾被误判为"模型不听指令"。
- **`pi.extensions` glob 不展开**：Pi 将 manifest 条目按字面路径处理，`./extensions/*.ts` 匹配不到；
  改为显式列出六个扩展文件。
- **`@types/node` 隐式依赖**：`tsconfig` 声明 `types: ["node"]` 却依赖 `pi-coding-agent` 把它带进来，
  上游一旦移除则 `tsc` 失败。改为显式 devDependency。
- **`engines.node` 与实际不符**：原 `>=20`，但 Web 桥使用 `--experimental-transform-types`（22.7 起才有）。
  改为 `>=22.7`。

### Known issues

- `npm audit` 报 3 个 moderate，全部来自 `vitest` / `@vitest/mocker`
  （公告范围 `>=2.1.0 <4.1.11`，路径穿越 / 任意文件读）。仅 devDependency、不在 `files` 白名单内、
  不随 Pi 包分发；3.x 线无修补版本，需跨大版本升级，故未处理。
- 端到端真跑目前只在 Windows + 阿里百炼（qwen-turbo/plus/max）验证过一次；查询面偏宽导致
  29 条采纳证据之外有 54 条被判跑题，B 站以外通道在该次运行中未产出可用结果。

[0.2.0]: https://github.com/tree-afk/OfferLens/releases/tag/v0.2.0
