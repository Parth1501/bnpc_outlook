/**
 * verify-yesterday.ts
 * Fetches yesterday's actual Nifty open-to-close move, compares to our prediction,
 * saves accuracy_review back into yesterday's analysis JSON.
 */

import * as fs from 'fs';
import * as path from 'path';
import { mergeAnalysisDefaultsIntoClone } from '../src/lib/merge-analysis-for-parse';
import { AnalysisSchema, type Bias } from '../src/lib/types';

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
    const end = Math.floor(new Date(date + 'T23:59:59+05:30').getTime() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?period1=${start}&period2=${end}&interval=1d`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BNPC-Bot/1.0)' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
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
    const opens = result.indicators.quote[0].open;
    const close = closes[closes.length - 1];
    const open = opens[0];

    if (!close || !open) return null;

    const change_pct = ((close - open) / open) * 100;
    return { close: Math.round(close), change_pct: Math.round(change_pct * 100) / 100 };
  } catch (e) {
    console.warn('  ⚠ Failed to fetch Nifty close:', (e as Error).message);
    return null;
  }
}

function isBullishBias(bias: Bias): boolean {
  return bias === 'Bullish' || bias === 'Strongly Bullish';
}

function isBearishBias(bias: Bias): boolean {
  return bias === 'Bearish' || bias === 'Strongly Bearish';
}

/** Session open→close move vs pre-open directional label (±THRESH treated as flat). */
function isDirectionallyCorrect(bias: Bias, actual_pct: number, threshold: number): boolean {
  if (Math.abs(actual_pct) < threshold) return bias === 'Neutral';
  if (actual_pct > threshold) return isBullishBias(bias);
  if (actual_pct < -threshold) return isBearishBias(bias);
  return false;
}

function verdictFor(
  correct: boolean,
  fullDayConfidence: number | undefined,
): 'hit' | 'soft_miss' | 'hard_miss' {
  if (correct) return 'hit';
  if (fullDayConfidence == null || fullDayConfidence <= 50) return 'soft_miss';
  return 'hard_miss';
}

async function main() {
  const today = istDate();
  const yesterday = prevWeekday(today);
  const yesterdayStr = toYMD(yesterday);

  console.log(`📈 Verifying yesterday's (${yesterdayStr}) call...`);

  const analysisPath = path.join(process.cwd(), 'src', 'data', 'analyses', `${yesterdayStr}.json`);
  if (!fs.existsSync(analysisPath)) {
    console.log(`  No analysis file for ${yesterdayStr} — skipping verification`);
    return;
  }

  const raw = JSON.parse(fs.readFileSync(analysisPath, 'utf-8')) as unknown;
  const merged = mergeAnalysisDefaultsIntoClone(raw);
  const parsed = AnalysisSchema.safeParse(merged);
  if (!parsed.success) {
    console.warn(`  Analysis file failed schema (${parsed.error.message.slice(0, 200)}) — skipping`);
    return;
  }
  const analysis = parsed.data;

  if (analysis.accuracy_review) {
    console.log(`  Already has accuracy_review — skipping`);
    const reviewPath = path.join(process.cwd(), 'tmp', 'yesterday-review.json');
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    fs.writeFileSync(reviewPath, JSON.stringify(analysis.accuracy_review, null, 2));
    return;
  }

  const niftyData = await fetchNiftyClose(yesterdayStr);
  if (!niftyData) {
    console.warn('  Could not fetch Nifty data — skipping');
    return;
  }

  const { close, change_pct } = niftyData;
  const THRESH = 0.3;
  const actual_direction: 'up' | 'down' | 'flat' =
    Math.abs(change_pct) < THRESH ? 'flat' : change_pct > 0 ? 'up' : 'down';

  const fullDayConfidence = analysis.full_day_confidence;
  const correct = isDirectionallyCorrect(analysis.full_day_bias, change_pct, THRESH);
  const verdict = verdictFor(correct, fullDayConfidence);
  const factorsAlignedAtCall = analysis.full_day_rationale.factors_aligned;

  const accuracyReview = {
    yesterday_prediction: analysis.full_day_bias,
    yesterday_headline: analysis.headline_call,
    actual_move: change_pct,
    actual_direction,
    nifty_close: close,
    correct,
    graded_verdict: 'full_day' as const,
    factors_aligned_at_call: factorsAlignedAtCall,
    full_day_confidence_at_call: fullDayConfidence,
    verdict,
  };

  const outRecord = { ...analysis, accuracy_review: accuracyReview };
  fs.writeFileSync(analysisPath, JSON.stringify(outRecord, null, 2));

  const verdictNote = verdict === 'hit' ? '' : ` (${verdict})`;
  console.log(
    `  Result: ${correct ? '✓ Correct' : '✗ Missed'}${verdictNote} (Nifty ${change_pct > 0 ? '+' : ''}${change_pct}%)`,
  );

  const reviewPath = path.join(process.cwd(), 'tmp', 'yesterday-review.json');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, JSON.stringify(accuracyReview, null, 2));
  console.log(`✓ Saved yesterday-review.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
