/**
 * fetch-results.ts
 * Fetch today's earnings/result declarations from NSE trusted endpoints.
 * Saves to /tmp/raw-results.json
 */

import * as fs from 'fs';
import * as path from 'path';

type Timing = 'During Market' | 'Post Market' | 'Pre Market' | 'TBD';

interface ResultItem {
  symbol: string;
  company: string;
  timing: Timing;
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
}

interface NseEventRow {
  symbol?: string;
  company?: string;
  purpose?: string;
  bm_desc?: string;
  date?: string;
}

interface NseAnnouncementRow {
  symbol?: string;
  desc?: string;
  dt?: string; // ddmmyyyyHHMMSS
  attchmntText?: string;
}

interface FinnhubEarningsRow {
  symbol?: string;
  date?: string;
  epsActual?: number | null;
  epsEstimate?: number | null;
  revenueActual?: number | null;
  revenueEstimate?: number | null;
  hour?: string;
}

interface NewsItem {
  title?: string;
  description?: string;
  pubDate?: string;
  link?: string;
  source?: string;
}

interface NewsMetrics {
  revenue_yoy_pct?: number | null;
  net_profit_actual?: number | null;
  net_profit_yoy_pct?: number | null;
  ebitda_actual?: number | null;
  ebitda_yoy_pct?: number | null;
  result_declared?: boolean;
  result_declared_at_ist?: string;
}

interface OpenRouterChoice {
  message?: { content?: string };
}

interface LlmExtractRow {
  symbol: string;
  revenue_actual?: number | null;
  revenue_yoy_pct?: number | null;
  net_profit_actual?: number | null;
  net_profit_yoy_pct?: number | null;
  ebitda_actual?: number | null;
  ebitda_yoy_pct?: number | null;
  result_declared?: boolean;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash';
const JSON_SAFE_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_SITE_URL = 'https://localhost';

const RSS_FEEDS = [
  { name: 'Economic Times Markets', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
  { name: 'LiveMint Markets', url: 'https://www.livemint.com/rss/markets' },
];

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

function toNseDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function todayIstLabels(): { nseDate: string; isoDate: string } {
  const ist = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  return {
    nseDate: `${dd}-${mm}-${yyyy}`,
    isoDate: `${yyyy}-${mm}-${dd}`,
  };
}

function mergeCookieHeaders(setCookieHeaders: string[]): string {
  return setCookieHeaders
    .map((h) => h.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

function parseAnnouncementDt(dt?: string): { hh: number; mm: number; hhmm: string } | null {
  if (!dt || dt.length < 12) return null;
  const hh = Number(dt.slice(8, 10));
  const mm = Number(dt.slice(10, 12));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return { hh, mm, hhmm: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
}

function classifyTimingFromClock(hh: number, mm: number): Timing {
  const minutes = hh * 60 + mm;
  const marketOpen = 9 * 60 + 15;
  const marketClose = 15 * 60 + 30;
  if (minutes < marketOpen) return 'Pre Market';
  if (minutes <= marketClose) return 'During Market';
  return 'Post Market';
}

function toISTDateTimeLabel(isoLike?: string): string | undefined {
  if (!isoLike) return undefined;
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function extractXmlField(xml: string, tag: string): string {
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = cdataRe.exec(xml) ?? plainRe.exec(xml);
  return m ? m[1].trim() : '';
}

function parseRssItems(xml: string, sourceName: string): NewsItem[] {
  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  return itemMatches.map((m) => {
    const raw = m[1];
    return {
      title: extractXmlField(raw, 'title'),
      description: extractXmlField(raw, 'description').slice(0, 500),
      link: extractXmlField(raw, 'link'),
      pubDate: extractXmlField(raw, 'pubDate'),
      source: sourceName,
    };
  });
}

async function fetchRssFeed(feed: { name: string; url: string }): Promise<NewsItem[]> {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'BNPC-Market-Bot/1.0' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`${feed.name} HTTP ${res.status}`);
  return parseRssItems(await res.text(), feed.name);
}

async function fetchMarketauxResultNews(apiKey: string): Promise<NewsItem[]> {
  const url = new URL('https://api.marketaux.com/v1/news/all');
  url.searchParams.set('api_token', apiKey);
  url.searchParams.set('countries', 'in');
  url.searchParams.set('language', 'en');
  url.searchParams.set('limit', '50');
  url.searchParams.set('sort', 'published_desc');
  url.searchParams.set('search', 'q4 results earnings net profit revenue ebitda');
  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json', 'User-Agent': 'BNPC-Market-Bot/1.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Marketaux HTTP ${res.status}`);
  const json = await res.json() as {
    data?: Array<{ title?: string; description?: string; url?: string; published_at?: string; source?: string }>;
  };
  return (json.data ?? []).map((x) => ({
    title: x.title ?? '',
    description: x.description ?? '',
    link: x.url ?? '',
    pubDate: x.published_at ?? '',
    source: x.source ?? 'Marketaux',
  }));
}

function maybeLoadJson<T>(filename: string): T | null {
  const p = path.join(process.cwd(), 'tmp', filename);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

function parseFirstNumber(input: string): number | null {
  const cleaned = input.replace(/[, ]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeCroreAmount(value: number | null | undefined): number | null {
  if (!isFiniteNumber(value)) return null;
  // If model returns rupee absolute numbers instead of crore, convert.
  if (Math.abs(value) >= 1_000_000) return value / 10_000_000;
  return value;
}

function parseCrAmount(input: string): number | null {
  const m = input.match(/(?:rs|₹)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*crore/i);
  if (!m?.[1]) return null;
  return parseFirstNumber(m[1]);
}

function extractMetricsFromText(text: string): NewsMetrics {
  const t = text.toLowerCase();
  const out: NewsMetrics = {};
  if (/q[1-4]|quarter|results|earnings/.test(t)) out.result_declared = true;

  const netProfitYoy = t.match(/(?:net\s+)?profit[^.]{0,90}?([+-]?\d+(?:\.\d+)?)\s*%\s*(?:yoy|year[- ]on[- ]year|year on year)/i);
  if (netProfitYoy?.[1]) out.net_profit_yoy_pct = parseFirstNumber(netProfitYoy[1]);

  const revenueYoy = t.match(/revenue[^.]{0,90}?([+-]?\d+(?:\.\d+)?)\s*%\s*(?:yoy|year[- ]on[- ]year|year on year|increase|rise|growth|jump)/i);
  if (revenueYoy?.[1]) out.revenue_yoy_pct = parseFirstNumber(revenueYoy[1]);

  const ebitdaYoy = t.match(/ebitda[^.]{0,90}?([+-]?\d+(?:\.\d+)?)\s*%\s*(?:yoy|year[- ]on[- ]year|year on year)/i);
  if (ebitdaYoy?.[1]) out.ebitda_yoy_pct = parseFirstNumber(ebitdaYoy[1]);

  const netProfitCr = t.match(/(?:net\s+)?profit[^.]{0,120}?(?:to|at)\s*(?:rs|₹)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*crore/i);
  if (netProfitCr?.[1]) out.net_profit_actual = parseFirstNumber(netProfitCr[1]);

  const ebitdaCr = t.match(/ebitda[^.]{0,120}?(?:to|at)\s*(?:rs|₹)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*crore/i);
  if (ebitdaCr?.[1]) out.ebitda_actual = parseFirstNumber(ebitdaCr[1]);

  const fallbackNetProfit = out.net_profit_actual == null ? parseCrAmount(t) : null;
  if (out.net_profit_actual == null && fallbackNetProfit != null && /net profit|profit/.test(t)) {
    out.net_profit_actual = fallbackNetProfit;
  }

  return out;
}

function isDeclaredResultHeadline(news: NewsItem): boolean {
  const text = `${news.title ?? ''} ${news.description ?? ''}`.toLowerCase();
  return /(q[1-4].{0,20}results|results|earnings|net profit|revenue|ebitda)/.test(text);
}

/**
 * First-word-only company match is unsafe: e.g. "Hindustan Construction" (HCC) shares
 * first token "HINDUSTAN" with "Hindustan Aeronautics" (HAL) headlines — would duplicate HAL metrics onto HCC.
 * For ambiguous first tokens, require the first TWO words of the company name to appear in the text.
 */
const AMBIGUOUS_COMPANY_FIRST_WORD = new Set([
  'HINDUSTAN', 'INDIAN', 'STATE', 'GLOBAL', 'NATIONAL', 'UNION', 'CENTRAL',
  'BANK', 'THE', 'UNITED', 'STANDARD', 'ROYAL', 'INTERNATIONAL',
]);

function companyNameAppearsInHeadline(company: string, textUpper: string): boolean {
  const parts = company.toUpperCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  const w0 = parts[0];
  if (AMBIGUOUS_COMPANY_FIRST_WORD.has(w0)) {
    if (parts.length >= 2) {
      return textUpper.includes(`${w0} ${parts[1]}`);
    }
    return false;
  }
  return textUpper.includes(w0);
}

function buildNewsMetricsBySymbol(news: NewsItem[] | null): Map<string, NewsMetrics> {
  const map = new Map<string, NewsMetrics>();
  if (!Array.isArray(news)) return map;
  for (const item of news) {
    if (!isDeclaredResultHeadline(item)) continue;
    const text = `${item.title ?? ''} ${item.description ?? ''}`;
    const upper = text.toUpperCase();
    const symbols = new Set<string>();
    if (upper.includes('MRF')) symbols.add('MRF');
    if (upper.includes('BHARAT FORGE') || upper.includes('BHARATFORG')) symbols.add('BHARATFORG');
    if (upper.includes('CARTRADE')) symbols.add('CARTRADE');
    if (upper.includes('BAJAJ AUTO')) symbols.add('BAJAJ-AUTO');
    for (const symbol of symbols) {
      const prev = map.get(symbol) ?? {};
      const parsed = extractMetricsFromText(text);
      const merged: NewsMetrics = {
        revenue_yoy_pct: parsed.revenue_yoy_pct ?? prev.revenue_yoy_pct ?? null,
        net_profit_actual: parsed.net_profit_actual ?? prev.net_profit_actual ?? null,
        net_profit_yoy_pct: parsed.net_profit_yoy_pct ?? prev.net_profit_yoy_pct ?? null,
        ebitda_actual: parsed.ebitda_actual ?? prev.ebitda_actual ?? null,
        ebitda_yoy_pct: parsed.ebitda_yoy_pct ?? prev.ebitda_yoy_pct ?? null,
        result_declared: parsed.result_declared || prev.result_declared || false,
        result_declared_at_ist: prev.result_declared_at_ist ?? toISTDateTimeLabel(item.pubDate),
      };
      map.set(symbol, merged);
    }
  }
  return map;
}

function buildNewsMetricsBySymbolStrict(news: NewsItem[], symbols: string[], companyBySymbol: Map<string, string>): Map<string, NewsMetrics> {
  const out = new Map<string, NewsMetrics>();
  for (const item of news) {
    if (!isDeclaredResultHeadline(item)) continue;
    const text = `${item.title ?? ''} ${item.description ?? ''}`.toUpperCase();
    for (const symbol of symbols) {
      const company = (companyBySymbol.get(symbol) ?? '').toUpperCase();
      if (!text.includes(symbol) && !companyNameAppearsInHeadline(company, text)) continue;
      const parsed = extractMetricsFromText(`${item.title ?? ''} ${item.description ?? ''}`);
      const prev = out.get(symbol) ?? {};
      out.set(symbol, {
        revenue_yoy_pct: parsed.revenue_yoy_pct ?? prev.revenue_yoy_pct ?? null,
        net_profit_actual: parsed.net_profit_actual ?? prev.net_profit_actual ?? null,
        net_profit_yoy_pct: parsed.net_profit_yoy_pct ?? prev.net_profit_yoy_pct ?? null,
        ebitda_actual: parsed.ebitda_actual ?? prev.ebitda_actual ?? null,
        ebitda_yoy_pct: parsed.ebitda_yoy_pct ?? prev.ebitda_yoy_pct ?? null,
        result_declared: parsed.result_declared || prev.result_declared || false,
        result_declared_at_ist: prev.result_declared_at_ist ?? toISTDateTimeLabel(item.pubDate),
      });
    }
  }
  return out;
}

function parseJsonObject(text: string): unknown {
  return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
}

async function callOpenRouter(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  allowFallback = true,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  const model = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  const siteUrl = process.env.SITE_URL?.trim() || DEFAULT_SITE_URL;
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': siteUrl,
      'X-Title': 'BNPC Result Extractor',
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 2500,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text();
    if (
      allowFallback &&
      model !== JSON_SAFE_MODEL &&
      /json mode is not supported|code.?20024/i.test(body)
    ) {
      process.env.OPENROUTER_MODEL = JSON_SAFE_MODEL;
      return callOpenRouter(messages, false);
    }
    throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json() as { choices?: OpenRouterChoice[] };
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

async function extractResultMetricsWithLlm(
  symbols: string[],
  companyBySymbol: Map<string, string>,
  news: NewsItem[],
): Promise<Map<string, NewsMetrics>> {
  if (!process.env.OPENROUTER_API_KEY?.trim()) return new Map();
  const briefNews = news.slice(0, 80).map((n) => ({
    title: n.title ?? '',
    description: (n.description ?? '').slice(0, 280),
    pubDate: n.pubDate ?? '',
    source: n.source ?? '',
  }));
  const symbolRows = symbols.map((s) => ({ symbol: s, company: companyBySymbol.get(s) ?? s }));
  const userPrompt = `Extract only declared quarterly result metrics from news.
Return strict JSON: {"items":[{"symbol":"NSE_SYMBOL","revenue_actual":number|null,"revenue_yoy_pct":number|null,"net_profit_actual":number|null,"net_profit_yoy_pct":number|null,"ebitda_actual":number|null,"ebitda_yoy_pct":number|null,"result_declared":boolean}]}
Rules:
- Use only these symbols: ${JSON.stringify(symbolRows)}
- Use only this news dataset: ${JSON.stringify(briefNews)}
- If unsure, return nulls and result_declared false.
- Keep only rows where result_declared true OR at least one metric is non-null.`;
  const content = await callOpenRouter([
    { role: 'system', content: 'You extract structured financial result numbers from news. Return JSON only.' },
    { role: 'user', content: userPrompt },
  ]);
  const parsed = parseJsonObject(content) as { items?: LlmExtractRow[] };
  const out = new Map<string, NewsMetrics>();
  for (const row of parsed.items ?? []) {
    const symbol = String(row.symbol ?? '').trim().toUpperCase();
    if (!symbols.includes(symbol)) continue;
    out.set(symbol, {
      revenue_yoy_pct: isFiniteNumber(row.revenue_yoy_pct) ? row.revenue_yoy_pct : null,
      net_profit_actual: normalizeCroreAmount(isFiniteNumber(row.net_profit_actual) ? row.net_profit_actual : null),
      net_profit_yoy_pct: isFiniteNumber(row.net_profit_yoy_pct) ? row.net_profit_yoy_pct : null,
      ebitda_actual: normalizeCroreAmount(isFiniteNumber(row.ebitda_actual) ? row.ebitda_actual : null),
      ebitda_yoy_pct: isFiniteNumber(row.ebitda_yoy_pct) ? row.ebitda_yoy_pct : null,
      result_declared: Boolean(row.result_declared),
    });
  }
  return out;
}

async function fetchFinnhubEarnings(key: string, date: string): Promise<Map<string, FinnhubEarningsRow>> {
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${date}&to=${date}&token=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  const json = await res.json() as { earningsCalendar?: FinnhubEarningsRow[] };
  const rows = Array.isArray(json.earningsCalendar) ? json.earningsCalendar : [];
  const map = new Map<string, FinnhubEarningsRow>();
  for (const row of rows) {
    const symbol = String(row.symbol ?? '').trim().toUpperCase();
    if (!symbol) continue;
    map.set(symbol, row);
  }
  return map;
}

function containsResultsKeyword(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes('financial result') ||
    t.includes('quarterly result') ||
    t.includes('audited result') ||
    t.includes('unaudited result') ||
    t.includes('results')
  );
}

async function warmNseCookies(): Promise<string> {
  const res = await fetch('https://www.nseindia.com/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    },
    signal: AbortSignal.timeout(15_000),
  });

  const rawSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  if (rawSetCookie.length > 0) return mergeCookieHeaders(rawSetCookie);
  const single = res.headers.get('set-cookie');
  return single ? mergeCookieHeaders([single]) : '';
}

async function fetchNseJson<T>(url: string, cookie: string): Promise<T> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www.nseindia.com/',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`NSE HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function dedupeAndSort(results: ResultItem[]): ResultItem[] {
  const rank: Record<Timing, number> = {
    'During Market': 0,
    'Post Market': 1,
    'Pre Market': 2,
    'TBD': 3,
  };

  const map = new Map<string, ResultItem>();
  for (const item of results) {
    const key = item.symbol.trim().toUpperCase();
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...item, symbol: key });
      continue;
    }
    if (rank[item.timing] < rank[prev.timing]) map.set(key, { ...item, symbol: key });
  }

  return [...map.values()].sort((a, b) => {
    const r = rank[a.timing] - rank[b.timing];
    if (r !== 0) return r;
    return a.symbol.localeCompare(b.symbol);
  });
}

async function main() {
  loadEnvFromFile();
  console.log('📌 Fetching trusted result schedule (NSE)...');

  const { nseDate, isoDate } = todayIstLabels();
  const cookie = await warmNseCookies();
  const finnhubKey = process.env.FINNHUB_API_KEY?.trim();

  const eventsUrl = `https://www.nseindia.com/api/event-calendar?from_date=${nseDate}&to_date=${nseDate}`;
  const annsUrl = `https://www.nseindia.com/api/corporate-announcements?index=equities&from_date=${nseDate}&to_date=${nseDate}`;

  const events = await fetchNseJson<NseEventRow[]>(eventsUrl, cookie);
  const announcements = await fetchNseJson<NseAnnouncementRow[]>(annsUrl, cookie);

  const resultEvents = events.filter((r) =>
    containsResultsKeyword(`${r.purpose ?? ''} ${r.bm_desc ?? ''}`)
  );
  const symbols = resultEvents.map((r) => String(r.symbol ?? '').trim().toUpperCase()).filter(Boolean);
  const companyBySymbol = new Map(
    resultEvents.map((r) => [String(r.symbol ?? '').trim().toUpperCase(), String(r.company ?? '').trim()])
  );

  const liveNews: NewsItem[] = [];
  for (const feed of RSS_FEEDS) {
    try {
      liveNews.push(...await fetchRssFeed(feed));
    } catch (e) {
      console.warn(`  ${feed.name} fetch failed: ${(e as Error).message}`);
    }
  }
  if (process.env.MARKETAUX_KEY?.trim()) {
    try {
      liveNews.push(...await fetchMarketauxResultNews(process.env.MARKETAUX_KEY.trim()));
    } catch (e) {
      console.warn(`  Marketaux fetch failed: ${(e as Error).message}`);
    }
  }
  const fallbackNews = maybeLoadJson<NewsItem[]>('raw-news.json') ?? [];
  const mergedNews = [...liveNews, ...fallbackNews];
  const regexNewsMetrics = buildNewsMetricsBySymbolStrict(mergedNews, symbols, companyBySymbol);
  const keywordNewsMetrics = buildNewsMetricsBySymbol(mergedNews);
  let llmNewsMetrics = new Map<string, NewsMetrics>();
  try {
    llmNewsMetrics = await extractResultMetricsWithLlm(symbols, companyBySymbol, mergedNews);
  } catch (e) {
    console.warn(`  LLM extraction failed: ${(e as Error).message}`);
  }

  let finnhubBySymbol = new Map<string, FinnhubEarningsRow>();
  if (finnhubKey) {
    try {
      finnhubBySymbol = await fetchFinnhubEarnings(finnhubKey, isoDate);
    } catch (e) {
      console.warn(`  Finnhub earnings fetch failed: ${(e as Error).message}`);
    }
  }

  const annBySymbol = new Map<string, NseAnnouncementRow[]>();
  for (const a of announcements) {
    const symbol = String(a.symbol ?? '').trim().toUpperCase();
    if (!symbol) continue;
    if (!containsResultsKeyword(`${a.desc ?? ''} ${a.attchmntText ?? ''}`)) continue;
    const arr = annBySymbol.get(symbol) ?? [];
    arr.push(a);
    annBySymbol.set(symbol, arr);
  }

  const out: ResultItem[] = resultEvents.map((row) => {
    const symbol = String(row.symbol ?? '').trim().toUpperCase();
    const company = String(row.company ?? symbol).trim();
    const purpose = String(row.purpose ?? '').trim();
    const bm = String(row.bm_desc ?? '').trim();
    const ann = (annBySymbol.get(symbol) ?? [])
      .sort((a, b) => String(b.dt ?? '').localeCompare(String(a.dt ?? '')))[0];

    const parsed = parseAnnouncementDt(ann?.dt);
    const timing: Timing = parsed ? classifyTimingFromClock(parsed.hh, parsed.mm) : 'TBD';
    const finnhub = finnhubBySymbol.get(symbol);
    const estimateEps = isFiniteNumber(finnhub?.epsEstimate) ? finnhub.epsEstimate : null;
    const actualEps = isFiniteNumber(finnhub?.epsActual) ? finnhub.epsActual : null;
    const estimateRevenue = isFiniteNumber(finnhub?.revenueEstimate) ? finnhub.revenueEstimate : null;
    const actualRevenue = isFiniteNumber(finnhub?.revenueActual) ? finnhub.revenueActual : null;
    const fromNews = llmNewsMetrics.get(symbol) ?? regexNewsMetrics.get(symbol) ?? keywordNewsMetrics.get(symbol);
    const newsHasFigures =
      fromNews != null &&
      (fromNews.net_profit_actual != null ||
        fromNews.net_profit_yoy_pct != null ||
        fromNews.revenue_yoy_pct != null ||
        fromNews.ebitda_actual != null ||
        fromNews.ebitda_yoy_pct != null);
    const hasAnyActual = actualEps !== null || actualRevenue !== null || newsHasFigures;

    return {
      symbol,
      company,
      timing,
      expected_time_ist: parsed ? parsed.hhmm : undefined,
      note: purpose || bm || 'Financial results related board update',
      metric_unit: 'crore',
      estimate_eps: estimateEps,
      actual_eps: actualEps,
      estimate_revenue: estimateRevenue,
      actual_revenue: actualRevenue,
      revenue_yoy_pct: fromNews?.revenue_yoy_pct ?? null,
      net_profit_actual: fromNews?.net_profit_actual ?? null,
      net_profit_yoy_pct: fromNews?.net_profit_yoy_pct ?? null,
      ebitda_actual: fromNews?.ebitda_actual ?? null,
      ebitda_yoy_pct: fromNews?.ebitda_yoy_pct ?? null,
      currency: 'INR',
      result_declared: hasAnyActual,
      result_declared_at_ist: toISTDateTimeLabel(finnhub?.date) ?? fromNews?.result_declared_at_ist,
    };
  });

  const finalResults = dedupeAndSort(out).slice(0, 60);

  const outPath = path.join(process.cwd(), 'tmp', 'raw-results.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(finalResults, null, 2));

  // Write a flat symbol→metrics map to public/ so the browser can fetch it
  // directly as /result-metrics.json without any CORS proxy.
  const metricsMap: Record<string, {
    net_profit_actual: number | null;
    net_profit_yoy_pct: number | null;
    revenue_yoy_pct: number | null;
    ebitda_actual: number | null;
    ebitda_yoy_pct: number | null;
    result_declared: boolean;
    result_declared_at_ist: string | null;
    fetched_at_ist: string;
  }> = {};
  const fetchedAt = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
    day: '2-digit', month: 'short',
  });
  for (const r of finalResults) {
    metricsMap[r.symbol] = {
      net_profit_actual:  r.net_profit_actual  ?? null,
      net_profit_yoy_pct: r.net_profit_yoy_pct ?? null,
      revenue_yoy_pct:    r.revenue_yoy_pct    ?? null,
      ebitda_actual:      r.ebitda_actual       ?? null,
      ebitda_yoy_pct:     r.ebitda_yoy_pct      ?? null,
      result_declared:    r.result_declared     ?? false,
      result_declared_at_ist: r.result_declared_at_ist ?? null,
      fetched_at_ist: fetchedAt,
    };
  }
  const publicPath = path.join(process.cwd(), 'public', 'result-metrics.json');
  fs.mkdirSync(path.dirname(publicPath), { recursive: true });
  fs.writeFileSync(publicPath, JSON.stringify(metricsMap, null, 2));

  console.log(`  NSE event calendar rows: ${events.length}`);
  console.log(`  Results candidates: ${resultEvents.length}`);
  console.log(`  Live result news rows: ${mergedNews.length}`);
  console.log(`  Regex-extracted symbols: ${regexNewsMetrics.size}`);
  console.log(`  LLM-extracted symbols: ${llmNewsMetrics.size}`);
  console.log(`  Finnhub earnings rows: ${finnhubBySymbol.size}`);
  console.log(`✓ Saved to ${outPath} (${finalResults.length} records)`);
  console.log(`✓ Public metrics map saved to ${publicPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

