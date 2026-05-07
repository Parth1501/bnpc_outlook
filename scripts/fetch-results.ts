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

function toNseDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
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
  console.log('📌 Fetching trusted result schedule (NSE)...');

  const today = new Date();
  const nseDate = toNseDate(today);
  const cookie = await warmNseCookies();

  const eventsUrl = `https://www.nseindia.com/api/event-calendar?from_date=${nseDate}&to_date=${nseDate}`;
  const annsUrl = `https://www.nseindia.com/api/corporate-announcements?index=equities&from_date=${nseDate}&to_date=${nseDate}`;

  const events = await fetchNseJson<NseEventRow[]>(eventsUrl, cookie);
  const announcements = await fetchNseJson<NseAnnouncementRow[]>(annsUrl, cookie);

  const resultEvents = events.filter((r) =>
    containsResultsKeyword(`${r.purpose ?? ''} ${r.bm_desc ?? ''}`)
  );

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

    return {
      symbol,
      company,
      timing,
      expected_time_ist: parsed ? parsed.hhmm : undefined,
      note: purpose || bm || 'Financial results related board update',
    };
  });

  const finalResults = dedupeAndSort(out).slice(0, 60);

  const outPath = path.join(process.cwd(), 'tmp', 'raw-results.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(finalResults, null, 2));

  console.log(`  NSE event calendar rows: ${events.length}`);
  console.log(`  Results candidates: ${resultEvents.length}`);
  console.log(`✓ Saved to ${outPath} (${finalResults.length} records)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

