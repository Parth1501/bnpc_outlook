/**
 * run-pipeline.ts
 * Orchestrates the full daily analysis pipeline in sequence.
 * Run: tsx scripts/run-pipeline.ts
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'), '..');

function run(script: string) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`▶ ${script}`);
  console.log('─'.repeat(50));
  execSync(`tsx ${path.join('scripts', script)}`, {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env },
  });
}

async function main() {
  console.log('🚀 BNPC Daily Market Pipeline\n');

  // Ensure tmp directory exists
  fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });

  // 1. Verify yesterday's call (needs market close data)
  try { run('verify-yesterday.ts'); }
  catch (e) { console.warn('⚠ verify-yesterday failed (non-fatal):', (e as Error).message); }

  // 2. Fetch news
  run('fetch-news.ts');

  // 3. Fetch market data
  run('fetch-market-data.ts');

  // 4. Fetch trusted result schedule
  run('fetch-results.ts');

  // 5. Run AI analysis
  run('analyze.ts');

  console.log('\n✅ Pipeline complete. Run `npm run build` to generate the site.');
}

main().catch((e) => { console.error(e); process.exit(1); });
