import { z } from 'zod';

export const BiasSchema = z.enum(['Bullish', 'Bearish', 'Neutral']);
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

export const AccuracyReviewSchema = z.object({
  yesterday_prediction: BiasSchema,
  yesterday_headline: z.string(),
  actual_move: z.number(),
  actual_direction: CueDirectionSchema,
  nifty_close: z.number(),
  correct: z.boolean(),
});

export const AnalysisSchema = z.object({
  date: z.string(),
  overall_bias: BiasSchema,
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
});

export type Bias = z.infer<typeof BiasSchema>;
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
export type DailyAnalysis = z.infer<typeof AnalysisSchema>;
