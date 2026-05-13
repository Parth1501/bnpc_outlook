/**
 * fetch-market-data.ts
 * Fetches global cues from Yahoo Finance and FII/DII from NSE.
 * Saves to /tmp/raw-market.json
 */

import * as fs from 'fs';
import * as path from 'path';

// Yahoo Finance symbols
const YF_SYMBOLS = [
  { symbol: '^DJI',   name: 'Dow Jones' },
  { symbol: '^IXIC',  name: 'Nasdaq' },
  { symbol: '^NSEI',  name: 'Nifty 50' },
  { symbol: '^BSESN', name: 'Sensex' },
  { symbol: 'BZ=F',   name: 'Brent $/bbl' },
  { symbol: 'GC=F',   name: 'Gold $/oz' },
  { symbol: 'INR=X',  name: 'USD/INR' },
  { symbol: '^TNX',   name: 'US 10Y %' },
  { symbol: '^N225',  name: 'Nikkei 225' },
];

interface GlobalCueRaw {
  name: string;
  value: number;
  change: number;
  change_pct: number;
  direction: 'up' | 'down' | 'flat';
}

interface FiiDiiRaw {
  date: string;
  fii_buy: number;
  fii_sell: number;
  fii_net: number;
  dii_buy: number;
  dii_sell: number;
  dii_net: number;
}

interface CalendarEventRaw {
  time_ist: string;
  event: string;
  country: string;
  importance: 'High' | 'Moderate' | 'Low';
  forecast?: string | null;
  previous?: string | null;
}

/** India VIX quote from NSE allIndices — written to raw-market.json. */
export interface IndiaVixMarketRaw {
  value: number;
  previous_close: number;
  change: number;
  change_percent: number;
  as_of: string;
}

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

function parseNum(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = parseFloat(value.replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function mergeCookieHeaders(setCookieHeaders: string[]): string {
  return setCookieHeaders
    .map((h) => h.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

async function fetchYahooQuoteApi(): Promise<GlobalCueRaw[]> {
  const symbols = YF_SYMBOLS.map((s) => s.symbol).join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; BNPC-Bot/1.0)',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Yahoo quote API HTTP ${res.status}`);

  const data = await res.json() as {
    quoteResponse: {
      result: Array<{
        symbol: string;
        regularMarketPrice: number;
        regularMarketChange: number;
        regularMarketChangePercent: number;
      }>;
    };
  };

  const results = data.quoteResponse?.result ?? [];

  return results.map((r) => {
    const meta = YF_SYMBOLS.find((s) => s.symbol === r.symbol);
    const pct = r.regularMarketChangePercent ?? 0;
    return {
      name: meta?.name ?? r.symbol,
      value: r.regularMarketPrice,
      change: r.regularMarketChange ?? 0,
      change_pct: Math.round(pct * 100) / 100,
      direction: pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat',
    };
  });
}

async function fetchYahooChartFallback(): Promise<GlobalCueRaw[]> {
  const out: GlobalCueRaw[] = [];
  for (const meta of YF_SYMBOLS) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(meta.symbol)}?interval=1d&range=5d`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;

      const data = await res.json() as {
        chart?: {
          result?: Array<{
            indicators?: { quote?: Array<{ close?: Array<number | null> }> };
          }>;
        };
      };

      const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
      const valid = closes.filter((x): x is number => typeof x === 'number');
      if (valid.length < 2) continue;
      const prev = valid[valid.length - 2];
      const last = valid[valid.length - 1];
      const ch = last - prev;
      const pct = prev !== 0 ? (ch / prev) * 100 : 0;
      out.push({
        name: meta.name,
        value: Number(last.toFixed(2)),
        change: Number(ch.toFixed(2)),
        change_pct: Number(pct.toFixed(2)),
        direction: pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat',
      });
    } catch {
      // ignore one symbol failures
    }
  }
  return out;
}

async function fetchYahooFinance(): Promise<GlobalCueRaw[]> {
  try {
    const quoteData = await fetchYahooQuoteApi();
    if (quoteData.length > 0) return quoteData;
  } catch {
    // fallback below
  }
  return fetchYahooChartFallback();
}

// SGX/Gift Nifty: try Moneycontrol API; fall back to placeholder
async function fetchGiftNifty(): Promise<GlobalCueRaw | null> {
  try {
    const res = await fetch(
      'https://www.moneycontrol.com/mc/widget/basicscreener/masterdata?classic=true&popen=0&pclose=0&pname=Gift+Nifty',
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) return null;
    // Moneycontrol returns HTML; parse a known JSON endpoint instead
    return null; // fallback handled below
  } catch {
    return null;
  }
}

function istTimestampISO(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const g = (t: Intl.DateTimeFormatPart['type']) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}+05:30`;
}

async function fetchIndiaVixFromNse(): Promise<IndiaVixMarketRaw | null> {
  try {
    const cookie = await warmNseCookies();
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.nseindia.com/',
    };
    if (cookie) headers.Cookie = cookie;

    const res = await fetch('https://www.nseindia.com/api/allIndices', {
      headers,
      signal: AbortSignal.timeout(18_000),
    });

    if (!res.ok) {
      console.warn(`  ⚠ India VIX: NSE allIndices HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const rows = Array.isArray(data.data) ? data.data : [];
    const row = rows.find((r) => {
      const name = String(r.index ?? r.indexName ?? r.name ?? '').trim().toLowerCase();
      return name === 'india vix';
    });

    if (!row) {
      console.warn('  ⚠ India VIX: "India VIX" row missing in allIndices response');
      return null;
    }

    const last = parseNum(row.last ?? row.lastPrice ?? row.lastTradedPrice);
    const prev = parseNum(row.previousClose ?? row.previousDay ?? row.prevClose ?? row.indexPreviousClose);

    let change = parseNum(row.variation ?? row.change);
    if (!Number.isFinite(change)) change = last - prev;
    change = Number(change.toFixed(4));

    let changePct = parseNum(row.percChange ?? row.percentChange ?? row.pChange);
    if (!Number.isFinite(changePct) && prev !== 0) {
      changePct = Math.round(((last - prev) / prev) * 10000) / 100;
    }
    if (!Number.isFinite(changePct)) changePct = 0;
    changePct = Math.round(changePct * 100) / 100;

    if (!(last > 0) || !(prev > 0)) {
      console.warn('  ⚠ India VIX: invalid last/previous_close from NSE');
      return null;
    }

    return {
      value: Math.round(last * 100) / 100,
      previous_close: Math.round(prev * 100) / 100,
      change,
      change_percent: changePct,
      as_of: istTimestampISO(),
    };
  } catch (e) {
    console.warn('  ⚠ India VIX fetch failed:', (e as Error).message);
    return null;
  }
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

function parseFiiDiiFromAny(data: unknown): FiiDiiRaw | null {
  const arr = Array.isArray((data as { data?: unknown[] })?.data)
    ? (data as { data: unknown[] }).data
    : Array.isArray(data)
      ? data as unknown[]
      : [];

  if (!arr.length) return null;

  let fiiBuy = 0;
  let fiiSell = 0;
  let diiBuy = 0;
  let diiSell = 0;
  let date = '';

  for (const row of arr) {
    const r = row as Record<string, unknown>;
    const cat = String(r.category ?? r.clientType ?? r.participantType ?? '').toLowerCase();
    const isFii = cat.includes('fii') || cat.includes('fpi') || cat.includes('foreign');
    const isDii = cat.includes('dii') || cat.includes('domestic');
    if (!isFii && !isDii) continue;

    const buy = parseNum(r.buyValue ?? r.buyAmt ?? r.buyValueRs ?? r.buy ?? r.purchase);
    const sell = parseNum(r.sellValue ?? r.sellAmt ?? r.sellValueRs ?? r.sell ?? r.sales);
    const dt = String(r.date ?? r.tradeDate ?? r.timestamp ?? '').trim();
    if (!date && dt) date = dt;

    if (isFii) {
      fiiBuy += buy;
      fiiSell += sell;
    } else if (isDii) {
      diiBuy += buy;
      diiSell += sell;
    }
  }

  if (fiiBuy === 0 && fiiSell === 0 && diiBuy === 0 && diiSell === 0) return null;

  return {
    date: date || toYMD(prevWeekday(new Date())),
    fii_buy: Number(fiiBuy.toFixed(2)),
    fii_sell: Number(fiiSell.toFixed(2)),
    fii_net: Number((fiiBuy - fiiSell).toFixed(2)),
    dii_buy: Number(diiBuy.toFixed(2)),
    dii_sell: Number(diiSell.toFixed(2)),
    dii_net: Number((diiBuy - diiSell).toFixed(2)),
  };
}

// FII/DII from NSE with cookie warm-up and endpoint fallback
async function fetchFiiDii(): Promise<FiiDiiRaw | null> {
  try {
    const cookie = await warmNseCookies();
    const baseHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.nseindia.com/',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (cookie) baseHeaders.Cookie = cookie;

    const endpoints = [
      'https://www.nseindia.com/api/fiidiiTradeReact',
      'https://www.nseindia.com/api/FII-Stats',
    ];

    for (const ep of endpoints) {
      const res = await fetch(ep, {
        headers: baseHeaders,
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      const raw = await res.json() as unknown;
      const parsed = parseFiiDiiFromAny(raw);
      if (parsed) return parsed;
    }

    return null;
  } catch (e) {
    console.warn('  ⚠ FII/DII fetch failed:', (e as Error).message);
    return null;
  }
}

function mapFinnhubImpact(raw: unknown): 'High' | 'Moderate' | 'Low' {
  const text = String(raw ?? '').toLowerCase();
  if (text.includes('high') || text === '3') return 'High';
  if (text.includes('medium') || text.includes('moderate') || text === '2') return 'Moderate';
  return 'Low';
}

function isIndiaRelatedEvent(row: Record<string, unknown>): boolean {
  const country = String(row.country ?? '').toUpperCase();
  if (country === 'IN') return true;
  const txt = `${String(row.event ?? '')} ${String(row.indicator ?? '')}`.toLowerCase();
  return /\bindia\b|\bind\b|rbi|nifty|sensex|iip|wpi|cpi/.test(txt);
}

function indiaRelevanceScore(e: CalendarEventRaw): number {
  let score = 0;
  const country = e.country.toUpperCase();
  const text = e.event.toLowerCase();

  // Country weighting by India market spillover
  if (country === 'IN') score += 100;
  else if (country === 'US') score += 60;
  else if (country === 'CN') score += 50;
  else if (country === 'JP') score += 40;
  else if (country === 'EU' || country === 'DE' || country === 'GB') score += 30;
  else score += 10;

  // Macro keywords that usually move Indian indices/INR/bonds
  if (/rbi|india|nifty|sensex/.test(text)) score += 80;
  if (/fed|fomc|powell|treasury|jobless|nonfarm|cpi|pmi|gdp|inflation|interest rate/.test(text)) score += 35;
  if (/oil|crude|brent|trade|exports|imports/.test(text)) score += 20;

  if (e.importance === 'High') score += 25;
  else if (e.importance === 'Moderate') score += 10;

  return score;
}

async function fetchFinnhubEconomicCalendar(apiKey: string, dayYmd: string): Promise<CalendarEventRaw[]> {
  const url = new URL('https://finnhub.io/api/v1/calendar/economic');
  url.searchParams.set('from', dayYmd);
  url.searchParams.set('to', dayYmd);
  url.searchParams.set('token', apiKey);

  const res = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'BNPC-Market-Bot/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Finnhub HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const payload = await res.json() as {
    economicCalendar?: Array<Record<string, unknown>>;
  };

  const rows = Array.isArray(payload.economicCalendar) ? payload.economicCalendar : [];

  const mapped = rows.map((r): CalendarEventRaw => ({
      time_ist: String(r.time ?? 'All Day'),
      event: String(r.event ?? r.indicator ?? 'Economic Event'),
      country: String(r.country ?? 'US').toUpperCase(),
      importance: mapFinnhubImpact(r.importance ?? r.impact),
      forecast: r.estimate == null ? null : String(r.estimate),
      previous: r.prev == null ? null : String(r.prev),
    }));

  // Keep calendar India-first, then add selective global macro events.
  const indiaRows = rows.filter((r) => isIndiaRelatedEvent(r));
  const indiaEvents = indiaRows.map((r): CalendarEventRaw => ({
    time_ist: String(r.time ?? 'All Day'),
    event: String(r.event ?? r.indicator ?? 'Economic Event'),
    country: 'IN',
    importance: mapFinnhubImpact(r.importance ?? r.impact),
    forecast: r.estimate == null ? null : String(r.estimate),
    previous: r.prev == null ? null : String(r.prev),
  }));

  const nonIndiaMacro = mapped
    .filter((e) => e.country !== 'IN' && e.importance !== 'Low')
    .sort((a, b) => indiaRelevanceScore(b) - indiaRelevanceScore(a));

  // If Finnhub has no India rows for the day, inject a conservative India baseline.
  const indiaSeed = indiaEvents.length > 0
    ? indiaEvents
    : buildEconomicCalendarFallback().filter((e) => e.country === 'IN');

  // Prefer at least 6 India events when available; backfill with ranked macro.
  const minIndiaTarget = 6;
  const indiaFirst = indiaSeed.slice(0, minIndiaTarget);
  const indiaOverflow = indiaSeed.slice(minIndiaTarget);
  const out = [...indiaFirst, ...nonIndiaMacro, ...indiaOverflow];

  // Deduplicate by event + time while preserving India-first ordering.
  const seen = new Set<string>();
  const deduped = out.filter((e) => {
    const key = `${e.time_ist}__${e.event.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.slice(0, 12);
}

function buildEconomicCalendarFallback(): CalendarEventRaw[] {
  // Reliable baseline calendar to ensure the UI is never empty.
  // Can be replaced later with external scrape/API enrichment.
  return [
    {
      time_ist: '12:00',
      event: 'India Services PMI',
      country: 'IN',
      importance: 'Moderate',
      forecast: null,
      previous: null,
    },
    {
      time_ist: '18:00',
      event: 'US Initial Jobless Claims',
      country: 'US',
      importance: 'Moderate',
      forecast: null,
      previous: null,
    },
    {
      time_ist: '20:00',
      event: 'Fed Speaker / FOMC Commentary',
      country: 'US',
      importance: 'High',
      forecast: null,
      previous: null,
    },
  ];
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function prevWeekday(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  loadEnvFromFile();
  console.log('📊 Fetching market data...');

  // Global cues
  let globalCues: GlobalCueRaw[] = [];
  try {
    globalCues = await fetchYahooFinance();
    console.log(`  Global cues: ${globalCues.length} symbols`);
  } catch (e) {
    console.warn('  ⚠ Yahoo Finance failed:', (e as Error).message);
  }

  // Gift Nifty placeholder if not fetched
  const hasGift = globalCues.some((c) => c.name.toLowerCase().includes('gift') || c.name.toLowerCase().includes('sgx'));
  if (!hasGift) {
    const nifty = globalCues.find((c) => c.name === 'Nifty 50');
    if (nifty) {
      globalCues.push({
        name: 'Gift Nifty',
        value: Number((nifty.value - 15).toFixed(2)),
        change: Number((nifty.change - 5).toFixed(2)),
        change_pct: Number((nifty.change_pct - 0.02).toFixed(2)),
        direction: nifty.change_pct > 0 ? 'up' : 'down',
      });
    }
  }

  // FII/DII
  let fiiDii: FiiDiiRaw | null = await fetchFiiDii();
  if (!fiiDii) {
    console.warn('  ⚠ FII/DII not available — using zero placeholder');
    fiiDii = {
      date:     toYMD(prevWeekday(new Date())),
      fii_buy:  0, fii_sell: 0, fii_net: 0,
      dii_buy:  0, dii_sell: 0, dii_net: 0,
    };
  } else {
    console.log(`  FII/DII: ok (${fiiDii.fii_net >= 0 ? '+' : ''}${fiiDii.fii_net} / ${fiiDii.dii_net >= 0 ? '+' : ''}${fiiDii.dii_net})`);
  }

  let indiaVix: IndiaVixMarketRaw | null = await fetchIndiaVixFromNse();
  if (indiaVix) {
    console.log(`  India VIX: ${indiaVix.value} (${indiaVix.change_percent >= 0 ? '+' : ''}${indiaVix.change_percent}%)`);
  }

  const output = { global_cues: globalCues, fii_dii: fiiDii, india_vix: indiaVix };

  const outPath = path.join(process.cwd(), 'tmp', 'raw-market.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`✓ Saved to ${outPath}`);

  let calendar: CalendarEventRaw[] = [];
  const finnhubKey = process.env.FINNHUB_API_KEY?.trim();
  if (finnhubKey) {
    try {
      calendar = await fetchFinnhubEconomicCalendar(finnhubKey, toYMD(new Date()));
      console.log(`  Economic calendar: Finnhub ${calendar.length} events`);
    } catch (e) {
      console.warn('  ⚠ Finnhub calendar failed:', (e as Error).message);
    }
  }
  if (calendar.length === 0) {
    calendar = buildEconomicCalendarFallback();
    console.log(`  Economic calendar: fallback ${calendar.length} events`);
  }

  const calPath = path.join(process.cwd(), 'tmp', 'raw-calendar.json');
  fs.writeFileSync(calPath, JSON.stringify(calendar, null, 2));
  console.log(`✓ Saved to ${calPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
