import { mergeAnalysisDefaultsIntoClone } from './merge-analysis-for-parse';
import { AnalysisSchema, type DailyAnalysis } from './types';

const analyses = import.meta.glob<{ default: DailyAnalysis }>('../data/analyses/*.json');

export async function getAllAnalyses(): Promise<DailyAnalysis[]> {
  const entries = await Promise.all(
    Object.entries(analyses)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(async ([, loader]) => {
        const mod = await loader();
        return AnalysisSchema.parse(mergeAnalysisDefaultsIntoClone(mod.default));
      })
  );
  return entries;
}

export async function getLatestAnalysis(): Promise<DailyAnalysis | null> {
  const all = await getAllAnalyses();
  return all[0] ?? null;
}

export async function getAnalysisByDate(date: string): Promise<DailyAnalysis | null> {
  const all = await getAllAnalyses();
  return all.find(a => a.date === date) ?? null;
}
