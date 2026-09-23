# spec-1 工程基线（OfferLens）

日期：2026-09-23 · 状态：待评审 · 取向：求职可展示（轴1）
前置：本文档假定 `9e94fa2` 基线 commit 已存在。

## 1. 目标与非目标

**目标**：让一个外部读者（面试官）不需要跟你聊天，就能自己把这个仓跑起来、验证你声称的每一条，并从 commit 历史与 CI 记录看出这是被持续维护的工程物。

**非目标**（明确排除，避免范围膨胀）：

- 不做真实模型的评测与校准（属 spec-2）。
- 不重构 `extensions/` 运行时语义，不改任何角色 prompt 契约。
- 不做 Web 前端工程化（`web/static/index.html` 单文件维持现状）。
- 不追求覆盖率数字漂亮，只追求"覆盖率有数字且被 CI 记录"。

## 2. 事实基线（全部为 2026-09-23 实测，非估计）

| 事实 | 实测方式 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | 退出 0 |
| 测试 | `npx vitest run --reporter=basic` | 6 文件 / 71 项全通过 |
| 串行 vs 并行 | 配置原样 ×3 与 `--fileParallelism` ×3，安静环境 | 中位 7.25s vs 5.70s，差 **1.7s** |
| Pi 依赖可安装 | `package-lock.json` 中 `@earendil-works/*` 的 `resolved` | `registry.npmjs.org`，v0.85.1 → `npm ci` 可在 CI 用 |
| 测试是否依赖仓内缓存 | `grep cacheDir test/*.ts` | `test/sources.test.ts:26` 的 `testConfig()` 把 cacheDir/reportsDir/sessionDir 全指向 `os.tmpdir()` → CI 干净检出可跑 |
| 测试是否访问真实网络 | 同上文件注入假 `FetchLike` | 否 |
| 代码卫生 | grep `any` / `TODO` / `console.log` / 空 `catch` | 0 命中 |
| 缺失的工程件 | 目录清点 | 无 LICENSE、无 CI、无 lint/format 配置、无 CHANGELOG、无 `.editorconfig` |
| README 失效声明 | 与实测对比 | 测试项数写 57/56（实为 71）；`engines: >=20` 与 web 实际需要 Node ≥ 22.7 冲突 |

## 3. 逐项设计

### 3.1 版本控制基线（已完成，记录已定口径）

`git init -b main` + 单个基线 commit `9e94fa2` = 既有工作快照，55 个文件。
仓库级身份为 `tree-afk <tree-afk@users.noreply.github.com>`，**未改动全局 git 身份**。

理由与代价：迁移前开发未纳入版本控制，因此**不伪造时间线**。一天内出现大量早期 commit 比"一个诚实的基线 commit + 后续可查的增量"更减分。

已同步的两个忽略项：`.workbuddy/`（其他智能体的本地记忆目录，含开发叙述）、`.tmp_*`（一次性调试产物，其中 `.tmp_check_out3.jsonl` 是 1.7MB 真模型事件流，本地保留、不入库）。

### 3.2 `.gitattributes`（已完成）

`* text=auto eol=lf`。不加这一条，Windows 上 55 个文件每次 checkout 都可能整片行尾抖动，后续任何真实 diff 都会被噪声淹没。

### 3.3 LICENSE

新建 `LICENSE`：MIT 全文，版权行 `Copyright (c) 2026 tree-afk`（用 GitHub 登录名，与仓库身份一致；要换真名只改这一处），与 `package.json` 的 `license: MIT` 对齐。
`extensions/subagent/` 的 MIT 衍生关系由已存在的 `extensions/subagent/VENDOR-NOTES.md` 交代，README 致谢段已写明。

### 3.4 Biome（lint + format 单工具）

新建 `biome.json`：`formatter.indentStyle = "tab"`、`lineWidth = 120`、`linter.rules.recommended = true`，并把 `extensions/subagent/**` 列入 ignore（vendored 代码不参与格式化，保住它与上游的可 diff 性）。

新增 devDependency：`@biomejs/biome`。

选 Biome 而非 ESLint + Prettier 的三条依据：本仓无规则面需求（卫生项 0 命中，ESLint 生态价值用不上）；`tsconfig.allowImportingTsExtensions` + jiti 的 `.ts` 后缀导入会让 ESLint 的 import resolver 频繁误报，Biome 不走 resolver；tab 缩进一次性统一。

已知代价：Biome 的 lint 规则面窄于 ESLint；其类型感知规则需 v2 scanner 显式开启且增加内存开销，因此**类型层保证仍由 `tsc --noEmit` 承担**，不指望 lint 兜底。

执行顺序有讲究：格式化必须在基线 commit **之后**、其余改动之前单独成一个 commit，这样 `git log -p` 能一眼区分"风格重排"与"语义改动"。趁历史只有一条记录时做，blame 代价接近零。

### 3.5 `package.json`

- `scripts`：`lint` = `biome check .`，`format` = `biome check --write .`，`verify` = `npm run typecheck && npm run lint && npm test`，`test:cov` = `vitest run --coverage`
- 补 `repository`、`bugs`、`homepage`（指向 `tree-afk/OfferLens`）
- `engines.node` 改为 `>=22.7`，并在 README 注明原因（web 桥用 `node --experimental-transform-types`）
- 加 `files` 白名单：`extensions`、`agents`、`prompts`、`config`、`README.md`、`LICENSE`（Pi 包按路径加载，不需要发布 test/web/docs）

新增 devDependency：`@vitest/coverage-v8`。

### 3.6 GitHub Actions

新建 `.github/workflows/ci.yml`：

- 触发：`push` 到 `main` + 所有 `pull_request`
- 矩阵：`os: [ubuntu-latest, windows-latest]` × `node: [22.x, 24.x]` = 4 job，单 job 预算 < 2 分钟
- 步骤：`actions/checkout@v4` → `actions/setup-node@v4`（`cache: npm`）→ `npm ci` → `npm run typecheck` → `npm run lint` → `npm run test:cov`（CI 与本地用同一条 `lint` 命令，避免两套判据）
- 双平台的价值：这个仓最难的部分是 Windows 下的子进程派发（`windowsHide`、不经 `argv[1]` 自举），README 里那几句经验声明从此有机器背书。**CI 里不跑 Pi 安装、不跑真实模型、不跑网络用例**。

`test:cov` 只在 ubuntu 上产出报告并上传 artifact，避免 Windows 重复产物。

### 3.7 文档归位

```
docs/
├── README.md              # 说明：本仓 git 基线为既有工作快照，迁移前开发未纳入版本控制
├── architecture.md        # 从 README §架构 拆出并补"模块边界表"（每块：做什么/怎么用/依赖谁）
├── design/                # 迁入根目录三份计划文档，保留原名以便旧引用可解析
│   ├── 2026-09-08-tree-of-hypotheses-plan.md      ← grounded-tide-robin.md
│   ├── 2026-09-12-pi-package-migration.md         ← migration-plan.md
│   └── 2026-09-16-dispatch-retries-fix.md         ← fix-plan-majority-personal.md
├── CHANGELOG.md           # 从 0.2.0 起记，基线 commit 为第一条
└── CONTRIBUTING.md        # 跑什么命令、测试纪律、"不声称未测量的数字"这条措辞纪律
```

两份规划 spec 目前落在 `docs/superpowers/specs/`（工具默认位置）。公开仓是否保留这个目录名待你定：删掉它并把两份 spec 并入 `docs/design/` 更干净，保留则能显示设计文档是与人协作迭代的产物——两种都站得住，但 `docs/README.md` 的目录树必须与实际一致。

根目录只留 `README.md`。改名带日期前缀，是为了让"设计推演的时间顺序"在文件列表里直接可见——这三份文档是加分项，随机词组名是减分项。

### 3.8 README 修实

只改失效与冲突处，不重写：测试项数按 `npm test` 字面输出、`engines` 与 Node 版本一致、加"CI 状态"徽章位、把 `docs/` 链接补上、把"57 项单元测试"更正。
`scripts/record-demo.sh` 含硬编码旁白（`p "Installed ./..."`），本 spec 内**只加一行说明它是解说稿不是演示**，替换成真实 smoke run 属 spec-2。

## 4. 验收判据

| # | 命令 | 期望 |
|---|---|---|
| 1 | `git log --oneline \| wc -l` | ≥ 4（基线、格式化、工具链、文档） |
| 2 | `git ls-files \| grep -cE "^(\.offerlens\|node_modules\|\.workbuddy\|\.tmp_)"` | 0 |
| 3 | `npm run verify` | 退出 0 |
| 4 | `npm run lint` | 退出 0 |
| 5 | GitHub Actions 页 | 4 个 job 全绿，且 `windows-latest` 在列 |
| 6 | `git ls-files \| grep -c "grounded-tide-robin\|migration-plan\|fix-plan"` | 0（已迁 docs/design） |
| 7 | `grep -n "57 项\|56 项" README.md` | 无命中（过期数字已更正） |
| 8 | 覆盖率报告首次产出 | 拿到真实数字后，把 `vitest.config.ts` 的门槛设为该值**向下取整到 5**，不凭感觉填 |

## 5. 风险与回退

- **Biome 一次性格式化产生巨大 diff**：单独 commit，且 `git revert` 只回退这一条即可，不牵连语义改动。
- **`npm ci` 在 CI 里因 peerDependencies `*` 解析到新版本**：lock 文件已提交，`npm ci` 按 lock 装，风险低；若装不上则首条 CI 就红，改动小、立即暴露。
- **Windows runner 上真实行为与本机不一致**：这正是要跑的动机；若确有个案失败，就在 CI 里对该用例显式标注原因并跳过，而不是关掉 Windows job。

## 6. 决策记录

1. **首个 commit 为工作快照，不伪造历史** —— 收益是可验证的诚实；代价是早期决策只能从 `docs/design/` 三份文档读，而非 blame。
2. **commit 邮箱用 GitHub noreply** —— 仓库公开后 QQ 邮箱进入采集面；前提是你在 GitHub Settings → Emails 添加该地址，否则 commit 不关联账号、贡献格子不计。
3. **lint/format 选 Biome** —— 依据见 3.4；类型层保证仍归 `tsc`。
4. **并行化不写成性能收益** —— 实测差 1.7s，样本各 3 次，写"提速 3 倍"就是没测过的数字（这也是 3.8 措辞纪律的同一条）。
