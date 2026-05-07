/**
 * verify-yesterday.ts
 * Fetches yesterday's actual Nifty close, compares to our prediction,
 * saves accuracy_review back into yesterday's analysis JSON.
 */

import * as fs from 'fs';
import * as path from 'path';

interface DailyAnalysis {
  date: string;
  overall_bias: 'Bullish' | 'Bearish' | 'Neutral';
  headline_call: string;
  accuracy_review?: object;
  [key: string]: unknown;
}

function prevWeekday(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
}

function toYMD(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function istDate(): Date {
  return new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
}

async function fetchNiftyClose(date: string): Promise<{ close: number; change_pct: number } | null> {
  try {
    const start = Math.floor(new Date(date + 'T00:00:00+05:30').getTime() / 1000);
    const end   = Math.floor(new Date(date + 'T23:59:59+05:30').getTime() / 1000);
    const url   = `https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?period1=${start}&period2=${end}&interval=1d`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BNPC-Bot/1.0)' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const data = await res.json() as {
      chart: {
        result: Array<{
          indicators: {
            quote: Array<{
              close: number[];
              open: number[];
            }>;
          };
        }>;
      };
    };

    const result = data.chart?.result?.[0];
    if (!result) return null;

    const closes = result.indicators.quote[0].close;
    const opens  = result.indicators.quote[0].open;
    const close  = closes[closes.length - 1];
    const open   = opens[0];

    if (!close || !open) return null;

    const change_pct = ((close - open) / open) * 100;
    return { close: Math.round(close), change_pct: Math.round(change_pct * 100) / 100 };
  } catch (e) {
    console.warn('  ⚠ Failed to fetch Nifty close:', (e as Error).message);
    return null;
  }
}

function biasToDirection(bias: string): 'up' | 'down' | 'flat' {
  if (bias === 'Bullish') return 'up';
  if (bias === 'Bearish') return 'down';
  return 'flat';
}

function isCorrect(
  predicted: string,
  actual_pct: number,
): boolean {
  const THRESHOLD = 0.3; // ±0.3% is considered flat
  if (Math.abs(actual_pct) < THRESHOLD) return predicted === 'Neutral';
  if (actual_pct > THRESHOLD) return predicted === 'Bullish';
  return predicted === 'Bearish';
}

async function main() {
  const today = istDate();
  const yesterday = prevWeekday(today);
  const yesterdayStr = toYMD(yesterday);
  const dayBeforeYesterday = prevWeekday(yesterday);
  const dayBeforeStr = toYMD(dayBeforeYesterday);

  console.log(`📈 Verifying yesterday's (${yesterdayStr}) call...`);

  // Find yesterday's analysis file
  const analysisPath = path.join(process.cwd(), 'src', 'data', 'analyses', `${yesterdayStr}.json`);
  if (!fs.existsSync(analysisPath)) {
    console.log(`  No analysis file for ${yesterdayStr} — skipping verification`);
    return;
  }

  const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8')) as DailyAnalysis;

  if (analysis.accuracy_review) {
    console.log(`  Already has accuracy_review — skipping`);
    // Still save to yesterday-review.json for today's prompt
    const reviewPath = path.join(process.cwd(), 'tmp', 'yesterday-review.json');
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    fs.writeFileSync(reviewPath, JSON.stringify(analysis.accuracy_review, null, 2));
    return;
  }

  // Fetch yesterday's actual Nifty close
  const niftyData = await fetchNiftyClose(yesterdayStr);
  if (!niftyData) {
    console.warn('  Could not fetch Nifty data — skipping');
    return;
  }

  const { close, change_pct } = niftyData;
  const actual_direction: 'up' | 'down' | 'flat' =
    Math.abs(change_pct) < 0.3 ? 'flat' : change_pct > 0 ? 'up' : 'down';

  const correct = isCorrect(analysis.overall_bias, change_pct);

  const accuracyReview = {
    yesterday_prediction: analysis.overall_bias,
    yesterday_headline:   analysis.headline_call,
    actual_move:          change_pct,
    actual_direction,
    nifty_close:          close,
    correct,
  };

  // Patch the analysis file
  analysis.accuracy_review = accuracyReview;
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
  console.log(`  Result: ${correct ? '✓ Correct' : '✗ Missed'} (Nifty ${change_pct > 0 ? '+' : ''}${change_pct}%)`);

  // Also save for today's prompt context
  const reviewPath = path.join(process.cwd(), 'tmp', 'yesterday-review.json');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, JSON.stringify(accuracyReview, null, 2));
  console.log(`✓ Saved yesterday-review.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
