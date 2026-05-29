/**
 * A/B otomatik kazanan karar mantığı — pure-logic testleri (Feature #58).
 */
import { describe, it, expect } from 'vitest';
import { computeAbWinner, type AbVariantStat } from '../ab-winner.js';

const mk = (variant: 'a' | 'b', sent: number, opened: number, replied: number): AbVariantStat =>
  ({ variant, sent, opened, replied });

describe('computeAbWinner', () => {
  it('yetersiz örneklem → insufficient_sample', () => {
    const r = computeAbWinner(mk('a', 10, 5, 1), mk('b', 12, 6, 1));
    expect(r.reason).toBe('insufficient_sample');
    expect(r.winner).toBeNull();
  });

  it('reply yeterli (≥3) → reply-rate ile kazanan', () => {
    // a: 4/20=%20, b: 1/20=%5 → a kazanır, metric reply
    const r = computeAbWinner(mk('a', 20, 10, 4), mk('b', 20, 10, 1));
    expect(r.metric).toBe('reply');
    expect(r.winner).toBe('a');
    expect(r.reason).toBe('resolved');
  });

  it('reply az → open-rate ile kazanan', () => {
    // toplam reply 1 (<3) → open-rate: a 12/20=%60, b 6/20=%30 → a
    const r = computeAbWinner(mk('a', 20, 12, 1), mk('b', 20, 6, 0));
    expect(r.metric).toBe('open');
    expect(r.winner).toBe('a');
  });

  it('open-rate ile b kazanır', () => {
    const r = computeAbWinner(mk('a', 30, 5, 0), mk('b', 30, 15, 0));
    expect(r.metric).toBe('open');
    expect(r.winner).toBe('b');
  });

  it('hiç sinyal yok (open=0, reply=0) → no_signal', () => {
    const r = computeAbWinner(mk('a', 20, 0, 0), mk('b', 25, 0, 0));
    expect(r.reason).toBe('no_signal');
    expect(r.winner).toBeNull();
  });

  it('eşit oran → tie', () => {
    const r = computeAbWinner(mk('a', 20, 10, 0), mk('b', 20, 10, 0));
    expect(r.reason).toBe('tie');
    expect(r.winner).toBeNull();
  });

  it('minPerVariant override', () => {
    const r = computeAbWinner(mk('a', 5, 3, 0), mk('b', 5, 1, 0), { minPerVariant: 5 });
    expect(r.reason).toBe('resolved');
    expect(r.winner).toBe('a');
  });

  it('reply-rate eşit ama biri sıfır reply değil — tie reply metriğinde', () => {
    // a: 3/30=%10, b: 3/30=%10 → tie, reply metric (toplam 6≥3)
    const r = computeAbWinner(mk('a', 30, 20, 3), mk('b', 30, 5, 3));
    expect(r.metric).toBe('reply');
    expect(r.reason).toBe('tie');
  });
});
