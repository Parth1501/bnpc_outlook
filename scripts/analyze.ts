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
const DEFAULT_SITE_URL = 'https://localhost';
const APP_TITLE = 'Indian Market Outlook';

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

function buildUserPrompt(input: {
  date: string;
  dayName: string;
  yesterday: string;
  news: unknown[];
  globalCues: unknown[];
  flows: unknown;
  calendar: unknown[];
  todayResults: unknown[];
  policyNotes: unknown[];
  yesterdayReview: unknown;
}): string {
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
    policy_notes: '<use input policy_notes unchanged>',
    retail_policy_impact: [
      {
        title: 'string (must be from input policy_notes title)',
        category: 'Taxation|Equity Market|FnO Market|Bond Market|Compliance|Other',
        fy: 'FY YYYY-YY',
        impact_on_retail: 'plain language, max 180 chars',
        what_to_watch: 'one practical watch item, max 140 chars',
        source_url: 'exact url from policy_notes',
      },
    ],
  };

  return `Today is ${input.date} (${input.dayName}).
News window: ${input.yesterday} 15:30 IST onwards.

<news>${JSON.stringify(input.news)}</news>
<global_cues>${JSON.stringify(input.globalCues)}</global_cues>
<flows>${JSON.stringify(input.flows)}</flows>
<calendar>${JSON.stringify(input.calendar)}</calendar>
<today_results>${JSON.stringify(input.todayResults)}</today_results>
<policy_notes>${JSON.stringify(input.policyNotes)}</policy_notes>
<yesterday_review>${JSON.stringify(input.yesterdayReview)}</yesterday_review>

Return JSON only with this shape:
${JSON.stringify(shape, null, 2)}

Rules:
- Cover all 10 sectors in sector_impact even if impact is Low.
- Keep global_cues and fii_dii aligned to provided inputs.
- Be specific and realistic; no fabricated drama when data is light.
- Use "watch"/"in focus", never direct buy/sell advice.
- Use NSE symbols where possible.
- Keep output concise to avoid token overflow:
  - key_drivers: 6 to 10 items only
  - why_it_matters: max 160 chars
  - sector reason: max 140 chars
  - stocks_affected: max 5 per driver
  - stocks_to_watch: max 3 per sector
  - summary: max 320 chars
- Keep today_results identical to provided input. Do not invent result entries.
- Keep policy_notes identical to provided input. Do not invent policy/tax notes.
- retail_policy_impact must be derived ONLY from provided policy_notes.
- Include only items that materially affect retail participants.
- Return 5 to 12 retail_policy_impact items, concise and actionable.`;
}

async function callOpenRouter(apiKey: string, model: string, siteUrl: string, messages: ChatMessage[]): Promise<string> {
  let delayMs = 1200;
  for (let attempt = 1; attempt <= 3; attempt++) {
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
        max_tokens: 8000,
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

    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      console.warn(`  OpenRouter attempt ${attempt} failed with ${res.status}, retrying...`);
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= 2;
      continue;
    }

    const errBody = await res.text();
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
  const policyNotes = maybeLoadJson<unknown[]>('raw-policy-notes.json') ?? [];
  const normalizedCalendar = normalizeCalendar(calendar);
  const normalizedResults = normalizeResults(results);
  const normalizedPolicyNotes = normalizePolicyNotes(policyNotes);
  const policyNotesForPrompt = normalizedPolicyNotes.slice(0, 12).map((n) => ({
    title: n.title,
    authority: n.authority,
    category: n.category,
    fy: n.fy,
    effective_from: n.effective_from,
    source_url: n.source_url,
  }));
  const yesterdayReview = maybeLoadJson<unknown>('yesterday-review.json');

  const systemPrompt =
    'You are a senior Indian equities analyst writing the morning market outlook for retail traders. Output ONLY valid JSON conforming to the user schema. No markdown fences. No commentary.';
  const userPrompt = buildUserPrompt({
    date,
    dayName,
    yesterday,
    news,
    globalCues: market.global_cues,
    flows: market.fii_dii,
    calendar: normalizedCalendar,
    todayResults: normalizedResults,
    policyNotes: policyNotesForPrompt,
    yesterdayReview,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  let lastResponse = await callOpenRouter(apiKey, model, siteUrl, messages);
  let finalData: ReturnType<typeof AnalysisSchema.parse> | null = null;
  let lastReason = 'unknown error';

  for (let attempt = 1; attempt <= 3; attempt++) {
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

    if (attempt < 3) {
      const correctionMsg =
        `Your last output failed: ${lastReason}. Return corrected JSON only. ` +
        'Do not use markdown. Use strict JSON with double-quoted keys and valid escaping.';
      lastResponse = await callOpenRouter(apiKey, model, siteUrl, [
        ...messages,
        { role: 'assistant', content: lastResponse },
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
  finalData.policy_notes = normalizedPolicyNotes;
  const normalizedRetailImpacts = normalizeRetailPolicyImpact(
    (finalData as { retail_policy_impact?: unknown }).retail_policy_impact,
    normalizedPolicyNotes
  );
  finalData.retail_policy_impact =
    normalizedRetailImpacts.length > 0 ? normalizedRetailImpacts : fallbackRetailPolicyImpact(normalizedPolicyNotes);

  const outPath = path.join(process.cwd(), 'src', 'data', 'analyses', `${date}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(finalData, null, 2));
  console.log(`✓ Analysis saved to ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
