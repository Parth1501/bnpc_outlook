/**
 * analyze.ts
 * Reads raw data, calls OpenRouter, validates via Zod schema,
 * and saves src/data/analyses/YYYY-MM-DD.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { normalizeBiasFieldsForAnalysisParse } from '../src/lib/merge-analysis-for-parse';
import { AnalysisSchema, IndiaVixSnapshotSchema, type IndiaVixSnapshot } from '../src/lib/types';

type Role = 'system' | 'user' | 'assistant';
type ChatMessage = { role: Role; content: string };
type CalendarEvent = {
  time_ist: string;
  event: string;
  country?: string;
  importance: 'High' | 'Moderate' | 'Low';
  forecast?: string | null;
  previous?: string | null;
};
type StockResult = {
  symbol: string;
  company: string;
  timing: 'During Market' | 'Post Market' | 'Pre Market' | 'TBD';
  expected_time_ist?: string;
  note?: string;
  metric_unit?: string;
  estimate_eps?: number | null;
  actual_eps?: number | null;
  estimate_revenue?: number | null;
  actual_revenue?: number | null;
  revenue_yoy_pct?: number | null;
  net_profit_actual?: number | null;
  net_profit_yoy_pct?: number | null;
  ebitda_actual?: number | null;
  ebitda_yoy_pct?: number | null;
  currency?: string;
  result_declared?: boolean;
  result_declared_at_ist?: string;
};
type MarketCue = {
  name?: string;
  value?: number | string;
  change?: number;
  change_pct?: number;
  direction?: 'up' | 'down' | 'flat';
  recency?: 'prior_close' | 'overnight';
  source?: 'live' | 'proxy' | 'market' | 'derived';
};
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';
const JSON_SAFE_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_SITE_URL = 'https://localhost';
const APP_TITLE = 'Indian Market Outlook';
const DEFAULT_ANALYZE_MAX_TOKENS = 32000;
const SYSTEM_PROMPT = [
  'You are a senior Indian equities analyst for BNPC, an Indian market research platform.',
  'Return ONLY valid JSON (no markdown fences). Your output schema is fixed — keep all passthrough fields unchanged from input.',
  '',
  '## ABSOLUTE RULES — NON-NEGOTIABLE',
  '',
  'ZERO FABRICATION: Never invent headlines, numbers, company names, ticker symbols, prices, percentages, earnings, EPS, PAT, YoY figures, or events.',
  'Do NOT use training-data knowledge to fill gaps. Do NOT merge information from two news items to create a claim neither item made alone.',
  'Do NOT fabricate or speculate about facts, numbers, headlines, targets, or trade outcomes.',
  'Allowed exception: overall_bias and full_day_bias are editorial directional outlook labels, not price forecasts. Keep wording hedged ("tilts", "skews", "risk-on/off") and never provide targets, stop-losses, or buy/sell advice.',
  '',
  'HARD GROUNDING — company results:',
  '  You MAY cite a specific number (EPS, PAT, revenue, YoY %) for a company ONLY IF:',
  '    (a) that exact number appears for that symbol in <verified_results>.declared_with_metrics, OR',
  '    (b) that EXACT number appears verbatim in a <news> title or description for THAT company.',
  '  A number found in a headline about Company A MUST NOT be attributed to Company B.',
  '  If declared_with_metrics is empty, write only themes and flows — no company-specific earnings figures anywhere.',
  '',
  'LANGUAGE — "declared" / official results:',
  '  Do NOT say results were "declared", "announced", "published", "released", or "are out" for a company unless EITHER:',
  '    (i) that exact claim appears in a specific <news> title or description for that company (same name or NSE symbol in the same item), OR',
  '    (ii) that symbol appears in <verified_results>.declared_with_metrics with a non-null metric you are citing.',
  '  If news only reports numbers, commentary, or "Q4" without clear official wording, use hedged language: "headlines reference", "reports mention", "media coverage" — not "declared" or "announced".',
  '  Never imply an exchange or board "declaration" from inference or from another company\'s headline.',
  '',
  'Never use the exact phrase "Verified results" or imply pipeline verification in user-visible text — that misreads the product; use publisher names from input or hedged wording.',
  '',
  'HARD GROUNDING — market levels:',
  '  Quote Nifty/Sensex/Dow/Nasdaq/Brent/Gold/USD-INR/US 10Y/Nikkei ONLY from <global_cues> matching by name.',
  '  Never substitute figures from memory or news.',
  '',
  'HARD GROUNDING — India VIX:',
  '  Quote only the value in <india_vix>. If null, do not mention a VIX number.',
  '',
  'HANDLE UNCERTAINTY:',
  '  If a news item is ambiguous about which company a figure belongs to, do NOT include that figure.',
  '  If items conflict, present both views — do not resolve the conflict by choosing one.',
  '  If insufficient data exists for a field, use generic language ("awaited", "no specific data") rather than inventing content.',
  '',
  'Other rules: Use NSE symbols. Explain mechanisms. No buy/sell/target/stop-loss advice. Numeric confidence range 35–85.',
  '',
  '## opening and full-day editorial protocol (NOT investment advice)',
  '',
  'overall_bias is the OPENING verdict: a pre-open editorial label for the gap / first prints only.',
  'full_day_bias is the FULL-DAY verdict: an editorial label for likely session tilt across the full Indian trading day.',
  'Both labels are outlooks, not investment advice, not targets, and not recommendations to trade.',
  'For this product, bias_horizon MUST always be the string "open" because overall_bias is the opening verdict.',
  '',
  'Rubric factors (assign each factor tilt: positive | negative | neutral in bias_rationale):',
  '  (1) news_tone — FORWARD catalysts only: results due today, guidance, regulation, deals, upgrades/downgrades, supply/demand shocks. Treat recap/wrap stories ("ended higher", "rallied", "fell yesterday") as background, not forward catalysts;',
  '  (2) global_cues — overnight cues only from <cue_recency>.overnight: US close, Asian direction, real Gift Nifty, or "Implied open (proxy)". Never let prior-close Nifty/Sensex direction push this factor;',
  '  (3) fii_dii — net flow direction and magnitude vs recent context from <fii_dii> (use sign and rough scale; do not invent numbers not in input);',
  '  (4) vix — India VIX level and direction vs prior snapshot from <india_vix> (if null, set vix tilt neutral and do not invent VIX);',
  '  (5) calendar — high-impact events pending today from <economic_calendar>.',
  '',
  'ALL-SECTOR CONTRADICTION RULE:',
  '  For every sector independently, today\'s forward catalyst overrides yesterday\'s price action. If a sector rallied yesterday but today has negative forward news, mark it Negative/Mixed based on today, not yesterday. If it fell yesterday but has positive forward news today, mark it Positive/Mixed based on today. This applies to Banking, Financial Services, IT, Pharma, FMCG, Auto, Energy, Metals, Infrastructure, Realty, and any other sector you mention.',
  '',
  'FULL-DAY VERDICT:',
  '  Build full_day_bias from forward catalysts across the whole session: sector news, results due during/post-market, economic-calendar events during the day, FII/DII trend, and ongoing global risk drift. Gift Nifty or implied-open tells the open, not the full-day verdict by itself.',
  '  Set full_day_confidence 35–85 based on driver alignment and data quality. Thin/conflicted data must stay low/medium conviction.',
  '  full_day_rationale.one_line must name the dominant full-day drivers in plain English.',
  '',
  'Label selection (same inputs → same label; default to Neutral when conflicted or weak):',
  '  - Neutral: factors conflict, or fewer than 3 of 5 share the same directional lean, or data is too thin to lean.',
  '  - Bullish or Bearish: at least 3 of 5 factor tilts lean the same way (positive for Bullish, negative for Bearish).',
  '  - Strongly Bullish or Strongly Bearish: at least 4 of 5 align the same way AND magnitudes in cues/flows/VIX feel meaningful (not marginal noise).',
  '',
  'Set bias_rationale.factors_aligned to the count of factors that lean WITH the chosen directional side (0 if Neutral).',
  'If overall_bias is Neutral, all factor tilts may be mixed; set factors_aligned to 0 and explain in one_line.',
  '',
  'bias_confidence (low | medium | high) — confidence in the LABEL, not in prices:',
  '  - high: 4–5 aligned with meaningful magnitude, or unanimous lean with strong cues;',
  '  - medium: exactly 3 aligned, or 4+ but magnitudes are small/ambiguous;',
  '  - low: borderline counts, conflicting secondary signals, or thin data.',
  '',
  'bias_rationale.one_line must justify overall_bias in plain English and name the dominant inputs.',
].join('\n');

function loadEnvFromFile(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

function loadJson<T>(filename: string): T {
  const p = path.join(process.cwd(), 'tmp', filename);
  if (!fs.existsSync(p)) throw new Error(`Missing: ${p} — run fetch scripts first`);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

function maybeLoadJson<T>(filename: string): T | null {
  const p = path.join(process.cwd(), 'tmp', filename);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function dayOfWeek(): string {
  return new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long' });
}

function yesterdayIST(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

type AnalysisInput = {
  date: string;
  dayName: string;
  yesterday: string;
  news: unknown[];
  globalCues: unknown[];
  cueRecency: Record<string, string[]>;
  fiiDii: unknown;
  indiaVix: unknown;
  calendar: unknown[];
  results: unknown[];
  yesterdayReview: unknown;
  verifiedResults: unknown;
};

/** Overwrites `analysis.india_vix` from pipeline (`raw-market.json`) when present. */
function applyPipelineIndiaVix(
  analysis: { india_vix?: IndiaVixSnapshot | null },
  market: Record<string, unknown>
): void {
  if (!Object.prototype.hasOwnProperty.call(market, 'india_vix')) return;
  const raw = market.india_vix;
  if (raw === null) {
    analysis.india_vix = null;
    return;
  }
  const parsed = IndiaVixSnapshotSchema.safeParse(raw);
  analysis.india_vix = parsed.success ? parsed.data : undefined;
}

/**
 * The LLM sometimes writes "Verified results" in headline/source, which reads as if
 * it came from `verified_results` JSON — it did not. Replace that mislabel so the
 * page does not imply pipeline-verified figures.
 */
function sanitizeMisleadingVerifiedPhrasing(analysis: {
  headline_call: string;
  summary: string;
  key_drivers: Array<{ headline: string; why_it_matters: string; source: string }>;
}): number {
  let changes = 0;
  const badPhrase = /\bverified\s+results\b/gi;
  const repl = 'News reports';

  const apply = (before: string): string => {
    const after = before.replace(badPhrase, repl);
    if (after !== before) changes++;
    return after;
  };

  analysis.headline_call = apply(analysis.headline_call);
  analysis.summary = apply(analysis.summary);

  const badSource = /^\s*verified\s*results?\s*$/i;
  for (const d of analysis.key_drivers) {
    d.headline = apply(d.headline);
    d.why_it_matters = apply(d.why_it_matters);
    if (badSource.test(d.source) || /^verified\s+/i.test(d.source.trim())) {
      d.source = 'News flow';
      changes++;
    }
  }
  return changes;
}

function hasDeclaredMetrics(r: StockResult): boolean {
  if (r.result_declared !== true) return false;
  return (
    r.actual_eps != null ||
    r.estimate_eps != null ||
    r.revenue_yoy_pct != null ||
    r.net_profit_yoy_pct != null ||
    r.net_profit_actual != null ||
    r.ebitda_yoy_pct != null ||
    r.ebitda_actual != null ||
    r.actual_revenue != null
  );
}

/** Only metrics the model may quote as factual (from pipeline, declared results only). */
function verifiedResultsSnapshot(results: StockResult[]): Record<string, unknown> {
  const declared = results
    .filter((r) => hasDeclaredMetrics(r))
    .map((r) => {
      const row: Record<string, unknown> = { symbol: r.symbol, company: r.company };
      if (r.actual_eps != null) row.actual_eps = r.actual_eps;
      if (r.estimate_eps != null) row.estimate_eps = r.estimate_eps;
      if (r.revenue_yoy_pct != null) row.revenue_yoy_pct = r.revenue_yoy_pct;
      if (r.net_profit_yoy_pct != null) row.net_profit_yoy_pct = r.net_profit_yoy_pct;
      if (r.net_profit_actual != null) row.net_profit_actual = r.net_profit_actual;
      if (r.ebitda_yoy_pct != null) row.ebitda_yoy_pct = r.ebitda_yoy_pct;
      if (r.currency) row.currency = r.currency;
      return row;
    });
  const pending = results
    .filter((r) => !r.result_declared)
    .slice(0, 25)
    .map((r) => ({ symbol: r.symbol, company: r.company, timing: r.timing }));
  return {
    note:
      'Quantitative earnings (EPS, PAT, YoY %, revenue) may appear ONLY for symbols in declared_with_metrics. For pending_scheduled, say results awaited/scheduled only — no outcomes. You may paraphrase <news> headlines without adding numbers not in the headline text. Do not call results "declared" or "announced" unless that wording appears in the cited news item for that company or the symbol is in declared_with_metrics; otherwise use "reports mention" / "headlines reference".',
    declared_with_metrics: declared,
    pending_scheduled: pending,
  };
}

function buildUserPrompt(input: AnalysisInput): string {
  const shape = {
    date: input.date,
    overall_bias: 'Strongly Bullish|Bullish|Neutral|Bearish|Strongly Bearish',
    bias_horizon: 'open|morning_session|full_day',
    bias_confidence: 'low|medium|high',
    bias_rationale: {
      news_tone: 'positive|negative|neutral',
      global_cues: 'positive|negative|neutral',
      fii_dii: 'positive|negative|neutral',
      vix: 'positive|negative|neutral',
      calendar: 'positive|negative|neutral',
      factors_aligned: 'integer 0..5',
      one_line: 'string max 500 chars',
    },
    confidence: '0..100',
    full_day_bias: 'Strongly Bullish|Bullish|Neutral|Bearish|Strongly Bearish',
    full_day_confidence: '0..100',
    full_day_rationale: {
      one_line: 'string max 500 chars',
      factors_aligned: 'integer 0..5 optional',
    },
    headline_call: 'string max 200 chars',
    summary: 'string',
    key_drivers: [
      {
        headline: 'string',
        impact: 'High|Moderate|Low',
        direction: 'Positive|Negative|Mixed',
        why_it_matters: 'string',
        sectors_affected: ['string'],
        stocks_affected: ['NSE_SYMBOL'],
        source: 'string',
        time_ist: 'HH:MM',
      },
    ],
    global_cues: '<use input global cues unchanged>',
    sector_impact: [
      {
        sector: 'string',
        impact: 'High|Moderate|Low',
        direction: 'Positive|Negative|Mixed',
        reason: 'string',
        stocks_to_watch: [{ symbol: 'NSE_SYMBOL', note: 'string' }],
      },
    ],
    levels: {
      nifty: { support: [0], resistance: [0] },
      sensex: { support: [0], resistance: [0] },
    },
    fii_dii: '<use input flows unchanged>',
    economic_calendar: [
      {
        time_ist: 'HH:MM',
        event: 'string',
        country: 'IN|US|GLOBAL',
        importance: 'High|Moderate|Low',
        forecast: 'string|null',
        previous: 'string|null',
      },
    ],
    risk_factors: ['string'],
    watchlist: [{ symbol: 'NSE_SYMBOL', thesis: 'string', trigger: 'string' }],
    today_results: '<use input today_results unchanged>',
  };

  return `Date: ${input.date} (${input.dayName}), narrative is for Indian pre-open IST.
News window anchor: stories from ${input.yesterday} 15:30 IST onwards (see tags below).
Global cues and FII/DII numbers are snapshots from YOUR data pipeline fetch time — they are not a live exchange tick unless the product says so. Do not imply same-day results are announced unless verified below.

Use these inputs:
<news>${JSON.stringify(input.news)}</news>
<global_cues>${JSON.stringify(input.globalCues)}</global_cues>
<cue_recency>${JSON.stringify(input.cueRecency)}</cue_recency>
<india_vix>${JSON.stringify(input.indiaVix)}</india_vix>
<fii_dii>${JSON.stringify(input.fiiDii)}</fii_dii>
<economic_calendar>${JSON.stringify(input.calendar)}</economic_calendar>
<today_results>${JSON.stringify(input.results)}</today_results>
<verified_results>${JSON.stringify(input.verifiedResults)}</verified_results>
<yesterday_review>${JSON.stringify(input.yesterdayReview ?? 'no prior data')}</yesterday_review>

Rules:
- Return valid JSON only, matching schema exactly.
- bias_horizon MUST be "open" for this product (pre-open / opening bias only).
- Apply the overall_bias rubric in the system prompt: set bias_rationale tilts and factors_aligned consistently with overall_bias and bias_confidence.
- Produce BOTH verdicts: overall_bias is the opening verdict; full_day_bias and full_day_confidence are the whole-session outlook.
- Keep global_cues, fii_dii, economic_calendar, today_results unchanged from input.
- Use <cue_recency>.overnight only for the global_cues factor. Treat <cue_recency>.prior_close names as stale prior-session context, not forward signals.
- For sector_impact, ignore yesterday's rally/fall when it conflicts with today's forward news. This rule applies to every sector, not only IT.
- HARD GROUNDING: For Nifty/Sensex/Dow/Nasdaq/Brent/Gold/USD-INR/US 10Y/Nikkei etc., quote percentages and levels ONLY from <global_cues> (match by name). Do not substitute other figures from memory or news.
- India VIX: data in <india_vix> is factual from the snapshot (or null if unavailable). Reference it in key_drivers or risk_factors when relevant. Never invent VIX levels or percentages.
- HARD GROUNDING: For company results (EPS, PAT, YoY revenue/profit margin commentary), you MAY use explicit numbers ONLY if:
  (a) the numeric field appears for that symbol inside verified_results.declared_with_metrics, OR
  (b) the SAME number appears verbatim in <news> title/description — quote as "reported headline" briefly, do not recalculate.
- If a stock is only in verified_results.pending_scheduled (or not declared in today_results), you MUST NOT claim actual results or YoY/PAT outcomes. Say only "scheduled/awaited" etc.
- If declared_with_metrics is empty, do not put company-specific quantitative earnings (no "+X% PAT YoY" etc.) in headline_call, summary, or key_drivers; use themes, flows, and global cues only.
- DECLARED / ANNOUNCED LANGUAGE: Do not use "declared", "declared results", "announced results", "results are out", or "published results" in headline_call, summary, key_drivers (headline or why_it_matters), or sector_impact unless (1) that wording appears in the specific <news> item for that company/symbol, OR (2) that symbol is listed in verified_results.declared_with_metrics with a metric you cite. Otherwise use hedged phrasing ("headlines reference", "reports mention", "coverage of", "results awaited").
- NEVER use the phrase "Verified results" or "verified pipeline" in headline_call, summary, key_drivers headline, or why_it_matters — that phrase is not a data product label; it misleads readers. Use a real news publisher name or hedged wording above.
- key_drivers[].source MUST be exactly one of: (1) the "source" field from a <news> item you rely on for that driver, OR (2) one of these literals: "Global cues", "FII/DII", "Economic calendar", "India VIX", "NSE results calendar". Do not invent labels like "Verified Results".
- Cover all 10 sectors in sector_impact (use Low if no catalyst).
- In key_drivers and sector_impact: use impact ONLY as magnitude size (High|Moderate|Low). Use direction ONLY for bullish/bearish tone (Positive|Negative|Mixed). Never put Positive, Negative, or Mixed in impact.
- No buy/sell/target/stop-loss advice.
- Confidence range 35-85.
- ENTITY ATTRIBUTION: A number (profit, revenue, EPS, YoY %) from one company's headline MUST NOT appear in any output field associated with a different company. Example: if you see "₹1415 crore" for Tata Power in a headline, do not mention that figure under PFC, NTPC, or any other entity.
- IF IN DOUBT, OMIT: It is always better to return less information than to return wrong information. Omit a fact rather than invent or misattribute it.

Output schema:
${JSON.stringify(shape)}
`;
}

// ANALYZE_NEWS_COMPACT_LIMIT: default 70 after upstream dedupe/source caps.
// Set to 0 to send all items (higher tokens/cost).
function compactNewsForPrompt(raw: unknown[], limit?: number): Array<Record<string, string>> {
  const envRaw = process.env.ANALYZE_NEWS_COMPACT_LIMIT;
  const envLimit = envRaw == null ? 70 : Number(envRaw) || 0;
  const effective = limit ?? (envLimit > 0 ? envLimit : raw.length);
  const sorted = [...raw].sort((a, b) => {
    const ta = new Date(String((a as Record<string, unknown>).pubDate ?? '')).getTime();
    const tb = new Date(String((b as Record<string, unknown>).pubDate ?? '')).getTime();
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  return sorted
    .slice(0, effective)
    .map((x) => x as Record<string, unknown>)
    .map((n) => ({
      title: String(n.title ?? '').trim().slice(0, 180),
      source: String(n.source ?? '').trim().slice(0, 40),
      pubDate: String(n.pubDate ?? '').trim().slice(0, 40),
      description: String(n.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 220),
    }))
    .filter((n) => n.title.length > 0);
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  siteUrl: string,
  messages: ChatMessage[],
  allowFallback = true
): Promise<string> {
  const maxTokens = Number(process.env.ANALYZE_MAX_TOKENS ?? DEFAULT_ANALYZE_MAX_TOKENS);
  const safeMaxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_ANALYZE_MAX_TOKENS;
  let delayMs = 1200;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': siteUrl,
        'X-Title': APP_TITLE,
      },
      body: JSON.stringify({
        model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: safeMaxTokens,
      }),
    });

    if (res.ok) {
      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('OpenRouter response missing content');
      return content;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      console.warn(`  OpenRouter attempt ${attempt} failed with ${res.status}, retrying...`);
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= 2;
      continue;
    }

    const errBody = await res.text();
    if (
      allowFallback &&
      model !== JSON_SAFE_MODEL &&
      /json mode is not supported|code.?20024/i.test(errBody)
    ) {
      console.warn(`  Model ${model} does not support JSON mode. Falling back to ${JSON_SAFE_MODEL}.`);
      return callOpenRouter(apiKey, JSON_SAFE_MODEL, siteUrl, messages, false);
    }

    throw new Error(`OpenRouter HTTP ${res.status}: ${errBody.slice(0, 400)}`);
  }

  throw new Error('OpenRouter retries exhausted');
}

function parseJsonObject(text: string): unknown {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

const IMPACT_MAGNITUDE = new Set(['High', 'Moderate', 'Low']);
const IMPACT_SENTIMENT = new Set(['Positive', 'Negative', 'Mixed']);

function canonicalImpactWord(raw: unknown): string {
  const s = String(raw ?? '').trim();
  const lowered = s.toLowerCase();
  const mag: Record<string, string> = { high: 'High', moderate: 'Moderate', low: 'Low' };
  const dir: Record<string, string> = { positive: 'Positive', negative: 'Negative', mixed: 'Mixed' };
  return mag[lowered] ?? dir[lowered] ?? s;
}

/** LLMs sometimes assign Positive/Negative/Mixed to `impact` or swap magnitude vs sentiment. */
function fixImpactDirectionPair(
  impact: unknown,
  direction: unknown
): { impact: string; direction: string } {
  let i = canonicalImpactWord(impact);
  let d = canonicalImpactWord(direction);
  const iMag = IMPACT_MAGNITUDE.has(i);
  const dMag = IMPACT_MAGNITUDE.has(d);
  const iSent = IMPACT_SENTIMENT.has(i);
  const dSent = IMPACT_SENTIMENT.has(d);

  if (iSent && dMag) {
    const t = i;
    i = d;
    d = t;
  } else if (iSent && !dMag) {
    if (!dSent) {
      d = i;
      i = 'Moderate';
    } else {
      i = 'Moderate';
    }
  }

  const outI = IMPACT_MAGNITUDE.has(i) ? i : 'Moderate';
  const outD = IMPACT_SENTIMENT.has(d) ? d : 'Mixed';
  return { impact: outI, direction: outD };
}

function normalizeAnalysisImpactDirectionEnums(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) return;
  const obj = parsed as Record<string, unknown>;

  const fixArray = (key: string) => {
    const arr = obj[key];
    if (!Array.isArray(arr)) return;
    for (const row of arr) {
      if (typeof row !== 'object' || row == null || Array.isArray(row)) continue;
      const r = row as Record<string, unknown>;
      const pair = fixImpactDirectionPair(r.impact, r.direction);
      r.impact = pair.impact;
      r.direction = pair.direction;
    }
  };

  fixArray('key_drivers');
  fixArray('sector_impact');
}

function normalizeCalendar(raw: unknown): CalendarEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => x as Record<string, unknown>)
    .filter((x) => typeof x.time_ist === 'string' && typeof x.event === 'string' && typeof x.importance === 'string')
    .map((x) => ({
      time_ist: String(x.time_ist),
      event: String(x.event),
      country: x.country == null ? inferCountryFromEvent(String(x.event)) : String(x.country).toUpperCase(),
      importance: (x.importance === 'High' || x.importance === 'Low') ? x.importance : 'Moderate',
      forecast: x.forecast == null ? null : String(x.forecast),
      previous: x.previous == null ? null : String(x.previous),
    }));
}

function inferCountryFromEvent(event: string): string {
  const e = event.toLowerCase();
  if (/\bindia\b|\bind\b|nifty|sensex|rbi|iip|wpi|cpi india|gdp india|pmi india/.test(e)) return 'IN';
  if (/\bus\b|fed|fomc|nonfarm|jobless|eia|powell|treasury/.test(e)) return 'US';
  return 'GLOBAL';
}

function enrichCalendarWithCountry(
  modelCalendar: CalendarEvent[],
  rawCalendar: CalendarEvent[]
): CalendarEvent[] {
  return modelCalendar.map((item) => {
    if (item.country && item.country.trim().length > 0) {
      return { ...item, country: item.country.toUpperCase() };
    }
    const match = rawCalendar.find(
      (r) => r.event.toLowerCase() === item.event.toLowerCase() && r.time_ist === item.time_ist
    );
    if (match?.country) return { ...item, country: match.country.toUpperCase() };
    return { ...item, country: inferCountryFromEvent(item.event) };
  });
}

function cueRecencySnapshot(cues: unknown[]): Record<string, string[]> {
  const out: Record<string, string[]> = { overnight: [], prior_close: [] };
  for (const cue of cues as MarketCue[]) {
    const name = String(cue.name ?? '').trim();
    if (!name) continue;
    const bucket = cue.recency === 'prior_close' ? 'prior_close' : 'overnight';
    out[bucket].push(name);
  }
  return out;
}

function computeGlobalCueTilt(cues: unknown[]): 'positive' | 'negative' | 'neutral' {
  const weighted = (cues as MarketCue[])
    .filter((c) => c.recency === 'overnight' && typeof c.change_pct === 'number' && Number.isFinite(c.change_pct))
    .map((c) => {
      const name = String(c.name ?? '').toLowerCase();
      const weight =
        name.includes('implied open') || name.includes('gift') ? 1.8 :
        name.includes('nasdaq') ? 1.25 :
        name.includes('dow') || name.includes('nikkei') ? 1.0 :
        name.includes('usd/inr') || name.includes('brent') || name.includes('10y') ? -0.65 :
        0.5;
      return { pct: c.change_pct ?? 0, weight };
    });
  if (weighted.length === 0) return 'neutral';
  const score = weighted.reduce((sum, x) => sum + x.pct * x.weight, 0);
  if (score > 0.25) return 'positive';
  if (score < -0.25) return 'negative';
  return 'neutral';
}

function clampFullDayConfidence(confidence: number, aligned?: number): number {
  const safe = Number.isFinite(confidence) ? Math.round(confidence) : 45;
  if (aligned == null || aligned <= 2) return Math.min(65, Math.max(35, safe));
  if (aligned === 3) return Math.min(75, Math.max(35, safe));
  return Math.min(85, Math.max(35, safe));
}

function applyDeterministicCueGuardrails(
  analysis: ReturnType<typeof AnalysisSchema.parse>,
  cues: unknown[]
): void {
  const globalTilt = computeGlobalCueTilt(cues);
  analysis.bias_rationale.global_cues = globalTilt;
  analysis.full_day_confidence = clampFullDayConfidence(
    analysis.full_day_confidence,
    analysis.full_day_rationale.factors_aligned
  );
}

function normalizeTiming(value: unknown): StockResult['timing'] {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'during market') return 'During Market';
  if (v === 'post market') return 'Post Market';
  if (v === 'pre market') return 'Pre Market';
  return 'TBD';
}

function normalizeResults(raw: unknown): StockResult[] {
  if (!Array.isArray(raw)) return [];
  const rank: Record<StockResult['timing'], number> = {
    'During Market': 0,
    'Post Market': 1,
    'Pre Market': 2,
    'TBD': 3,
  };

  const seen = new Set<string>();
  const out: StockResult[] = [];
  for (const x of raw) {
    const r = x as Record<string, unknown>;
    const symbol = String(r.symbol ?? '').trim().toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({
      symbol,
      company: String(r.company ?? symbol).trim() || symbol,
      timing: normalizeTiming(r.timing),
      expected_time_ist: r.expected_time_ist == null ? undefined : String(r.expected_time_ist),
      note: r.note == null ? undefined : String(r.note),
      metric_unit: r.metric_unit == null ? undefined : String(r.metric_unit),
      estimate_eps: typeof r.estimate_eps === 'number' && Number.isFinite(r.estimate_eps) ? r.estimate_eps : null,
      actual_eps: typeof r.actual_eps === 'number' && Number.isFinite(r.actual_eps) ? r.actual_eps : null,
      estimate_revenue: typeof r.estimate_revenue === 'number' && Number.isFinite(r.estimate_revenue) ? r.estimate_revenue : null,
      actual_revenue: typeof r.actual_revenue === 'number' && Number.isFinite(r.actual_revenue) ? r.actual_revenue : null,
      revenue_yoy_pct: typeof r.revenue_yoy_pct === 'number' && Number.isFinite(r.revenue_yoy_pct) ? r.revenue_yoy_pct : null,
      net_profit_actual: typeof r.net_profit_actual === 'number' && Number.isFinite(r.net_profit_actual) ? r.net_profit_actual : null,
      net_profit_yoy_pct: typeof r.net_profit_yoy_pct === 'number' && Number.isFinite(r.net_profit_yoy_pct) ? r.net_profit_yoy_pct : null,
      ebitda_actual: typeof r.ebitda_actual === 'number' && Number.isFinite(r.ebitda_actual) ? r.ebitda_actual : null,
      ebitda_yoy_pct: typeof r.ebitda_yoy_pct === 'number' && Number.isFinite(r.ebitda_yoy_pct) ? r.ebitda_yoy_pct : null,
      currency: r.currency == null ? undefined : String(r.currency).toUpperCase(),
      result_declared: Boolean(r.result_declared),
      result_declared_at_ist: r.result_declared_at_ist == null ? undefined : String(r.result_declared_at_ist),
    });
  }
  return out.sort((a, b) => {
    const r = rank[a.timing] - rank[b.timing];
    if (r !== 0) return r;
    return a.symbol.localeCompare(b.symbol);
  });
}

function buildEmergencyAnalysis(input: {
  date: string;
  globalCues: unknown[];
  fiiDii: unknown;
  calendar: CalendarEvent[];
  todayResults: StockResult[];
  yesterdayReview: unknown;
  rawMarketRecord: Record<string, unknown>;
}): ReturnType<typeof AnalysisSchema.parse> {
  const sectors = [
    'Banking', 'Financial Services', 'IT', 'Pharmaceuticals', 'FMCG',
    'Auto', 'Energy', 'Metals', 'Infrastructure', 'Realty',
  ];
  const nifty = (input.globalCues as Array<Record<string, unknown>>).find((c) => String(c.name ?? '').toLowerCase().includes('nifty'));
  const sensex = (input.globalCues as Array<Record<string, unknown>>).find((c) => String(c.name ?? '').toLowerCase().includes('sensex'));
  const n = typeof nifty?.value === 'number' ? nifty.value : 24000;
  const s = typeof sensex?.value === 'number' ? sensex.value : 78000;

  const analysis = {
    date: input.date,
    overall_bias: 'Neutral' as const,
    bias_horizon: 'open' as const,
    bias_confidence: 'low' as const,
    bias_rationale: {
      news_tone: 'neutral' as const,
      global_cues: 'neutral' as const,
      fii_dii: 'neutral' as const,
      vix: 'neutral' as const,
      calendar: 'neutral' as const,
      factors_aligned: 0,
      one_line: 'Emergency fallback — model output invalid; rubric not applied. Treat opening bias as unclassified.',
    },
    confidence: 45,
    full_day_bias: 'Neutral' as const,
    full_day_confidence: 45,
    full_day_rationale: {
      one_line: 'Emergency fallback — model output invalid; full-day outlook is unclassified.',
      factors_aligned: 0,
    },
    headline_call: 'Mixed cues; follow data-driven risk management at open.',
    summary: 'Automated fallback analysis generated because model output was unavailable/invalid. Use global cues and flows for opening bias and wait for confirmation after first 30 minutes.',
    global_cues: Array.isArray(input.globalCues) ? input.globalCues : [],
    key_drivers: [
      {
        headline: 'Model output unavailable; fallback mode enabled',
        impact: 'Moderate' as const,
        direction: 'Mixed' as const,
        why_it_matters: 'Narrative generation failed, so only trusted fetched data is used for this report.',
        sectors_affected: ['All'],
        stocks_affected: [],
        source: 'System',
        time_ist: '09:00',
      },
    ],
    sector_impact: sectors.map((sector) => ({
      sector,
      impact: 'Low' as const,
      direction: 'Mixed' as const,
      reason: 'No sector-specific generated narrative available; track broad index and stock-specific news flow.',
      stocks_to_watch: [],
    })),
    levels: {
      nifty: { support: [Number((n * 0.995).toFixed(0)), Number((n * 0.99).toFixed(0))], resistance: [Number((n * 1.005).toFixed(0)), Number((n * 1.01).toFixed(0))] },
      sensex: { support: [Number((s * 0.995).toFixed(0)), Number((s * 0.99).toFixed(0))], resistance: [Number((s * 1.005).toFixed(0)), Number((s * 1.01).toFixed(0))] },
    },
    fii_dii: input.fiiDii,
    economic_calendar: input.calendar,
    risk_factors: ['R1: If global risk sentiment worsens pre-open, initial downside may extend.', 'R2: If yields/USD spike, risk assets can see pressure.'],
    watchlist: [],
    today_results: input.todayResults,
    accuracy_review: input.yesterdayReview ?? undefined,
  };
  applyPipelineIndiaVix(analysis, input.rawMarketRecord);
  return AnalysisSchema.parse(analysis);
}

async function main() {
  loadEnvFromFile();

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
  const siteUrl = process.env.SITE_URL?.trim() || DEFAULT_SITE_URL;

  if (!apiKey) {
    console.warn('  ⚠ OPENROUTER_API_KEY is not set. Using emergency fallback analysis.');
  }

  const date = todayIST();
  const dayName = dayOfWeek();
  const yesterday = yesterdayIST();

  console.log(`🤖 Analyzing market for ${date} (${dayName}) via OpenRouter...`);
  console.log(`  Model: ${model}`);

  const news = loadJson<unknown[]>('raw-news.json');
  const market = loadJson<{ global_cues: unknown[]; fii_dii: unknown; india_vix?: unknown }>('raw-market.json');
  const marketRecord = market as Record<string, unknown>;
  const calendar = maybeLoadJson<unknown[]>('raw-calendar.json') ?? [];
  const results = maybeLoadJson<unknown[]>('raw-results.json') ?? [];
  const normalizedCalendar = normalizeCalendar(calendar);
  const normalizedResults = normalizeResults(results);
  const yesterdayReview = maybeLoadJson<unknown>('yesterday-review.json');

  const compactNews = compactNewsForPrompt(news);
  const userPrompt = buildUserPrompt({
    date,
    dayName,
    yesterday,
    news: compactNews,
    globalCues: market.global_cues,
    cueRecency: cueRecencySnapshot(market.global_cues),
    fiiDii: market.fii_dii,
    indiaVix: market.india_vix ?? null,
    calendar: normalizedCalendar,
    results: normalizedResults,
    yesterdayReview,
    verifiedResults: verifiedResultsSnapshot(normalizedResults),
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  let lastResponse = '';
  let finalData: ReturnType<typeof AnalysisSchema.parse> | null = null;
  let lastReason = 'unknown error';
  if (apiKey) {
    try {
      lastResponse = await callOpenRouter(apiKey, model, siteUrl, messages);
    } catch (e) {
      lastReason = `Initial LLM call failed: ${(e as Error).message}`;
      console.warn(`  ⚠ ${lastReason}`);
    }
  }

  for (let attempt = 1; attempt <= 2 && lastResponse; attempt++) {
    try {
      const parsed = parseJsonObject(lastResponse);
      if (typeof parsed === 'object' && parsed != null && !Array.isArray(parsed)) {
        normalizeBiasFieldsForAnalysisParse(parsed as Record<string, unknown>);
      }
      normalizeAnalysisImpactDirectionEnums(parsed);
      const validated = AnalysisSchema.safeParse(parsed);
      if (validated.success) {
        finalData = validated.data;
        break;
      }
      lastReason = `Validation error: ${validated.error.message}`;
    } catch (e) {
      lastReason = `JSON parse error: ${(e as Error).message}`;
    }

    if (attempt < 2) {
      const correctionMsg =
        `Your last output failed: ${lastReason}. Return corrected JSON only. ` +
        'Do not use markdown. Use strict JSON with double-quoted keys and valid escaping.';
      try {
        lastResponse = await callOpenRouter(apiKey!, model, siteUrl, [
          ...messages,
          { role: 'user', content: correctionMsg },
        ]);
      } catch (e) {
        lastReason = `Correction LLM call failed: ${(e as Error).message}`;
        break;
      }
    }
  }

  if (!finalData) {
    const debugPath = path.join(process.cwd(), 'tmp', 'analyze-last-response.txt');
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.writeFileSync(debugPath, lastResponse);
    const existingPath = path.join(process.cwd(), 'src', 'data', 'analyses', `${date}.json`);
    if (fs.existsSync(existingPath)) {
      const rawExisting = JSON.parse(fs.readFileSync(existingPath, 'utf-8')) as unknown;
      if (typeof rawExisting === 'object' && rawExisting !== null && !Array.isArray(rawExisting)) {
        normalizeBiasFieldsForAnalysisParse(rawExisting as Record<string, unknown>);
      }
      const existingParsed = AnalysisSchema.safeParse(rawExisting);
      if (existingParsed.success) {
        console.warn(`  ⚠ Model output invalid after retries (${lastReason}). Reusing existing analysis file for ${date}.`);
        finalData = existingParsed.data;
      }
    }
    if (!finalData) {
      console.warn(`  ⚠ Falling back to emergency analysis (${lastReason}).`);
      finalData = buildEmergencyAnalysis({
        date,
        globalCues: market.global_cues,
        fiiDii: market.fii_dii,
        calendar: normalizedCalendar,
        todayResults: normalizedResults,
        yesterdayReview,
        rawMarketRecord: marketRecord,
      });
    }
  }

  // Force calendar visibility when model returns empty list despite non-empty input.
  if (Array.isArray(finalData.economic_calendar) && finalData.economic_calendar.length === 0 && normalizedCalendar.length > 0) {
    finalData.economic_calendar = normalizedCalendar.slice(0, 4);
  }
  finalData.economic_calendar = enrichCalendarWithCountry(finalData.economic_calendar, normalizedCalendar);
  finalData.today_results = normalizedResults;
  applyPipelineIndiaVix(finalData, marketRecord);
  applyDeterministicCueGuardrails(finalData, market.global_cues);

  const stripped = sanitizeMisleadingVerifiedPhrasing(finalData);
  if (stripped > 0) {
    console.warn(`  ⚠ Sanitized misleading "Verified results" phrasing in ${stripped} place(s) — LLM mislabeled narrative as pipeline data.`);
  }

  finalData.bias_horizon = 'open';

  const outPath = path.join(process.cwd(), 'src', 'data', 'analyses', `${date}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(finalData, null, 2));
  console.log(`✓ Analysis saved to ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
