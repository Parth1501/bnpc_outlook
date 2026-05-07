/**
 * fetch-news.ts
 * Pulls news from RSS feeds between yesterday 15:30 IST and now.
 * Saves raw items to /tmp/raw-news.json
 */

import * as fs from 'fs';
import * as path from 'path';

// ── RSS feed list ────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { name: 'Moneycontrol Markets',  url: 'https://www.moneycontrol.com/rss/marketstats.xml' },
  { name: 'Economic Times Markets',url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
  { name: 'Business Standard',     url: 'https://www.business-standard.com/rss/markets-106.rss' },
  { name: 'LiveMint Markets',      url: 'https://www.livemint.com/rss/markets' },
  { name: 'Reuters India',         url: 'https://feeds.reuters.com/reuters/INbusinessNews' },
];

// ── Market-relevance keywords ────────────────────────────────────────────────
const MARKET_KEYWORDS = [
  'nifty', 'sensex', 'sebi', 'rbi', 'bse', 'nse', 'ipo', 'stock', 'share',
  'fii', 'dii', 'mutual fund', 'sip', 'equity', 'bond', 'yield', 'repo',
  'inflation', 'gdp', 'cpi', 'pmi', 'earnings', 'results', 'profit', 'revenue',
  'quarter', 'q1', 'q2', 'q3', 'q4', 'fy', 'rupee', 'inr', 'usd', 'dollar',
  'crude', 'oil', 'gold', 'silver', 'metals', 'banking', 'npa', 'credit',
  'merger', 'acquisition', 'ipo', 'stake', 'buyback', 'dividend', 'split',
  'fed', 'federal reserve', 'interest rate', 'rate cut', 'rate hike',
];

interface NewsItem {
  title: string;
  description: string;
  link: string;
  pubDate: string;
  source: string;
  provider: 'marketaux' | 'rss';
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

function toIstCutoffIso(): string {
  // Build exact UTC instant for "yesterday 15:30 IST".
  const istNow = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate() - 1;
  const cutoffUtcMs = Date.UTC(y, m, d, 10, 0, 0, 0); // 15:30 IST == 10:00 UTC
  return new Date(cutoffUtcMs).toISOString();
}

function toMarketauxDate(valueIso: string): string {
  return valueIso.slice(0, 10);
}

async function fetchMarketauxNews(apiKey: string): Promise<NewsItem[]> {
  const url = new URL('https://api.marketaux.com/v1/news/all');
  url.searchParams.set('api_token', apiKey);
  url.searchParams.set('countries', 'in,us,gb,sg');
  url.searchParams.set('language', 'en');
  url.searchParams.set('published_after', toMarketauxDate(toIstCutoffIso()));
  url.searchParams.set('filter_entities', 'true');
  url.searchParams.set('group_similar', 'true');
  url.searchParams.set('limit', '100');
  url.searchParams.set('sort', 'published_desc');

  const res = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'BNPC-Market-Bot/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const payload = await res.json() as {
    data?: Array<{
      title?: string;
      description?: string;
      url?: string;
      published_at?: string;
      source?: string;
    }>;
  };

  const rows = payload.data ?? [];
  return rows
    .map((n): NewsItem => ({
      title: n.title?.trim() ?? '',
      description: (n.description ?? '').trim().slice(0, 500),
      link: n.url?.trim() ?? '',
      pubDate: n.published_at ?? '',
      source: n.source?.trim() || 'Marketaux',
      provider: 'marketaux',
    }))
    .filter((n) => n.title.length > 0);
}

// ── Minimal XML field extractor (no deps) ────────────────────────────────────
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
      title:       extractXmlField(raw, 'title'),
      description: extractXmlField(raw, 'description').slice(0, 500),
      link:        extractXmlField(raw, 'link'),
      pubDate:     extractXmlField(raw, 'pubDate'),
      source:      sourceName,
      provider:    'rss',
    };
  });
}

function isMarketRelevant(item: NewsItem): boolean {
  const text = (item.title + ' ' + item.description).toLowerCase();
  return MARKET_KEYWORDS.some((kw) => text.includes(kw));
}

function isAfterYesterdayClose(pubDate: string): boolean {
  const pub = new Date(pubDate);
  if (isNaN(pub.getTime())) return true; // include if date unparseable

  // Yesterday 15:30 IST = yesterday 10:00 UTC
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - 1);
  cutoff.setUTCHours(10, 0, 0, 0);

  return pub >= cutoff;
}

function dedupeByTitle(items: NewsItem[]): NewsItem[] {
  const bucket = new Map<string, NewsItem>();
  for (const item of items) {
    const key = item.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
    const prev = bucket.get(key);
    if (!prev) {
      bucket.set(key, item);
      continue;
    }
    // Prefer Marketaux over RSS when headlines clash.
    if (prev.provider === 'rss' && item.provider === 'marketaux') {
      bucket.set(key, item);
    }
  }
  return Array.from(bucket.values());
}

function sortByNewest(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => {
    const ta = new Date(a.pubDate).getTime();
    const tb = new Date(b.pubDate).getTime();
    const safeA = Number.isFinite(ta) ? ta : 0;
    const safeB = Number.isFinite(tb) ? tb : 0;
    return safeB - safeA;
  });
}

async function fetchFeed(feed: { name: string; url: string }): Promise<NewsItem[]> {
  try {
    console.log(`  Fetching: ${feed.name}`);
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'BNPC-Market-Bot/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRssItems(xml, feed.name);
  } catch (err) {
    console.warn(`  ⚠ Failed ${feed.name}: ${(err as Error).message}`);
    return [];
  }
}

async function main() {
  loadEnvFromFile();
  console.log('📰 Fetching news from RSS feeds...');

  const results = await Promise.allSettled(RSS_FEEDS.map(fetchFeed));
  const rssItems = results.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
  console.log(`  RSS items: ${rssItems.length}`);

  let marketauxItems: NewsItem[] = [];
  const marketauxKey = process.env.MARKETAUX_KEY?.trim();
  if (marketauxKey) {
    try {
      console.log('  Fetching: Marketaux');
      marketauxItems = await fetchMarketauxNews(marketauxKey);
      console.log(`  Marketaux items: ${marketauxItems.length}`);
    } catch (err) {
      console.warn(`  ⚠ Failed Marketaux: ${(err as Error).message}`);
    }
  } else {
    console.log('  Marketaux key not set; skipping Marketaux source');
  }

  const allItems = [...rssItems, ...marketauxItems];

  console.log(`  Raw items: ${allItems.length}`);

  const filtered = allItems
    .filter(isMarketRelevant)
    .filter((i) => isAfterYesterdayClose(i.pubDate));

  const deduped = sortByNewest(dedupeByTitle(filtered));
  const marketauxUsed = deduped.filter((i) => i.provider === 'marketaux').length;
  const rssUsed = deduped.filter((i) => i.provider === 'rss').length;
  const finalItems = deduped;

  console.log(`  After filter+dedup: ${deduped.length} items`);
  console.log(`  Selected (combined sources): ${finalItems.length}`);
  console.log(`    Marketaux used: ${marketauxUsed}`);
  console.log(`    RSS used: ${rssUsed}`);

  const outPath = path.join(process.cwd(), 'tmp', 'raw-news.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(finalItems, null, 2));
  console.log(`✓ Saved to ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
