import type { Bias, BiasRationale } from './types';

/** Used when archives or LLM output omit or partially fill bias rationale. */
export const DEFAULT_BIAS_RATIONALE: BiasRationale = {
  news_tone: 'neutral',
  global_cues: 'neutral',
  fii_dii: 'neutral',
  vix: 'neutral',
  calendar: 'neutral',
  factors_aligned: 0,
  one_line: 'Legacy or partial output — no factor-by-factor rationale on file.',
};

const FACTOR_TILTS = ['positive', 'negative', 'neutral'] as const;
type FactorTilt = (typeof FACTOR_TILTS)[number];

const HORIZONS = ['open', 'morning_session', 'full_day'] as const;
const LABEL_CONF = ['low', 'medium', 'high'] as const;

function coerceFactorTilt(v: unknown): FactorTilt {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'positive' || s === 'negative' || s === 'neutral') return s;
  return 'neutral';
}

/** Coerce LLM / legacy strings into AnalysisSchema `overall_bias`. */
export function normalizeOverallBiasString(v: unknown): Bias {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const map: Record<string, Bias> = {
    'strongly bullish': 'Strongly Bullish',
    'strong bullish': 'Strongly Bullish',
    bullish: 'Bullish',
    neutral: 'Neutral',
    bearish: 'Bearish',
    'strongly bearish': 'Strongly Bearish',
    'strong bearish': 'Strongly Bearish',
  };
  return map[s] ?? 'Neutral';
}

/**
 * Mutates a plain analysis object before `AnalysisSchema.safeParse` / `parse`.
 * Fills `bias_horizon`, `bias_confidence`, `bias_rationale`, and coerces `overall_bias`.
 */
export function normalizeBiasFieldsForAnalysisParse(o: Record<string, unknown>): void {
  o.overall_bias = normalizeOverallBiasString(o.overall_bias);

  const hz = String(o.bias_horizon ?? '').trim();
  o.bias_horizon = HORIZONS.includes(hz as (typeof HORIZONS)[number]) ? hz : 'open';

  let br = o.bias_rationale;
  if (typeof br !== 'object' || br === null || Array.isArray(br)) {
    o.bias_rationale = { ...DEFAULT_BIAS_RATIONALE };
    br = o.bias_rationale;
  } else {
    const r = br as Record<string, unknown>;
    const n = Number(r.factors_aligned);
    const aligned = Number.isFinite(n) ? Math.min(5, Math.max(0, Math.round(n))) : 0;
    const oneLine = String(r.one_line ?? '').trim().slice(0, 500);
    o.bias_rationale = {
      news_tone: coerceFactorTilt(r.news_tone),
      global_cues: coerceFactorTilt(r.global_cues),
      fii_dii: coerceFactorTilt(r.fii_dii),
      vix: coerceFactorTilt(r.vix),
      calendar: coerceFactorTilt(r.calendar),
      factors_aligned: aligned,
      one_line: oneLine.length > 0 ? oneLine : DEFAULT_BIAS_RATIONALE.one_line,
    };
  }

  const rationale = o.bias_rationale as BiasRationale;
  let bc = String(o.bias_confidence ?? '').trim();
  if (!LABEL_CONF.includes(bc as (typeof LABEL_CONF)[number])) {
    if (o.overall_bias === 'Neutral') bc = 'medium';
    else if (rationale.factors_aligned >= 4) bc = 'high';
    else if (rationale.factors_aligned === 3) bc = 'medium';
    else bc = 'low';
  }
  o.bias_confidence = bc;
}

export function mergeAnalysisDefaultsIntoClone(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('mergeAnalysisDefaultsIntoClone: expected a non-array object');
  }
  const o = { ...(raw as Record<string, unknown>) };
  normalizeBiasFieldsForAnalysisParse(o);
  return o;
}
