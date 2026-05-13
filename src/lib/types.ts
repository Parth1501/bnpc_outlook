import { z } from 'zod';

/** Pre-open directional label; Strongly* when ≥4 of 5 rubric factors align with meaningful magnitude. */
export const BiasSchema = z.enum([
  'Strongly Bullish',
  'Bullish',
  'Neutral',
  'Bearish',
  'Strongly Bearish',
]);

export const BiasHorizonSchema = z.enum(['open', 'morning_session', 'full_day']);

export const BiasLabelConfidenceSchema = z.enum(['low', 'medium', 'high']);

/** Per-factor tilt for the overall_bias rubric (not price forecasts). */
export const FactorTiltSchema = z.enum(['positive', 'negative', 'neutral']);

export const BiasRationaleSchema = z.object({
  news_tone: FactorTiltSchema,
  global_cues: FactorTiltSchema,
  fii_dii: FactorTiltSchema,
  vix: FactorTiltSchema,
  calendar: FactorTiltSchema,
  factors_aligned: z.number().int().min(0).max(5),
  one_line: z.string().max(500),
});
export const ImpactSchema = z.enum(['High', 'Moderate', 'Low']);
export const DirectionSchema = z.enum(['Positive', 'Negative', 'Mixed']);
export const CueDirectionSchema = z.enum(['up', 'down', 'flat']);

export const GlobalCueSchema = z.object({
  name: z.string(),
  value: z.union([z.number(), z.string()]),
  change: z.number(),
  change_pct: z.number(),
  direction: CueDirectionSchema,
});

export const KeyDriverSchema = z.object({
  headline: z.string(),
  impact: ImpactSchema,
  direction: DirectionSchema,
  why_it_matters: z.string(),
  sectors_affected: z.array(z.string()),
  stocks_affected: z.array(z.string()),
  source: z.string(),
  time_ist: z.string(),
});

export const StockWatchSchema = z.object({
  symbol: z.string(),
  note: z.string(),
});

export const SectorImpactSchema = z.object({
  sector: z.string(),
  impact: ImpactSchema,
  direction: DirectionSchema,
  reason: z.string(),
  stocks_to_watch: z.array(StockWatchSchema),
});

export const LevelsSchema = z.object({
  support: z.array(z.number()),
  resistance: z.array(z.number()),
});

export const FiiDiiSchema = z.object({
  date: z.string(),
  fii_net: z.number(),
  dii_net: z.number(),
  fii_buy: z.number(),
  fii_sell: z.number(),
  dii_buy: z.number(),
  dii_sell: z.number(),
});

export const CalendarEventSchema = z.object({
  time_ist: z.string(),
  event: z.string(),
  country: z.string().optional(),
  importance: ImpactSchema,
  forecast: z.string().nullable().optional(),
  previous: z.string().nullable().optional(),
});

export const WatchlistItemSchema = z.object({
  symbol: z.string(),
  thesis: z.string(),
  trigger: z.string(),
});

export const ResultTimingSchema = z.enum(['During Market', 'Post Market', 'Pre Market', 'TBD']);

export const StockResultSchema = z.object({
  symbol: z.string(),
  company: z.string(),
  timing: ResultTimingSchema,
  expected_time_ist: z.string().optional(),
  note: z.string().optional(),
  metric_unit: z.string().optional(),
  estimate_eps: z.number().nullable().optional(),
  actual_eps: z.number().nullable().optional(),
  estimate_revenue: z.number().nullable().optional(),
  actual_revenue: z.number().nullable().optional(),
  revenue_yoy_pct: z.number().nullable().optional(),
  net_profit_actual: z.number().nullable().optional(),
  net_profit_yoy_pct: z.number().nullable().optional(),
  ebitda_actual: z.number().nullable().optional(),
  ebitda_yoy_pct: z.number().nullable().optional(),
  currency: z.string().optional(),
  result_declared: z.boolean().optional(),
  result_declared_at_ist: z.string().optional(),
});

export const PolicyCategorySchema = z.enum(['Taxation', 'Equity Market', 'FnO Market', 'Bond Market', 'Compliance', 'Other']);

export const PolicyNoteSchema = z.object({
  title: z.string(),
  authority: z.string(),
  category: PolicyCategorySchema,
  fy: z.string(),
  effective_from: z.string().optional(),
  source_url: z.string(),
  note: z.string(),
});

export const RetailPolicyImpactSchema = z.object({
  title: z.string(),
  category: PolicyCategorySchema,
  fy: z.string(),
  impact_on_retail: z.string(),
  what_to_watch: z.string(),
  source_url: z.string(),
});

export const AccuracyVerdictSchema = z.enum(['hit', 'soft_miss', 'hard_miss']);

export const AccuracyReviewSchema = z.object({
  yesterday_prediction: BiasSchema,
  yesterday_headline: z.string(),
  actual_move: z.number(),
  actual_direction: CueDirectionSchema,
  nifty_close: z.number(),
  correct: z.boolean(),
  /** How many rubric factors aligned the way overall_bias leaned (from yesterday's file, if present). */
  factors_aligned_at_call: z.number().int().min(0).max(5).optional(),
  /** bias_confidence from yesterday's analysis when verify ran. */
  bias_confidence_at_call: BiasLabelConfidenceSchema.optional(),
  /** hit = directionally right; soft_miss = wrong but low-confidence call; hard_miss = wrong with medium/high confidence. */
  verdict: AccuracyVerdictSchema.optional(),
});

/** India VIX snapshot from market fetch; injected into analyses from pipeline truth. */
export const IndiaVixSnapshotSchema = z.object({
  value: z.number(),
  previous_close: z.number(),
  change: z.number(),
  change_percent: z.number(),
  as_of: z.string(),
});

export const AnalysisSchema = z.object({
  date: z.string(),
  overall_bias: BiasSchema,
  /** What time horizon overall_bias describes (product standard: pre-open / opening bias). */
  bias_horizon: BiasHorizonSchema.default('open'),
  /** How tightly rubric factors aligned when choosing the label. */
  bias_confidence: BiasLabelConfidenceSchema.default('medium'),
  /** Per-factor tilts and alignment count — must justify overall_bias. */
  bias_rationale: BiasRationaleSchema,
  confidence: z.number().min(0).max(100),
  headline_call: z.string().max(200),
  summary: z.string(),
  global_cues: z.array(GlobalCueSchema),
  key_drivers: z.array(KeyDriverSchema),
  sector_impact: z.array(SectorImpactSchema),
  levels: z.object({
    nifty: LevelsSchema,
    sensex: LevelsSchema,
  }),
  fii_dii: FiiDiiSchema,
  economic_calendar: z.array(CalendarEventSchema),
  risk_factors: z.array(z.string()),
  watchlist: z.array(WatchlistItemSchema),
  today_results: z.array(StockResultSchema).default([]),
  policy_notes: z.array(PolicyNoteSchema).default([]),
  retail_policy_impact: z.array(RetailPolicyImpactSchema).default([]),
  accuracy_review: AccuracyReviewSchema.optional(),
  india_vix: IndiaVixSnapshotSchema.nullish(),
});

export type Bias = z.infer<typeof BiasSchema>;
export type BiasHorizon = z.infer<typeof BiasHorizonSchema>;
export type BiasLabelConfidence = z.infer<typeof BiasLabelConfidenceSchema>;
export type FactorTilt = z.infer<typeof FactorTiltSchema>;
export type BiasRationale = z.infer<typeof BiasRationaleSchema>;
export type AccuracyVerdict = z.infer<typeof AccuracyVerdictSchema>;
export type Impact = z.infer<typeof ImpactSchema>;
export type Direction = z.infer<typeof DirectionSchema>;
export type CueDirection = z.infer<typeof CueDirectionSchema>;
export type GlobalCue = z.infer<typeof GlobalCueSchema>;
export type KeyDriver = z.infer<typeof KeyDriverSchema>;
export type StockWatch = z.infer<typeof StockWatchSchema>;
export type SectorImpact = z.infer<typeof SectorImpactSchema>;
export type Levels = z.infer<typeof LevelsSchema>;
export type FiiDii = z.infer<typeof FiiDiiSchema>;
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type WatchlistItem = z.infer<typeof WatchlistItemSchema>;
export type ResultTiming = z.infer<typeof ResultTimingSchema>;
export type StockResult = z.infer<typeof StockResultSchema>;
export type PolicyCategory = z.infer<typeof PolicyCategorySchema>;
export type PolicyNote = z.infer<typeof PolicyNoteSchema>;
export type RetailPolicyImpact = z.infer<typeof RetailPolicyImpactSchema>;
export type AccuracyReview = z.infer<typeof AccuracyReviewSchema>;
export type IndiaVixSnapshot = z.infer<typeof IndiaVixSnapshotSchema>;
export type DailyAnalysis = z.infer<typeof AnalysisSchema>;
