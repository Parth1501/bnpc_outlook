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
const SYSTEM_PROMPT =
  'You are a senior Indian equities analyst. Return ONLY valid JSON (no markdown). Be concise, data-driven, use NSE symbols, explain mechanisms, avoid buy/sell advice, and keep passthrough fields unchanged.';

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
};

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

  return `Date: ${input.date} (${input.dayName}), pre-open IST.
Window: ${input.yesterday} 15:30 IST onwards.

Use these inputs:
<news>${JSON.stringify(input.news)}</news>
<global_cues>${JSON.stringify(input.globalCues)}</global_cues>
<fii_dii>${JSON.stringify(input.fiiDii)}</fii_dii>
<economic_calendar>${JSON.stringify(input.calendar)}</economic_calendar>
<today_results>${JSON.stringify(input.results)}</today_results>
<yesterday_review>${JSON.stringify(input.yesterdayReview ?? 'no prior data')}</yesterday_review>

Rules:
- Return valid JSON only, matching schema exactly.
- Keep global_cues, fii_dii, economic_calendar, today_results unchanged from input.
- Cover all 10 sectors in sector_impact (use Low if no catalyst).
- Use concise mechanism-based reasoning with specific facts.
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
        max_tokens: 2500,
      }),
      signal: AbortSignal.timeout(90_000),
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

async function main() {
  loadEnvFromFile();

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
  const siteUrl = process.env.SITE_URL?.trim() || DEFAULT_SITE_URL;

  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

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
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  let lastResponse = await callOpenRouter(apiKey, model, siteUrl, messages);
  let finalData: ReturnType<typeof AnalysisSchema.parse> | null = null;
  let lastReason = 'unknown error';

  for (let attempt = 1; attempt <= 2; attempt++) {
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
      lastResponse = await callOpenRouter(apiKey, model, siteUrl, [
        ...messages,
        { role: 'user', content: correctionMsg },
      ]);
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
      throw new Error(`Final output invalid after retries: ${lastReason}. Raw response saved to ${debugPath}`);
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
