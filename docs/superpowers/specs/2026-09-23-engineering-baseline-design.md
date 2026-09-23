# spec-1 工程基线（OfferLens）

日期：2026-09-23 · 状态：**已执行，判据 1–8 全过**（含 CI 四格真绿，见 §7.7） · 取向：求职可展示（轴1）
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
| 代码卫生 | grep `any` / `TODO` / `console.log` / 空 `catch` | **非 0**：`extensions/subagent/index.ts` 2 处 `any`（vendored 上游代码）、`web/server.ts` 2 处 `console.log`（启动横幅，合理）。执行时另由 Biome 查出 `lib/provider-placeholder.ts` 1 处**未使用 import**（原文误记为"0 命中"） |
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
│   └── 2026-09-16-majority-personal-corpus-fix.md  ← fix-plan-majority-personal.md
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
| 8 | 覆盖率报告首次产出 | 拿到真实数字后设门槛为**向下取整到 5**，不凭感觉填。注意：`vitest.config.ts` 原本**没有** coverage 段（本文原写"调整门槛"，实为"新增"），且该段必须嵌在 `test` 键下 |

## 5. 风险与回退

- **Biome 一次性格式化产生巨大 diff**：单独 commit，且 `git revert` 只回退这一条即可，不牵连语义改动。
- **`npm ci` 在 CI 里因 peerDependencies `*` 解析到新版本**：lock 文件已提交，`npm ci` 按 lock 装，风险低；若装不上则首条 CI 就红，改动小、立即暴露。
- **Windows runner 上真实行为与本机不一致**：这正是要跑的动机；若确有个案失败，就在 CI 里对该用例显式标注原因并跳过，而不是关掉 Windows job。

## 6. 决策记录

1. **首个 commit 为工作快照，不伪造历史** —— 收益是可验证的诚实；代价是早期决策只能从 `docs/design/` 三份文档读，而非 blame。
2. **commit 邮箱用 GitHub noreply** —— 仓库公开后 QQ 邮箱进入采集面；前提是你在 GitHub Settings → Emails 添加该地址，否则 commit 不关联账号、贡献格子不计。
3. **lint/format 选 Biome** —— 依据见 3.4；类型层保证仍归 `tsc`。
4. **并行化不写成性能收益** —— 实测差 1.7s，样本各 3 次，写"提速 3 倍"就是没测过的数字（这也是 3.8 措辞纪律的同一条）。

## 7. 执行记录与偏差（2026-09-23 落地后回填）

状态改为**已执行**。判据 1–8 **全过**（判据 5 的 CI 四格于 §7.7 真跑通过）。下表只记与本文预设不符之处。

### 7.1 本文的事实错误（已就地更正）

| 位置 | 原述 | 实测 |
|---|---|---|
| §2 代码卫生 | "0 命中" | 4 命中 + Biome 另查出 1 处未使用 import；已按 2 处 vendored `any` / 2 处启动横幅 / 1 处死 import 分列 |
| §3.7 文件名 | `2026-09-16-dispatch-retries-fix.md` | 该文档内容讲的是 `majorityPersonal` 语料级特征，与 dispatch 重试无关；实名为 `2026-09-16-majority-personal-corpus-fix.md` |
| §4 判据 8 | "把 vitest.config.ts 的门槛设为…" | 该文件原本没有 coverage 段，是新增不是调整；且写在顶层键会被 vitest 静默忽略 |
| §2 缺失件 | 列了无 `.editorconfig` | §3 无对应条目，本次**未建**（`.gitattributes` + Biome 已覆盖行尾与缩进两件事）。清单与范围不一致，保留记录但标未做 |

### 7.2 预设被推翻之处

- **`linter.rules.recommended = true` 并非零成本，且与 §1 非目标直接冲突**：实测 3 error + 26 warning。
  三个 error **全部落在 `web/static/index.html`** —— 正是 §1 声明"维持现状、不做前端工程化"的那个文件。
  判据 4 要求 `npm run lint` 退出 0，与非目标互斥。
  **本次处置**：做单行属性/写法修正（`type="button"`、svg 加 `aria-label`、`forEach` 回调去返回值），
  独立成 `fix:` commit，理由是这属于修 lint 报错而非前端工程化。
  26 条 warning 不阻塞退出码（`noNonNullAssertion` 19 条为主），保留为 warning 未清理。
- **§5 风险 2 当场兑现**：`npm install @vitest/coverage-v8` 以 `*` 解析到 5.0.1，与 vitest 3.2.7 的 peer 冲突，
  安装直接失败。须锁同大版本。原文把这条列为"风险低"，实际是首次安装即阻断。
- **README 失效声明不止 §2 列的两处**，另发现四处（详见 commit `1b8398b`）：
  `dispatchMode` 出厂值已是 `subagent` 但表中标 `stub`（默认）；"lib 层零 Pi 依赖"不成立
  （`provider-placeholder.ts` 值导入 `createProvider`）；目录结构与工具清单漏了 `checkflow.ts` 与
  `begin_check`/`register_evidence`/`finalize_report`/`emit_*`；
  `--experimental-transform-types` 于 **v26.0.0 被移除**，故 `engines: ">=22.7"` 隐含的无上界是错的，
  `npm run web` 实际可用区间 22.7 ~ 25.x。

### 7.3 本文未覆盖、执行中新增的决定

| 变更 | 理由 |
|---|---|
| `verify` 末段由 `npm test` 改 `npm run test:cov` | §3.6 自己写明"CI 与本地用同一条命令，避免两套判据"，但 §3.5 的 verify 定义让本地不测覆盖率，会造成本地绿/CI 红。按前者原则统一到后者 |
| `@types/node` 提升为显式 devDependency | `tsconfig` 写了 `types:["node"]` 却只靠 pi-coding-agent 传递带入，上游移除即 `tsc` 失败 |
| 覆盖率口径排除 `extensions/subagent/**` 与 `extensions/lib/types.ts` | 前者 vendored、后者编译期擦除，计入分母是测量假象。`web/` 与胶水层**保留在分母内**（确实是 0），故实测 45.40 而非更高数字 |
| CI 加 `concurrency` 取消陈旧运行 | 常规做法，避免同分支多次 push 排队 |
| `.gitignore` 补 `coverage/` | 新增产物；同时经 `vcs.useIgnoreFile` 让 Biome 一并忽略 |

### 7.4 实测数字（供后续引用带出处）

- 覆盖率 2026-09-23，本机 Windows / node v24.14.1，口径见 7.3。
  **升级 vitest 后以 4.1.11 为准**（见 7.6）：
  statements **47.84%** / branches **43.75%** / functions **≈50%** / lines **47.81%**，两次跑逐位一致
  → 门槛设 45 / 40 / 45 / 45。
  历史值（vitest 3.2.7，同分母）：45.40 / 77.83 / 67.76 / 45.40 —— **branch 与 functions 两列不可跨版本比较**。
  分模块看（v4）：`extensions/lib` 69.74%，`extensions/` 胶水层 6.81%，`web/` 0%。
- `npm ci` 本机实跑退出 0（非 dry-run）。lock 因手改 package.json 一度与根 devDependencies 不同步，
  已 `npm install --package-lock-only` 修复，并逐包比对新旧 lock 确认 **0 处版本漂移**
  （那 6485 行 diff 纯为 npm 重排键序）。
- Biome v2.5.14（已是 v2，§3.4 所述"类型感知规则需 v2 scanner 显式开启"不影响本次：未启用类型感知规则，
  类型层保证仍由 `tsc --noEmit` 承担）。

### 7.5 遗留待办

1. ~~**推送并跑通判据 5**~~ —— **已完成，见 §7.7**。
2. ~~vitest 3.2.7 → ≥4.1.11~~ —— **已完成，见 7.6**。
3. **26 条 lint warning**：以 `noNonNullAssertion`（19）为主，清理会触碰 `extensions/` 运行时语义，
   超出本 spec 非目标范围。
4. `.editorconfig` 未建（见 7.1）。

### 7.6 vitest 升级（2026-09-23 追加，用户指定优先于推送）

升到 **4.1.11**，`npm audit` 由 3 moderate 变为 **0 漏洞**；71 项测试全过，无需改用例。

过程中撞出三件事：

1. **`coverage.all` 在 v4 被整个删除**，且运行时对未知键**静默忽略**——写 `all: true` 不报错也不生效。
   真正的开关是 `coverage.include`；不设它则分母退化为"只统计被测试导入过的文件"，
   0% 文件（`web/server.ts`、`checkflow.ts`、`hypotheses.ts` 等）全部消失，
   statements 从 45.40 **虚涨到 68.85**。本可顺着这个数字把门槛写高，但那不是覆盖率变好了。
2. **这条能被拦住纯属运气修正**：`vitest.config.ts` 原本不在 `tsconfig.include` 里，
   `tsc` 从不检查它——也正是 7.2 里"coverage 写错层级"能潜伏一整轮的原因。
   纳入后 tsc 立刻报 `'all' does not exist in type 'CoverageOptions'`。
   已用变异测试反向验证：把 `coverage` 挪回顶层，tsc 报 TS2769 退出 2。
3. **branch/functions 的计数定义随大版本变了**，不是口径问题：同分母下 branch 77.83 → 43.75。
   因此门槛从 45/75/65/45 重设为 45/40/45/45，并在 CHANGELOG 明确标注**跨版本不可比**，
   避免被读成覆盖率退步。

另外把 `vitest` 与 `@vitest/coverage-v8` 从 `^4.1.11` 改为**精确锁** `4.1.11`：
coverage 的 peer 要求 vitest 精确相等，留 `^` 会在上游发补丁版时重演 7.2 里那次安装阻断。

### 7.7 推送与判据 5 实测（2026-09-23）

仓库 `tree-afk/OfferLens` 以 **public** 新建（`§6.2` 的决策前提是"仓库公开后 QQ 邮箱进入采集面"，
即目标形态本就是公开；且判据 5 的 CI 徽章要对面试官可见，private 不成立）。
11 个 commit 全部推上，`origin/main` 与本地 HEAD 同为 `116036b`。

**判据 5 达成** —— run `35821941910`，4 个 job 逐一核对（不看 run 级 success，因为 skipped job 也会让
run 显示成功）：

| job | status | conclusion | 失败步骤 |
|---|---|---|---|
| `verify (ubuntu-latest, 22.x)` | completed | **success** | none |
| `verify (windows-latest, 22.x)` | completed | **success** | none |
| `verify (windows-latest, 24.x)` | completed | **success** | none |
| `verify (ubuntu-latest, 24.x)` | completed | **success** | none |

覆盖率 artifact 仅 1 份（`coverage`，170451 bytes），符合"只在 ubuntu/24 产出"的设计。
CI 徽章未认证 GET 返回 **HTTP 200**，即外部读者无需登录即可看到。

过程中修掉的两个环境事实：

1. **`§6.2` 的 noreply 前提此前未被验证过**。本机 git 凭据属主经查是 `tree-afk`（id 104764360），
   且推送后 11 条 commit 的 `author` 对象**全部解析为 login `tree-afk`** —— 说明该 noreply 邮箱
   确已注册在账号上，贡献格子会计。注意 `/user/emails` 这个 token 打不开（缺 `user:email` scope，
   GitHub 对缺 scope 回 404 而非 403），所以只能靠推送后回查 commit 归属来实证，
   不能靠 API 预检。
2. **`~/.gitconfig` 里的 `http(s).proxy` 指向 127.0.0.1:7892，而该端口无进程监听**，
   与环境变量 `HTTP(S)_PROXY` 的 **7890** 不是同一套。症状是
   `Failed to connect to github.com port 443 via 127.0.0.1`，容易被误读成"GitHub 被墙/网络不通"。
   经用户确认后将 gitconfig 改为 7890，`git ls-remote https://github.com/git/git.git` 随即返回正常 HEAD。

顺带一个 Windows 特有的坑：用 `curl -d` 直接内联中文 JSON 建仓库会返回 `Problems parsing JSON`
（控制台代码页把 UTF-8 改写了）；改成写 `.tmp_*.json` 文件再 `--data-binary @file` 即通过，
仓库中文描述完好入库。注意 `/tmp` 在 node 与 Git Bash 下解析到不同目录，落盘要用仓库内相对路径。


