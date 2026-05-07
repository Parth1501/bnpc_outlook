/**
 * analyze.ts
 * Reads raw data, calls OpenRouter, validates via Zod schema,
 * and saves src/data/analyses/YYYY-MM-DD.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { AnalysisSchema } from '../src/lib/types';

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
type PolicyNote = {
  title: string;
  authority: string;
  category: 'Taxation' | 'Equity Market' | 'FnO Market' | 'Bond Market' | 'Compliance' | 'Other';
  fy: string;
  effective_from?: string;
  source_url: string;
  note: string;
};
type RetailPolicyImpact = {
  title: string;
  category: 'Taxation' | 'Equity Market' | 'FnO Market' | 'Bond Market' | 'Compliance' | 'Other';
  fy: string;
  impact_on_retail: string;
  what_to_watch: string;
  source_url: string;
};

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';
const JSON_SAFE_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_SITE_URL = 'https://localhost';
const APP_TITLE = 'Indian Market Outlook';
const DEFAULT_ANALYZE_MAX_TOKENS = 32000;
const SYSTEM_PROMPT =
  'You are a senior Indian equities analyst. Return ONLY valid JSON (no markdown). Be concise and data-grounded: never invent earnings, EPS, or YoY percentages. Use NSE symbols, explain mechanisms, avoid buy/sell advice, keep passthrough fields unchanged from input.';

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
  fiiDii: unknown;
  calendar: unknown[];
  results: unknown[];
  yesterdayReview: unknown;
  verifiedResults: unknown;
};

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
      'Quantitative earnings (EPS, PAT, YoY %, revenue) may appear ONLY for symbols in declared_with_metrics. For pending_scheduled, say results awaited/scheduled only — no outcomes. You may paraphrase <news> headlines without adding numbers not in the headline text.',
    declared_with_metrics: declared,
    pending_scheduled: pending,
  };
}

function buildUserPrompt(input: AnalysisInput): string {
  const shape = {
    date: input.date,
    overall_bias: 'Bullish|Bearish|Neutral',
    confidence: '0..100',
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
<fii_dii>${JSON.stringify(input.fiiDii)}</fii_dii>
<economic_calendar>${JSON.stringify(input.calendar)}</economic_calendar>
<today_results>${JSON.stringify(input.results)}</today_results>
<verified_results>${JSON.stringify(input.verifiedResults)}</verified_results>
<yesterday_review>${JSON.stringify(input.yesterdayReview ?? 'no prior data')}</yesterday_review>

Rules:
- Return valid JSON only, matching schema exactly.
- Keep global_cues, fii_dii, economic_calendar, today_results unchanged from input.
- HARD GROUNDING: For Nifty/Sensex/Dow/Nasdaq/Brent/Gold/USD-INR/US 10Y/Nikkei etc., quote percentages and levels ONLY from <global_cues> (match by name). Do not substitute other figures from memory or news.
- HARD GROUNDING: For company results (EPS, PAT, YoY revenue/profit margin commentary), you MAY use explicit numbers ONLY if:
  (a) the numeric field appears for that symbol inside verified_results.declared_with_metrics, OR
  (b) the SAME number appears verbatim in <news> title/description — quote as "reported headline" briefly, do not recalculate.
- If a stock is only in verified_results.pending_scheduled (or not declared in today_results), you MUST NOT claim actual results or YoY/PAT outcomes. Say only "scheduled/awaited" etc.
- If declared_with_metrics is empty, do not put company-specific quantitative earnings (no "+X% PAT YoY" etc.) in headline_call, summary, or key_drivers; use themes, flows, and global cues only.
- Cover all 10 sectors in sector_impact (use Low if no catalyst).
- No buy/sell/target/stop-loss advice.
- Confidence range 35-85.

Output schema:
${JSON.stringify(shape)}
`;
}

function compactNewsForPrompt(raw: unknown[], limit = 20): Array<Record<string, string>> {
  return raw
    .slice(0, limit)
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

function normalizePolicyCategory(value: unknown): PolicyNote['category'] {
  const v = String(value ?? '').trim();
  if (
    v === 'Taxation' ||
    v === 'Equity Market' ||
    v === 'FnO Market' ||
    v === 'Bond Market' ||
    v === 'Compliance' ||
    v === 'Other'
  ) return v;
  return 'Other';
}

function normalizePolicyNotes(raw: unknown): PolicyNote[] {
  if (!Array.isArray(raw)) return [];
  const out: PolicyNote[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const r = x as Record<string, unknown>;
    const title = String(r.title ?? '').trim();
    const sourceUrl = String(r.source_url ?? '').trim();
    if (!title || !sourceUrl) continue;
    const key = `${title.toLowerCase().slice(0, 120)}|${sourceUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      authority: String(r.authority ?? 'Official'),
      category: normalizePolicyCategory(r.category),
      fy: String(r.fy ?? 'FY Unknown'),
      effective_from: r.effective_from == null ? undefined : String(r.effective_from),
      source_url: sourceUrl,
      note: String(r.note ?? '').trim().slice(0, 300),
    });
  }
  return out;
}

function normalizeRetailPolicyImpact(raw: unknown, notes: PolicyNote[]): RetailPolicyImpact[] {
  if (!Array.isArray(raw)) return [];
  const noteByUrl = new Map(notes.map((n) => [n.source_url, n]));
  const out: RetailPolicyImpact[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const r = x as Record<string, unknown>;
    const sourceUrl = String(r.source_url ?? '').trim();
    const title = String(r.title ?? '').trim();
    if (!sourceUrl || !title) continue;
    const noteRef = noteByUrl.get(sourceUrl);
    if (!noteRef) continue;
    const key = `${sourceUrl}|${title.toLowerCase().slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      category: normalizePolicyCategory(r.category),
      fy: String(r.fy ?? noteRef.fy ?? 'FY Unknown'),
      impact_on_retail: String(r.impact_on_retail ?? '').trim().slice(0, 220),
      what_to_watch: String(r.what_to_watch ?? '').trim().slice(0, 160),
      source_url: sourceUrl,
    });
  }
  return out;
}

function fallbackRetailPolicyImpact(notes: PolicyNote[]): RetailPolicyImpact[] {
  return notes
    .filter((n) => n.category !== 'Other')
    .slice(0, 10)
    .map((n) => ({
      title: n.title,
      category: n.category,
      fy: n.fy,
      impact_on_retail:
        n.category === 'Taxation'
          ? 'Potential tax treatment impact for retail gains/loss planning; verify applicability before trades.'
          : n.category === 'FnO Market'
            ? 'May affect derivative participation via margin/risk/compliance changes for retail traders.'
            : n.category === 'Bond Market'
              ? 'Can influence debt yields and fund positioning, indirectly affecting allocation decisions.'
              : n.category === 'Equity Market'
                ? 'May alter trading/disclosure/listing rules relevant to retail stock participation.'
                : 'Could change compliance or process requirements that impact retail execution.',
      what_to_watch: 'Read official circular summary and effective date before taking position changes.',
      source_url: n.source_url,
    }));
}

function buildEmergencyAnalysis(input: {
  date: string;
  globalCues: unknown[];
  fiiDii: unknown;
  calendar: CalendarEvent[];
  todayResults: StockResult[];
  yesterdayReview: unknown;
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
    confidence: 45,
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
    policy_notes: [],
    retail_policy_impact: [],
    accuracy_review: input.yesterdayReview ?? undefined,
  };
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
  const market = loadJson<{ global_cues: unknown[]; fii_dii: unknown }>('raw-market.json');
  const calendar = maybeLoadJson<unknown[]>('raw-calendar.json') ?? [];
  const results = maybeLoadJson<unknown[]>('raw-results.json') ?? [];
  const normalizedCalendar = normalizeCalendar(calendar);
  const normalizedResults = normalizeResults(results);
  const yesterdayReview = maybeLoadJson<unknown>('yesterday-review.json');

  const compactNews = compactNewsForPrompt(news, 20);
  const userPrompt = buildUserPrompt({
    date,
    dayName,
    yesterday,
    news: compactNews,
    globalCues: market.global_cues,
    fiiDii: market.fii_dii,
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
      const existingParsed = AnalysisSchema.safeParse(JSON.parse(fs.readFileSync(existingPath, 'utf-8')));
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
      });
    }
  }

  // Force calendar visibility when model returns empty list despite non-empty input.
  if (Array.isArray(finalData.economic_calendar) && finalData.economic_calendar.length === 0 && normalizedCalendar.length > 0) {
    finalData.economic_calendar = normalizedCalendar.slice(0, 4);
  }
  finalData.economic_calendar = enrichCalendarWithCountry(finalData.economic_calendar, normalizedCalendar);
  finalData.today_results = normalizedResults;
  finalData.policy_notes = [];
  finalData.retail_policy_impact = [];

  const outPath = path.join(process.cwd(), 'src', 'data', 'analyses', `${date}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(finalData, null, 2));
  console.log(`✓ Analysis saved to ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
