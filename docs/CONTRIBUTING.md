# 贡献指南

## 提交前跑什么

```bash
npm run verify     # = typecheck + lint + test:cov，与 CI 字面同判据
```

单跑：

```bash
npm run typecheck  # tsc --noEmit
npm run lint       # biome check .      （格式化 + import 排序 + 规则）
npm run format     # biome check --write .
npm test           # vitest run（71 项，不打真实网络、不需要 API key）
npm run test:cov   # vitest run --coverage，带门槛棘轮
```

CI 是 `ubuntu-latest × windows-latest × node 22.x/24.x` 四格。**不要**在 CI 里加：
Pi 安装、真实模型调用、任何出网用例。

## 测试纪律

- 测试跑在确定性逻辑上：内容源通过 `createChannels(config, fetchImpl)` 注入假 fetch，
  角色执行走进程内桩。测试配置里的 `cacheDir` / `reportsDir` / `sessionDir` 全部指向
  `os.tmpdir()`，因此干净检出可直接跑，不依赖仓内缓存。
- **改被验证的代码，验证就必须穿过被改的那条路径。** 绕开它的测试必然绿，那是假信号。
  新增门槛/守卫时，先把它设成一个必然失败的值，确认命令真的红，再改回实测值。
- 覆盖率门槛（`vitest.config.ts`）是**棘轮**：只允许随实测上调。
  当前值 45 / 40 / 45 / 45 来自 2026-09-23 在 **vitest 4.1.11** 下实测
  47.84 / 43.75 / ≈50 / 47.81（两次跑完全一致），向下取整到 5。
  `functions` 报表里显示 "50" 是四舍五入值，真实精度未知，故门槛降到 45 留余量。
- **跨 vitest 大版本的覆盖率数字不可直接比较。** 0.2.0 曾记录 vitest 3.2.7 下同口径的
  45.40 / 77.83 / 67.76 / 45.40；升级后 `branch` 与 `functions` 的**计数定义变了**，
  只有 `statements` / `lines` 同量级。引用覆盖率时连 vitest 版本一起写。
- 注意 vitest 的三个坑：
  1. `coverage` 必须嵌在 `test` 下——写成顶层键会被**静默忽略**（门槛设 99 仍退出 0）。
     本仓已把 `vitest.config.ts` 纳入 `tsconfig.include`，这类错现在由 `tsc` 拦下。
  2. vitest 3 的 `coverage.all` 在 v4 被**整个删除**，运行时对未知键同样静默忽略；
     分母改由 `coverage.include` 决定。**必须显式列出**，否则退化为"只统计被测试导入过的文件"，
     0% 文件消失、statements 从 45.40 虚涨到 68.85。
  3. `coverage.exclude` 是**整体替换而非追加**（本仓 `include` 已钉死范围，故只留两条生效排除）。

## 措辞纪律：不声称未测量的数字

README、CHANGELOG、注释里的每一条量化陈述，都要能在当前工作树上被一条命令复现。

- 写"提速 3 倍"之前要有重复测量的中位数。spec-1 §2 在安静环境下各测 3 轮得到的串行/并行中位数
  是 7.25s / 5.70s（差 1.7s），据此**只能**说"快约 1.5 秒"，不能说"提速 3 倍"。
  引用他人测量时注明出处与日期，别把它的数字当成自己当前的结论。
- 不凭感觉填阈值。覆盖率、限速、超时同理：先测，再按测到的值定，并在注释里写下测量日期与口径。
- "未实现""按计划不做"要明说，不要淡化。消融实验/评测按 spec 边界**不做**，
  因此本仓不出现任何准确率、F1、校准误差类数字。
- 声明与实现不一致时，**改声明**，除非你确实要补齐实现——两种都要留下可查的痕迹
  （见 README 的「对应与偏差」表与 `docs/CHANGELOG.md`）。

## 代码风格

- 缩进 tab，行宽 120，双引号，分号必写（`biome.json`）。
- `extensions/subagent/**` 是 vendored 上游代码，已列入 Biome ignore 与覆盖率排除，
  **不要**格式化它——那会毁掉与上游的可 diff 性。改动请在 `VENDOR-NOTES.md` 逐条登记。
- 注释只写"为什么"，不写"这行在干什么"。多段 docstring 不要，一行说明足矣。

## 提交历史

- 一个 commit 只做一件事。**格式化必须单独成 commit**，这样 `git log -p` 能一眼区分风格重排与语义改动。
- commit message 用 `feat:` / `fix:` / `chore:` / `style:` / `docs:` / `ci:` / `refactor:` 前缀。
- 仓库级 git 身份是 `tree-afk <tree-afk@users.noreply.github.com>`，不要改全局配置。
- 不伪造时间线。基线 `9e94fa2` 之前的开发不在版本控制里，就这样记。
