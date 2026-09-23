/** OfferLens 共享类型 —— 纯逻辑层与扩展注册层的契约。 */

/* ---------------- 证据 ---------------- */

export type Staleness = "current" | "stale" | "unknown";
export type SampleSize = "personal" | "small" | "unlabelled" | "unknown";
export type ChannelAuthority = "official" | "ugc" | "web";

/** 采集 Agent 产出的原始条目（内容源工具的返回单元）。 */
export interface RawItem {
  source: string;
  url: string;
  platform: string;
  title: string;
  rawSnippet: string;
  publishedAt: string | null;
  author: string | null;
  channelAuthority: ChannelAuthority;
  comments?: string[] | null;
  extra?: Record<string, unknown>;
  fromUserUrl?: boolean;
}

/** 入库后的证据（appendEntry 的 data 载荷）。 */
export interface EvidenceRecord {
  id: string;
  source: string;
  url: string;
  platform: string;
  title: string;
  publishedAt: string | null;
  author: string | null;
  authorFeatures: { recentSameTopicCount: number | null; mid?: unknown };
  rawSnippet: string;
  contentHash: string;
  staleness: Staleness;
  sampleSize: SampleSize;
  channelAuthority: ChannelAuthority;
  comments: string[] | null;
  fetchedAt: string;
}

/* ---------------- 质检特征 ---------------- */

export interface EvidenceFeatures {
  relevance: "on-topic" | "tangent" | "unknown";
  promoCode: { state: boolean | null; hits: string[] };
  sampleSize: SampleSize;
  staleness: Staleness;
  authorDensity: "low" | "mid" | "high" | "unknown";
  densityProxy: "in-corpus";
  commentRebuttal: "hasRebuttal" | "none" | "unknown";
  daysAgo: number | null;
  excerpts: { promoHits: string[]; sampleSizeHint: string | null };
}

export interface Assessment {
  id: string;
  features: EvidenceFeatures;
  notes: string[];
}

export interface VerifierResult {
  assessments: Assessment[];
  corpus: {
    total: number;
    onTopic: number;
    tangent: number;
    promoCount: number;
    staleCount: number;
    currentCount: number;
    personalCount: number;
    density: "low" | "mid" | "high" | "unknown";
  };
  summary: string;
}

/* ---------------- 反方 ---------------- */

export interface LrAdjustment {
  feature: string;
  multiplier: number;
  argument: string;
}

export interface ContrarianResult {
  rebuttal: string;
  lrAdjustments: LrAdjustment[];
  couldNotRefute: boolean;
  claim: string;
}

/* ---------------- 采集 ---------------- */

export interface SourcePlanEntry {
  tool: "fetch_bilibili" | "fetch_web" | "fetch_rss" | "fetch_youtube";
  args: Record<string, string>;
}

export interface DegradedChannel {
  channel: string;
  query: string;
  reason: string;
}

export interface CollectorResult {
  items: (RawItem & { viaHypothesis?: string })[];
  degraded: DegradedChannel[];
  plan: { queries: string[]; urls: string[]; bilibili: number; web: string[]; rss: string[] };
}

/* ---------------- 假设与编排 ---------------- */

export type HypothesisState = "open" | "supported" | "refuted" | "abandoned" | "insufficient-evidence";

export interface Hypothesis {
  slug: string;
  statement: string;
  queries: string[];
}

export interface SourcePlan {
  parsed: ParsedQuestion;
  hypotheses: Hypothesis[];
  hypothesisPlans: Record<string, SourcePlanEntry[]>;
  rationale: string;
  claim: string | null;
  url: string | null;
}

export interface ParsedQuestion {
  raw: string;
  companies: string[];
  kind: "claim-like" | "info";
  rateLike: boolean;
  queries: string[];
}

/* ---------------- 派发载荷（schema 的 Static 类型） ---------------- */

export interface CollectorPayload {
  hypothesis: string;
  queries: string[];
  urls?: string[];
  sourcePlan?: SourcePlanEntry[];
}
export interface VerifierPayload {
  evidence_ids: string[];
  claim?: string;
  focus?: string;
}
export interface ContrarianPayload {
  claim: string;
  evidence_ids: string[];
}

/* ---------------- 置信度 ---------------- */

export interface ContributionRow {
  evidenceId: string;
  feature: string;
  state: string;
  lr: number;
  multiplier: number;
  contribution: number;
  excluded: boolean;
  contrarianAdjustable: boolean;
}

export interface CorpusRow {
  feature: string;
  contribution: number;
  state: string;
}

export interface AppliedAdjustment {
  feature: string;
  multipliers?: number[];
  effective?: number;
  applied: boolean;
  reason?: string;
}

export interface CalibrationResult {
  posterior: number;
  logodds: number;
  contributions: ContributionRow[];
  appliedAdjustments: AppliedAdjustment[];
  multipliers: Record<string, number>;
  corpusRows: CorpusRow[];
  saturated: Map<string, number>;
  excludedCount: number;
}

export interface SensitivityEntry {
  feature: string;
  totalContribution: number;
  deltaP: number;
  sensitive: boolean;
  touchedByContrarian: boolean;
  note?: string;
}
