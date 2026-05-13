/**
 * fetch-news.ts
 * Pulls news from RSS feeds, Marketaux, and GNews between yesterday 15:30 IST
 * (= yesterday 10:00 UTC) and now. Saves raw items to /tmp/raw-news.json.
 *
 * GNews window: designed for a 02:00 UTC daily cron.
 *   from = previous UTC calendar day at T10:00:00Z
 *   to   = current  UTC calendar day at T02:00:00Z
 * Running much earlier the same UTC day makes `to` lie in the future; GNews
 * may return fewer results or future-anchor results in that case.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── RSS feed list ─────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  // ── Financial / Markets ───────────────────────────────────────────────────
  {
    name: 'Economic Times Markets',
    urls: ['https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms'],
  },
  {
    name: 'LiveMint Markets',
    urls: ['https://www.livemint.com/rss/markets'],
  },
  {
    name: 'LiveMint News',
    urls: ['https://www.livemint.com/rss/news'],
  },
  {
    name: 'Moneycontrol Business',
    urls: ['https://www.moneycontrol.com/rss/business.xml'],
  },
  {
    name: 'Moneycontrol Latest',
    urls: ['https://www.moneycontrol.com/rss/latestnews.xml'],
  },
  // ── National / General ────────────────────────────────────────────────────
  {
    name: 'The Hindu National',
    urls: ['https://www.thehindu.com/news/national/feeder/default.rss'],
  },
  {
    name: 'Indian Express',
    urls: ['https://indianexpress.com/feed/'],
  },
  {
    name: 'Hindustan Times India',
    urls: ['https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml'],
  },
  {
    name: 'Times of India',
    urls: ['https://timesofindia.indiatimes.com/rssfeedstopstories.cms'],
  },
  {
    name: 'NDTV',
    urls: ['https://feeds.feedburner.com/ndtvnews-top-stories'],
  },
  {
    name: 'News18 India',
    urls: ['https://www.news18.com/rss/india.xml'],
  },
  {
    name: 'The Wire',
    urls: ['https://thewire.in/rss'],
  },
  {
    name: 'Scroll.in',
    urls: ['https://scroll.in/feeds/all.rss'],
  },
  {
    name: 'The Print',
    urls: ['https://theprint.in/feed/'],
  },
  {
    name: 'PIB',
    urls: ['https://pib.gov.in/RssMain.aspx'],
  },
];

// ── Market-relevance keywords ─────────────────────────────────────────────────
const MARKET_KEYWORDS = [
  'nifty', 'sensex', 'sebi', 'rbi', 'bse', 'nse', 'ipo', 'stock', 'share',
  'fii', 'dii', 'mutual fund', 'sip', 'equity', 'bond', 'yield', 'repo',
  'inflation', 'gdp', 'cpi', 'pmi', 'earnings', 'results', 'profit', 'revenue',
  'quarter', 'q1', 'q2', 'q3', 'q4', 'fy', 'rupee', 'inr', 'usd', 'dollar',
  'crude', 'oil', 'gold', 'silver', 'metals', 'banking', 'npa', 'credit',
  'merger', 'acquisition', 'stake', 'buyback', 'dividend', 'split',
  'fed', 'federal reserve', 'interest rate', 'rate cut', 'rate hike',
  'budget', 'tax', 'gst', 'import', 'export', 'trade', 'tariff', 'duty',
];

interface NewsItem {
  title: string;
  description: string;
  link: string;
  pubDate: string;
  source: string;
  provider: 'marketaux' | 'gnews' | 'rss';
}

// ── Env loading ───────────────────────────────────────────────────────────────
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

// ── UTC window helpers ────────────────────────────────────────────────────────
/**
 * Canonical news window for all providers (designed for a 02:00 UTC daily cron):
 *   from = previous UTC calendar day at 10:00:00Z  (= yesterday 15:30 IST)
 *   to   = current  UTC calendar day at 02:00:00Z  (= today    07:30 IST)
 *
 * Running well before 02:00 UTC makes `to` lie in the future; RSS/Marketaux
 * items beyond that time are intentionally excluded by isInWindow().
 */
function newsWindow(): { from: Date; to: Date } {
  const now = new Date();
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 10, 0, 0, 0)),
    to:   new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),      2, 0, 0, 0)),
  };
}

/**
 * Returns true if pubDate falls within [from, to].
 * Items with unparseable dates are included (safe default).
 */
function isInWindow(pubDate: string, from: Date, to: Date): boolean {
  const pub = new Date(pubDate);
  if (isNaN(pub.getTime())) return true;
  return pub >= from && pub <= to;
}

/** ISO strings for the GNews API `from`/`to` query params (reuses newsWindow). */
function gnewsWindowIso(): { from: string; to: string } {
  const { from, to } = newsWindow();
  return { from: from.toISOString(), to: to.toISOString() };
}

function toMarketauxDate(valueIso: string): string {
  return valueIso.slice(0, 10);
}

// ── GNews fetch ───────────────────────────────────────────────────────────────
async function fetchGnews(apiKey: string): Promise<NewsItem[]> {
  const maxPerPage = Math.min(100, Math.max(1, Number(process.env.GNEWS_MAX ?? 100) || 100));
  const maxPages   = Math.max(1, Number(process.env.GNEWS_MAX_PAGE ?? 10) || 10);
  const { from, to } = gnewsWindowIso();

  console.log(`  GNews window : ${from} → ${to}`);
  console.log(`  GNews config : max ${maxPages} pages × ${maxPerPage} articles/page`);

  const all: NewsItem[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL('https://gnews.io/api/v4/top-headlines');
    url.searchParams.set('apikey',   apiKey);
    url.searchParams.set('category', 'business');
    url.searchParams.set('lang',     'en');
    url.searchParams.set('country',  'in');
    url.searchParams.set('max',      String(maxPerPage));
    url.searchParams.set('page',     String(page));
    url.searchParams.set('from',     from);
    url.searchParams.set('to',       to);

    console.log(`  GNews page ${page}/${maxPages} → GET ${url.toString().replace(apiKey, '***')}`);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Accept: 'application/json', 'User-Agent': 'BNPC-Market-Bot/1.0' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      console.error(`  ✗ GNews page ${page}: network error — ${(e as Error).message}`);
      break;
    }

    if (!res.ok) {
      let errBody = '';
      try { errBody = await res.text(); } catch { /* ignore */ }
      console.error(`  ✗ GNews page ${page}: HTTP ${res.status} — ${errBody.slice(0, 200)}`);
      break;
    }

    const payload = await res.json() as {
      totalArticles?: number;
      articles?: Array<{
        title?: string;
        description?: string;
        url?: string;
        publishedAt?: string;
        source?: { name?: string };
      }>;
    };
    const articles = payload.articles ?? [];
    if (articles.length === 0) {
      console.log(`  GNews page ${page}: 0 articles — stopping pagination (totalArticles reported: ${payload.totalArticles ?? 'n/a'})`);
      break;
    }

    const mapped: NewsItem[] = articles
      .map((a): NewsItem => ({
        title:       (a.title ?? '').trim(),
        description: (a.description ?? '').trim().slice(0, 500),
        link:        (a.url ?? '').trim(),
        pubDate:     a.publishedAt ?? '',
        source:      (a.source?.name ?? 'GNews').trim(),
        provider:    'gnews',
      }))
      .filter((n) => n.title.length > 0);

    console.log(`  GNews page ${page}: ${mapped.length} articles fetched (running total: ${all.length + mapped.length})`);
    if (mapped.length > 0) {
      console.log(`    Newest: "${mapped[0].title.slice(0, 80)}" (${mapped[0].pubDate})`);
      console.log(`    Oldest: "${mapped[mapped.length - 1].title.slice(0, 80)}" (${mapped[mapped.length - 1].pubDate})`);
    }
    all.push(...mapped);

    if (page < maxPages && mapped.length > 0) {
      console.log(`  GNews page ${page}: waiting 2s before next page...`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  return all;
}

// ── Marketaux fetch ───────────────────────────────────────────────────────────
async function fetchMarketauxNews(apiKey: string): Promise<NewsItem[]> {
  const cutoff = toMarketauxDate(newsWindow().from.toISOString());
  const url = new URL('https://api.marketaux.com/v1/news/all');
  url.searchParams.set('api_token',      apiKey);
  url.searchParams.set('countries',      'in,us,gb,sg');
  url.searchParams.set('language',       'en');
  url.searchParams.set('published_after', cutoff);
  url.searchParams.set('filter_entities', 'true');
  url.searchParams.set('group_similar',   'true');
  url.searchParams.set('limit',           '24');
  url.searchParams.set('sort',            'published_desc');

  console.log(`  Marketaux published_after: ${cutoff}`);

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': 'BNPC-Market-Bot/1.0' },
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

  const items = (payload.data ?? [])
    .map((n): NewsItem => ({
      title:       (n.title ?? '').trim(),
      description: (n.description ?? '').trim().slice(0, 500),
      link:        (n.url ?? '').trim(),
      pubDate:     n.published_at ?? '',
      source:      (n.source ?? 'Marketaux').trim(),
      provider:    'marketaux',
    }))
    .filter((n) => n.title.length > 0);

  if (items.length > 0) {
    console.log(`  Marketaux newest: "${items[0].title.slice(0, 80)}" (${items[0].pubDate})`);
  }
  return items;
}

// ── RSS helpers ───────────────────────────────────────────────────────────────
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
      provider:    'rss' as const,
    };
  });
}

async function fetchXmlWithRetry(url: string): Promise<string> {
  const headers = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept':          'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
    'Referer':         new URL(url).origin + '/',
  };
  let lastErr = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      if (!xml || xml.length < 100 || !/<rss|<feed/i.test(xml)) {
        throw new Error('Invalid/empty feed response');
      }
      return xml;
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw new Error(lastErr);
}

async function fetchFeed(feed: { name: string; urls: string[] }): Promise<NewsItem[]> {
  for (const url of feed.urls) {
    try {
      const xml = await fetchXmlWithRetry(url);
      const items = parseRssItems(xml, feed.name);
      if (items.length > 0) {
        console.log(`  ✓ ${feed.name.padEnd(28)} ${String(items.length).padStart(4)} items  (${url})`);
        return items;
      }
      console.warn(`  ⚠ ${feed.name}: feed returned 0 items (${url})`);
    } catch (err) {
      console.error(`  ✗ ${feed.name}: ${(err as Error).message}  (${url})`);
    }
  }
  console.error(`  ✗ ${feed.name}: ALL URLs failed — skipping`);
  return [];
}

// ── Filters ───────────────────────────────────────────────────────────────────
function isMarketRelevant(item: NewsItem): boolean {
  const text = (item.title + ' ' + item.description).toLowerCase();
  return MARKET_KEYWORDS.some((kw) => text.includes(kw));
}

function isAfterYesterdayClose(pubDate: string): boolean {
  const pub = new Date(pubDate);
  if (isNaN(pub.getTime())) return true; // include if date unparseable
  const now = new Date();
  const cutoff = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1,
    10, 0, 0, 0,
  ));
  return pub >= cutoff;
}

// ── Dedupe / sort ─────────────────────────────────────────────────────────────
// Provider priority (lower = kept in dedupe): rss > gnews > marketaux
// Direct publisher feeds are most trusted; third-party aggregators are lowest.
const PROVIDER_RANK: Record<NewsItem['provider'], number> = {
  rss:       0,
  gnews:     1,
  marketaux: 2,
};

function dedupeByTitle(items: NewsItem[]): NewsItem[] {
  const bucket = new Map<string, NewsItem>();
  for (const item of items) {
    const key = item.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
    const prev = bucket.get(key);
    if (!prev) {
      bucket.set(key, item);
      continue;
    }
    if (PROVIDER_RANK[item.provider] < PROVIDER_RANK[prev.provider]) {
      bucket.set(key, item);
    }
  }
  return Array.from(bucket.values());
}

function sortByNewest(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => {
    const ta = new Date(a.pubDate).getTime();
    const tb = new Date(b.pubDate).getTime();
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  loadEnvFromFile();

  const runStart = Date.now();
  // FETCH_NEWS_MAX_OUT: 0 or unset = no cap; positive integer = slice
  const maxOut = Number(process.env.FETCH_NEWS_MAX_OUT ?? 0) || 0;
  const { from: winFrom, to: winTo } = newsWindow();

  console.log('════════════════════════════════════════════════════════');
  console.log('📰  fetch-news  —  ' + new Date().toISOString());
  console.log(`    News window (all providers): ${winFrom.toISOString()} → ${winTo.toISOString()}`);
  console.log(`    Output cap (FETCH_NEWS_MAX_OUT): ${maxOut > 0 ? maxOut : 'none'}`);
  console.log('════════════════════════════════════════════════════════');

  // ── RSS ───────────────────────────────────────────────────────────────────
  console.log('\n[RSS] Fetching ' + RSS_FEEDS.length + ' feeds in parallel...');
  const rssResults = await Promise.allSettled(RSS_FEEDS.map(fetchFeed));
  const rssItems = rssResults.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
  const rssFailCount = rssResults.filter((r) => r.status === 'rejected').length;
  console.log(`[RSS] Done — ${rssItems.length} items across ${RSS_FEEDS.length} feeds (${rssFailCount} promise rejections)`);

  // ── GNews ─────────────────────────────────────────────────────────────────
  let gnewsItems: NewsItem[] = [];
  const gnewsKey = process.env.GNEWS_API_KEY?.trim();
  console.log('\n[GNews]');
  if (gnewsKey) {
    try {
      gnewsItems = await fetchGnews(gnewsKey);
      console.log(`[GNews] Done — ${gnewsItems.length} articles total`);
    } catch (err) {
      console.error(`[GNews] ✗ Fatal error: ${(err as Error).message}`);
    }
  } else {
    console.log('[GNews] GNEWS_API_KEY not set — skipped');
  }

  // ── Marketaux ─────────────────────────────────────────────────────────────
  let marketauxItems: NewsItem[] = [];
  const marketauxKey = process.env.MARKETAUX_KEY?.trim();
  console.log('\n[Marketaux]');
  if (marketauxKey) {
    try {
      marketauxItems = await fetchMarketauxNews(marketauxKey);
      console.log(`[Marketaux] Done — ${marketauxItems.length} articles`);
    } catch (err) {
      console.error(`[Marketaux] ✗ Fatal error: ${(err as Error).message}`);
    }
  } else {
    console.log('[Marketaux] MARKETAUX_KEY not set — skipped');
  }

  // ── Merge, filter, dedupe ─────────────────────────────────────────────────
  console.log('\n[Merge]');
  const allItems = [...rssItems, ...gnewsItems, ...marketauxItems];
  console.log(`  Total raw          : ${allItems.length}`);

  const afterKeyword = allItems.filter(isMarketRelevant);
  console.log(`  After keyword filter: ${afterKeyword.length}  (dropped ${allItems.length - afterKeyword.length} non-market items)`);

  // Symmetric UTC window applied to all providers (prev-day 10:00Z → today 02:00Z).
  // GNews items are re-checked even though the API already bounded them (catches outliers).
  const afterDate = afterKeyword.filter((i) => isInWindow(i.pubDate, winFrom, winTo));
  console.log(`  After date filter  : ${afterDate.length}  (dropped ${afterKeyword.length - afterDate.length} out-of-window items [${winFrom.toISOString()} → ${winTo.toISOString()}])`);

  const deduped = sortByNewest(dedupeByTitle(afterDate));
  console.log(`  After dedupe       : ${deduped.length}  (dropped ${afterDate.length - deduped.length} duplicates)`);

  const finalItems = maxOut > 0 ? deduped.slice(0, maxOut) : deduped;
  if (maxOut > 0) console.log(`  After output cap   : ${finalItems.length}  (capped at ${maxOut})`);

  // ── Per-source breakdown ──────────────────────────────────────────────────
  const sourceCounts = new Map<string, number>();
  for (const item of finalItems) {
    sourceCounts.set(item.source, (sourceCounts.get(item.source) ?? 0) + 1);
  }
  const byProvider = (p: NewsItem['provider']) => finalItems.filter((i) => i.provider === p).length;
  console.log('\n[Summary]');
  console.log(`  marketaux : ${byProvider('marketaux')}`);
  console.log(`  gnews     : ${byProvider('gnews')}`);
  console.log(`  rss       : ${byProvider('rss')}`);
  console.log('  ── per source ──');
  for (const [src, count] of [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${src.padEnd(32)} ${count}`);
  }
  if (finalItems.length > 0) {
    console.log(`  Newest item: "${finalItems[0].title.slice(0, 80)}" (${finalItems[0].pubDate})`);
    console.log(`  Oldest item: "${finalItems[finalItems.length - 1].title.slice(0, 80)}" (${finalItems[finalItems.length - 1].pubDate})`);
  }

  const outPath = path.join(process.cwd(), 'tmp', 'raw-news.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(finalItems, null, 2));
  console.log(`\n✓ Saved ${finalItems.length} items → ${outPath}  (${Date.now() - runStart}ms)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
