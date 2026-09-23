# OfferLens 修复计划：补齐 `majorityPersonal` 语料级特征

> **读者**：执行本修复的 AI 模型或开发者。
> **范围**：单点修复，不涉及架构。只做一件事——把配置里声明、但代码未实现的语料级特征 `majorityPersonal` 接入置信度引擎。
> **背景**：全局审查（对照 `grounded-tide-robin.md`）发现，除本项外其余设计均已按原计划落地。本文档只描述这一处配置-代码不一致的修复。

---

## 一、问题定义

`config/likelihood-ratios.json` 的 `corpusFeatures` 声明了 **3 条**语料级（结构性）调整：

```json
"corpusFeatures": {
  "noOfficialSource":   { "condition": "全部证据均非官方口径",   "logodds": -0.6 },
  "singlePlatformOnly": { "condition": "全部证据来自单一平台",   "logodds": -0.3 },
  "majorityPersonal":   { "condition": "过半证据为个例叙述",     "logodds": -0.6 }
}
```

但 `extensions/lib/calibration.ts` 的 `corpusContributions()`（当前实现，第 65–76 行）**只处理了前两条**：

```ts
export function corpusContributions(
  evidenceMeta: Array<{ channelAuthority: string; platform: string }>,
  lrTable: LikelihoodRatios,
): CorpusRow[] {
  const rows: CorpusRow[] = [];
  const specs = lrTable.corpusFeatures ?? {};
  if (specs.noOfficialSource && evidenceMeta.length > 0 && evidenceMeta.every((e) => e.channelAuthority !== "official")) {
    rows.push({ feature: "noOfficialSource", contribution: specs.noOfficialSource.logodds, state: "hit" });
  }
  const platforms = new Set(evidenceMeta.map((e) => e.platform));
  if (specs.singlePlatformOnly && platforms.size === 1 && evidenceMeta.length > 1) {
    rows.push({ feature: "singlePlatformOnly", contribution: specs.singlePlatformOnly.logodds, state: "hit" });
  }
  return rows;
  // ✗ majorityPersonal 从未被判定 —— 配置里声明了，代码里没读它
}
```

**后果**：即使全部证据都是「我认识的人都……」式个例叙述（`sampleSize = "personal"`），语料级的 -0.6 惩罚也不会触发。目前只有单条级 `sampleSize: personal → -0.7` 在起作用，而它会先被 `tanh` 饱和压缩——所以「个例主导」这个**结构性缺陷**（单条叠加看不到的那类）被系统性地低估了。这恰恰违背了 `likelihood-ratios.json` 中 `corpusFeatures._doc` 的设计意图：

> "证据**结构**层面的调整……单平台、个例主导，这些结构性缺陷是单条特征的叠加看不到的。"

---

## 二、为什么现有签名做不到（必须先理解再动手）

个例判定（`sampleSize === "personal"`）来自**质检的 `assessments[].features`**，不来自 `evidenceMeta`。而 `corpusContributions()` 的入参 `evidenceMeta` 只携带 `{ id, channelAuthority, platform }`（见 `computePosterior` 调用处 `calibration.ts:131`，`evidenceMeta` 由 `orchestrator.ts:219` 构造，字段仅有这三项）。

所以**不能只往 `corpusContributions` 里加一段逻辑**——它拿不到 `sampleSize`。有两条正确的接法：

- **方案 A（推荐）**：不扩 `evidenceMeta`，而是在 `computePosterior` 内部、`contributions` 数组已经算出来之后，直接从 `contributions` 派生 personal 统计并追加语料级行。`contributions` 里每条 `ContributionRow` 都带 `evidenceId`、`feature`、`state`、`excluded`，足以判定「非跑题 且 feature==='sampleSize' 且 state==='personal'」。
- **方案 B**：把 `corpusContributions` 签名扩成接收 `contributions`（或接收一个 `{ onTopicTotal, personalCount }` 统计），由 `computePosterior` 传入。

**采用方案 A**，因为：个人计数与相关性门（`excluded`）都已经在 `contributions` 里现成可用，无需改任何上游调用方（`orchestrator.ts` / Web 桥 / 测试的 `computePosterior` 调用签名全部不变），改动面最小、回归风险最低。

---

## 三、实现规格（方案 A）

### 3.1 新增纯函数（放在 `calibration.ts`，紧邻 `corpusContributions`）

```ts
/**
 * 从已计算的特征贡献行派生「个例主导」语料级判定。
 * 与 noOfficialSource/singlePlatformOnly 的区别：它读的是 contributions（含质检特征），
 * 而非 evidenceMeta（只有通道/平台）。因此单独成函数、在 computePosterior 内叠加。
 */
function majorityPersonalRow(
  contributions: ContributionRow[],
  lrTable: LikelihoodRatios,
): CorpusRow | null {
  const spec = lrTable.corpusFeatures?.majorityPersonal;
  if (!spec) return null;
  // 相关性门：跑题证据不是证据，与单条级处理保持一致（见 evidenceContributions 的 tangent 分支）
  const onTopicIds = new Set(
    contributions.filter((c) => !c.excluded).map((c) => c.evidenceId),
  );
  const onTopicTotal = onTopicIds.size;
  // 只数「非跑题且被判定为 personal」的证据，每条最多计一次
  const personalIds = new Set(
    contributions
      .filter((c) => !c.excluded && c.feature === "sampleSize" && c.state === "personal")
      .map((c) => c.evidenceId),
  );
  const personalCount = personalIds.size;
  // 触发条件（三个都满足）：
  //   1) 有可判定的相关证据
  //   2) 相关证据数 >= MIN_EVIDENCE_FOR_CORPUS（避免 1/1=100% 在极小样本上误触发，
  //      与 singlePlatformOnly 要求 >1 条同构；阈值见 3.3）
  //   3) personal 占比 > 0.5（"过半"）
  if (onTopicTotal >= MIN_EVIDENCE_FOR_CORPUS && personalCount / onTopicTotal > 0.5) {
    return { feature: "majorityPersonal", contribution: spec.logodds, state: "hit" };
  }
  return null;
}
```

> **去重说明**：用 `Set<evidenceId>` 而不是 `filter(...).length`，因为一条证据在 `contributions` 里有 7 行（每个特征一行）；对 `sampleSize` 而言每条证据其实只有一行，但用 Set 更稳，防止未来有人给同一证据加多条同特征行时双重计数。

### 3.2 在 `computePosterior` 里叠加

当前 `computePosterior`（第 131–134 行）：

```ts
const corpusRows = corpusContributions(evidenceMeta, lrTable);
let logodds = opts.priorLogodds ?? 0;
logodds += [...saturated.values()].reduce((s, v) => s + v, 0);
logodds += corpusRows.reduce((s, r) => s + r.contribution, 0);
```

改为（在已有 `corpusRows` 基础上追加 majorityPersonal 行，然后再求和）：

```ts
const corpusRows = corpusContributions(evidenceMeta, lrTable);
const mp = majorityPersonalRow(contributions, lrTable);   // ★ 新增
if (mp) corpusRows.push(mp);                              // ★ 新增
let logodds = opts.priorLogodds ?? 0;
logodds += [...saturated.values()].reduce((s, v) => s + v, 0);
logodds += corpusRows.reduce((s, r) => s + r.contribution, 0);
```

**注意 `corpusRows` 的可变性**：`corpusContributions` 返回的是局部 `const rows: CorpusRow[]`，可以 `push`。确认无误后再累加进 logodds。

`excludedCount` 那一行（第 136 行）不需要改——它按 `contributions.filter(c => c.excluded).length / 7` 算被排除的证据条数，与语料级无关。

### 3.3 阈值常量 `MIN_EVIDENCE_FOR_CORPUS`

- 定义在 `calibration.ts` 顶部，值 **= 3**。
- 理由：个例主导是**结构性**判断，1～2 条样本谈「过半」没有统计意义，且单条级 `sampleSize` 惩罚已在起作用，小样本上再叠 -0.6 会双重惩罚。3 与 `report.ts` 里 `total < 3 → "样本量不足"` 的信息缺口门槛对齐，语义自洽。
- **这是一个需要用户确认的设计点**（见第五节）：0.5 的"过半"是配置 `condition` 文字的直接翻译，但 3 条起判是我依据既有代码惯例补的约束。如果执行模型无法询问用户，就按 3 实现并在 PR 描述里显式标注此假设。

---

## 四、连带检查（报告第 5 段是否要更新）

`assembleGaps()`（`report.ts:69-129`）已经会遍历 `ctx.calib.corpusRows` 并把命中的每条语料级特征 push 成信息缺口条目（第 103–105 行）：

```ts
for (const r of ctx.calib.corpusRows) {
  push(`证据结构缺陷：${r.feature}`, "语料级调整（手工设定权重）：...");
}
```

因为本修复是把 `majorityPersonal` 塞进 `corpusRows`，所以**报告第 5 段会自动出现这一条，无需改 `report.ts`**。

但 `report.ts` 里另有**一处独立的、基于单条贡献的**个例提示（第 95–96 行）：

```ts
const personal = ctx.calib.contributions.filter((c) => c.feature === "sampleSize" && c.state === "personal").length;
if (personal > 0) push("个例证据占比高", `${personal} 条证据为个人经历叙述，...`);
```

- 这条在**任何** personal 出现时都触发（哪怕 1/20 条），措辞是"占比高"其实名不副实。
- 本次修复**不强制改它**（超出范围）。但请在交付说明里点出这个既有的措辞瑕疵，交给用户决定是否收敛。不要顺手改，避免范围蔓延。

---

## 五、测试要求（加进 `test/calibration.test.ts` 的 `describe("calibration")` 块内）

现有测试第 65–75 行已覆盖 `noOfficialSource` / `singlePlatformOnly`。新增以下用例：

1. **过半触发**：构造 4 条相关证据，其中 3 条 `sampleSize: "personal"`、1 条 `"unlabelled"`，均为 ugc/bilibili，断言 `r.corpusRows.map(x => x.feature)` 含 `"majorityPersonal"`。
2. **未过半不触发**：4 条里仅 2 条 personal（2/4 = 0.5，不 > 0.5），断言**不含** `"majorityPersonal"`。（边界：严格大于。）
3. **小样本不触发**：1～2 条全 personal，断言不含 `"majorityPersonal"`（验证 `MIN_EVIDENCE_FOR_CORPUS = 3` 生效）。
4. **相关性门**：3 条 personal 全部标 `relevance: "tangent"`（跑题），外加 3 条 unlabelled 但 on-topic，断言 personal 不计入分母/分子 → 不触发。（验证跑题证据不参与语料级个例判定。）
5. **logodds 生效**：断言触发 `majorityPersonal` 时的 `r.logodds` 比同样的、不触发时（如把 personal 改成 unlabelled）**低约 0.6**（用一个允许浮点误差的 `toBeCloseTo` 或对差值区间断言）。

参考现有 `mkAssessment(id, { sampleSize: "personal" })` 工厂（测试第 30–32 行）复用即可。

**运行**：`npx vitest run test/calibration.test.ts`，全绿。

---

## 六、验收标准

1. `config/likelihood-ratios.json` 的 3 条 `corpusFeatures` 在 `calibration.ts` 里都有对应判定代码（`grep` 三个 feature 名，每个都能在 `corpusContributions` 或 `majorityPersonalRow` 里找到出处）。
2. 个例主导场景下，报告第 5 段出现「证据结构缺陷：majorityPersonal」条目。
3. `npx vitest run` 全部通过（含新增 5 个用例），不需要真实 API key。
4. `npx tsc --noEmit` 无类型错误。
5. 未改动 `computePosterior` / `corpusContributions` 的对外签名（上游调用方 `orchestrator.ts:220`、`web/server.ts`、既有测试的调用点保持可用）。
6. 未触碰本次范围外的代码（尤其不顺手改 `report.ts:95` 的既有措辞）。

---

## 七、需要用户拍板的点（执行前确认）

| 点 | 我的默认建议 | 为什么开放 |
|---|---|---|
| `MIN_EVIDENCE_FOR_CORPUS` 阈值 | **3** | 纯代码惯例推断，配置里没写；2 或 3 都讲得通 |
| "过半"是否为严格 `> 0.5` | **严格大于** | 配置文字是"过半"，等于 50% 算不算过半有歧义 |
| 是否同时收敛 `report.ts:95` 的"个例证据占比高"措辞 | **不动，仅标注** | 属于既有瑕疵，超出本修复范围 |

如果执行时无法询问用户：按上述三列默认值实现，并在交付说明里复述这三条假设。
