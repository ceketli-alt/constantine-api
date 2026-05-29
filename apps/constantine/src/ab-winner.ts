/**
 * A/B test otomatik kazanan kararı — Feature #58.
 *
 * Pure fonksiyon: iki varyantın istatistiğine bakar, yeterli örneklem varsa kazananı seçer.
 * Worker her tick'te ab_test_enabled + henüz ab_winner_variant NULL olan kampanyalar için
 * çağırır; kazanan belirlenince campaigns.ab_winner_variant set edilir ve KALAN tüm
 * ilk gönderimler kazanan varyantla gider.
 *
 * Metrik seçimi:
 *  - opts.metric ile ZORLANABİLİR ('reply' | 'open'). Instantly "Choose winning metric" muadili.
 *  - 'auto' (default): yeterli reply (toplam ≥ 3) → reply-rate; yoksa → open-rate.
 */
export type AbVariant = 'a' | 'b';

export interface AbVariantStat {
  variant: AbVariant;
  sent: number;
  opened: number;
  replied: number;
}

export interface AbWinnerDecision {
  winner: AbVariant | null;
  reason: 'insufficient_sample' | 'no_signal' | 'tie' | 'resolved';
  metric: 'reply' | 'open' | null;
}

export function computeAbWinner(
  a: AbVariantStat,
  b: AbVariantStat,
  opts: { minPerVariant?: number; metric?: 'reply' | 'open' | 'auto' } = {},
): AbWinnerDecision {
  const minPerVariant = opts.minPerVariant ?? 15;

  // Her iki varyant da yeterince gönderilmiş olmalı (gürültüye karşı)
  if (a.sent < minPerVariant || b.sent < minPerVariant) {
    return { winner: null, reason: 'insufficient_sample', metric: null };
  }

  const totalReplied = a.replied + b.replied;
  // Zorunlu metrik (kampanya ayarı) varsa onu kullan; yoksa auto (reply≥3 → reply, değilse open).
  const forced = opts.metric && opts.metric !== 'auto' ? opts.metric : null;
  const metric: 'reply' | 'open' = forced ?? (totalReplied >= 3 ? 'reply' : 'open');
  const rate = (s: AbVariantStat): number =>
    s.sent > 0 ? (metric === 'reply' ? s.replied / s.sent : s.opened / s.sent) : 0;

  const ra = rate(a);
  const rb = rate(b);

  if (ra === 0 && rb === 0) return { winner: null, reason: 'no_signal', metric };
  if (ra === rb) return { winner: null, reason: 'tie', metric };
  return { winner: ra > rb ? 'a' : 'b', reason: 'resolved', metric };
}
