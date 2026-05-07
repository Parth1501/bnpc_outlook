/**
 * fetch-policy-notes.ts
 * Fetches official regulatory/market-policy notes from trusted sources:
 * - SEBI RSS
 * - RBI Press Releases RSS
 * - RBI Notifications RSS
 * - NSE Circulars API
 * plus curated official PIB/CBDT baseline tax note.
 *
 * Saves to /tmp/raw-policy-notes.json
 */

import * as fs from 'fs';
import * as path from 'path';

type PolicyCategory = 'Taxation' | 'Equity Market' | 'FnO Market' | 'Bond Market' | 'Compliance' | 'Other';

interface PolicyNote {
  title: string;
  authority: string;
  category: PolicyCategory;
  fy: string;
  effective_from?: string;
  source_url: string;
  note: string;
}

interface FeedDef {
  authority: string;
  url: string;
}

const TRUSTED_FEEDS: FeedDef[] = [
  { authority: 'SEBI', url: 'https://www.sebi.gov.in/sebirss.xml' },
  { authority: 'RBI', url: 'https://rbi.org.in/pressreleases_rss.xml' },
  { authority: 'RBI', url: 'https://rbi.org.in/notifications_rss.xml' },
];

const KEYWORDS = [
  'ltcg', 'stcg', 'capital gains', 'stt', 'tax', 'securities transaction tax',
  'equity', 'shares', 'stock market', 'listing', 'ipo',
  'f&o', 'derivative', 'futures', 'options',
  'bond', 'debt', 'g-sec', 'government security', 'yield',
  'margin', 'surveillance', 'settlement', 'compliance',
];

function textMatchScore(text: string): number {
  const t = text.toLowerCase();
  let score = 0;
  for (const k of KEYWORDS) if (t.includes(k)) score += 1;
  return score;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractXmlField(xml: string, tag: string): string {
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = cdataRe.exec(xml) ?? plainRe.exec(xml);
  return m ? m[1].trim() : '';
}

function parseRssItems(xml: string): Array<{ title: string; link: string; pubDate: string; description: string }> {
  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  return itemMatches.map((m) => {
    const raw = m[1];
    return {
      title: extractXmlField(raw, 'title'),
      link: extractXmlField(raw, 'link'),
      pubDate: extractXmlField(raw, 'pubDate'),
      description: stripHtml(extractXmlField(raw, 'description')),
    };
  });
}

function fyFromDate(dateIsoLike: string): string {
  const d = new Date(dateIsoLike);
  if (Number.isNaN(d.getTime())) return 'FY Unknown';
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const startYear = m >= 4 ? y : y - 1;
  const endYY = String((startYear + 1) % 100).padStart(2, '0');
  return `FY ${startYear}-${endYY}`;
}

function categoryFromText(text: string): PolicyCategory {
  const t = text.toLowerCase();
  if (/(ltcg|stcg|capital gains|stt|tax)/.test(t)) return 'Taxation';
  if (/(f&o|derivative|futures|options)/.test(t)) return 'FnO Market';
  if (/(bond|debt|g-sec|government security|yield)/.test(t)) return 'Bond Market';
  if (/(equity|share|stock market|listing|ipo)/.test(t)) return 'Equity Market';
  if (/(compliance|disclosure|margin|surveillance|settlement|circular)/.test(t)) return 'Compliance';
  return 'Other';
}

function normalizeNote(authority: string, title: string, link: string, pubDate: string, description: string): PolicyNote {
  const combined = `${title}. ${description}`.trim();
  return {
    title,
    authority,
    category: categoryFromText(combined),
    fy: fyFromDate(pubDate),
    effective_from: Number.isNaN(new Date(pubDate).getTime()) ? undefined : new Date(pubDate).toISOString().slice(0, 10),
    source_url: link,
    note: combined.slice(0, 260),
  };
}

function mergeCookieHeaders(setCookieHeaders: string[]): string {
  return setCookieHeaders
    .map((h) => h.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

async function warmNseCookies(): Promise<string> {
  const res = await fetch('https://www.nseindia.com/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(15_000),
  });

  const rawSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  if (rawSetCookie.length > 0) return mergeCookieHeaders(rawSetCookie);
  const single = res.headers.get('set-cookie');
  return single ? mergeCookieHeaders([single]) : '';
}

async function fetchNseCircularNotes(): Promise<PolicyNote[]> {
  const cookie = await warmNseCookies();
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www.nseindia.com/',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch('https://www.nseindia.com/api/circulars', {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`NSE circulars HTTP ${res.status}`);
  const payload = await res.json() as {
    data?: Array<{
      sub?: string;
      ntDt?: string;
      attchmntFile?: string;
      fileDept?: string;
    }>;
  };

  const rows = payload.data ?? [];
  return rows
    .filter((r) => textMatchScore(`${r.sub ?? ''} ${r.fileDept ?? ''}`) > 0)
    .slice(0, 120)
    .map((r) => {
      const title = String(r.sub ?? 'NSE Circular').trim();
      const date = String(r.ntDt ?? '').trim();
      return normalizeNote('NSE', title, String(r.attchmntFile ?? 'https://www.nseindia.com/corporates/circulars'), date, 'NSE circular update relevant to market participants.');
    });
}

async function fetchFeedNotes(feed: FeedDef): Promise<PolicyNote[]> {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'BNPC-Market-Bot/1.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${feed.authority} feed HTTP ${res.status}`);
  const xml = await res.text();
  const items = parseRssItems(xml);
  return items
    .filter((it) => textMatchScore(`${it.title} ${it.description}`) > 0)
    .slice(0, 120)
    .map((it) => normalizeNote(feed.authority, it.title, it.link, it.pubDate, it.description));
}

function curatedOfficialTaxNotes(): PolicyNote[] {
  return [
    {
      title: 'CBDT FAQs on capital gains tax regime proposed in Union Budget 2024-25',
      authority: 'CBDT / PIB',
      category: 'Taxation',
      fy: 'FY 2024-25',
      effective_from: '2024-07-23',
      source_url: 'https://www.pib.gov.in/PressReleasePage.aspx?PRID=2035596',
      note: 'Official PIB press release on CBDT FAQs explaining capital gains tax framework changes proposed in Union Budget 2024-25.',
    },
  ];
}

function dedupe(notes: PolicyNote[]): PolicyNote[] {
  const seen = new Set<string>();
  const out: PolicyNote[] = [];
  for (const n of notes) {
    const key = `${n.authority}|${n.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function recentFirst(notes: PolicyNote[]): PolicyNote[] {
  return [...notes].sort((a, b) => {
    const ta = a.effective_from ? new Date(a.effective_from).getTime() : 0;
    const tb = b.effective_from ? new Date(b.effective_from).getTime() : 0;
    return tb - ta;
  });
}

async function main() {
  console.log('🏛️ Fetching official market policy notes...');

  const feedResults = await Promise.allSettled(TRUSTED_FEEDS.map(fetchFeedNotes));
  const feedNotes = feedResults.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  for (const r of feedResults) {
    if (r.status === 'rejected') console.warn('  ⚠ Feed failed:', r.reason?.message ?? String(r.reason));
  }

  let nseNotes: PolicyNote[] = [];
  try {
    nseNotes = await fetchNseCircularNotes();
  } catch (e) {
    console.warn('  ⚠ NSE circular fetch failed:', (e as Error).message);
  }

  const curated = curatedOfficialTaxNotes();
  const finalNotes = recentFirst(dedupe([...feedNotes, ...nseNotes, ...curated])).slice(0, 120);

  const outPath = path.join(process.cwd(), 'tmp', 'raw-policy-notes.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(finalNotes, null, 2));

  console.log(`  Feed notes: ${feedNotes.length}`);
  console.log(`  NSE circular notes: ${nseNotes.length}`);
  console.log(`  Curated official tax notes: ${curated.length}`);
  console.log(`✓ Saved to ${outPath} (${finalNotes.length} records)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

