export type ConvictionBucket = 'low' | 'moderate' | 'high' | 'very_high';

export function getConvictionBucket(score: number): {
  bucket: ConvictionBucket;
  label: string;
  color: string;
} {
  const s = Number.isFinite(score) ? score : 0;
  if (s <= 50) return { bucket: 'low', label: 'Low conviction', color: '#6b7280' };
  if (s <= 65) return { bucket: 'moderate', label: 'Moderate', color: '#f59e0b' };
  if (s <= 80) return { bucket: 'high', label: 'High', color: '#10b981' };
  return { bucket: 'very_high', label: 'Very high', color: '#059669' };
}
