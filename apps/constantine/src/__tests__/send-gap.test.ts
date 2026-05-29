/**
 * computeSendGapMs — G3 insansı gönderim aralığı (Faz 1).
 * Resend rate-limit tabanı (250ms) + min_gap + [0,random) jitter. rng enjekte edilebilir.
 */
import { describe, it, expect } from 'vitest';
import { computeSendGapMs } from '../campaign-worker.js';

describe('computeSendGapMs', () => {
  it('min=0 random=0 → rate-limit tabanı (250ms)', () => {
    expect(computeSendGapMs({ min_gap_seconds: 0, random_gap_seconds: 0 })).toBe(250);
  });

  it('null alanlar → taban 250ms', () => {
    expect(computeSendGapMs({ min_gap_seconds: null, random_gap_seconds: null })).toBe(250);
  });

  it('min=30s → 30000ms (tabanın üstünde)', () => {
    expect(computeSendGapMs({ min_gap_seconds: 30, random_gap_seconds: 0 })).toBe(30000);
  });

  it('jitter rng=0 → ek süre 0, min uygulanır', () => {
    expect(computeSendGapMs({ min_gap_seconds: 10, random_gap_seconds: 60 }, () => 0)).toBe(10000);
  });

  it('jitter rng=0.5, random=60s → min + 30000', () => {
    expect(computeSendGapMs({ min_gap_seconds: 10, random_gap_seconds: 60 }, () => 0.5)).toBe(40000);
  });

  it('sadece jitter (min=0) rng≈1 → ~random*1000, tabanın üstünde', () => {
    const v = computeSendGapMs({ min_gap_seconds: 0, random_gap_seconds: 60 }, () => 0.999);
    expect(v).toBeGreaterThan(59000);
    expect(v).toBeLessThanOrEqual(60000);
  });

  it('küçük jitter taban altında kalırsa 250 floor', () => {
    // min=0, random=0.1s, rng=0 → 0 → floor 250
    expect(computeSendGapMs({ min_gap_seconds: 0, random_gap_seconds: 0 }, () => 0.9)).toBe(250);
  });
});
