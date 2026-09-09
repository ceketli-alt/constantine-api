/**
 * Warmup duraklatma karari — SAF FONKSIYON (test edilebilsin diye ayri dosyada).
 *
 * Neden asgari hacim tabani var (Mert karari, 26 Agu 2026):
 * Eski kural yalnizca oran bakiyordu: `bounce24h / sent24h > %5`. Gunde 5 mail atan
 * 1C kampanyasinda TEK bir bounce %20 demek ve kampanya tam gun duruyordu — nitekim
 * 26 Agu'da tam bu yuzden durdu. Bes ornekten oran hesaplanmaz.
 * Artik: hacim tabanin altindaysa MUTLAK sayiya bakilir, ustundeyse orana.
 *
 * Sikayet (complaint) kurali BILEREK gevsetilmedi: spam sikayeti nadir ve agir bir
 * sinyaldir, tek sikayet bile 72 saat durdurur.
 */
export const BOUNCE_RATE_THRESHOLD = 0.05;
export const COMPLAINT_RATE_THRESHOLD = 0.001;

/** Oran kuralinin anlamli olmasi icin gereken asgari gonderim sayisi. */
export const MIN_ORAN_HACMI = 20;
/** Hacim tabanin altindayken duraklatan mutlak bounce sayisi. */
export const MUTLAK_BOUNCE_SINIRI = 3;

export type DuraklatmaKarari =
  | { durdur: false }
  | { durdur: true; sebep: 'bounce_threshold' | 'complaint_threshold'; saat: number; aciklama: string };

export function duraklatmaKarari(
  sent24h: number,
  bounceCount: number,
  complaintCount: number,
): DuraklatmaKarari {
  const gonderim = Math.max(0, sent24h);

  if (gonderim >= MIN_ORAN_HACMI) {
    const oran = bounceCount / gonderim;
    if (oran > BOUNCE_RATE_THRESHOLD) {
      return { durdur: true, sebep: 'bounce_threshold', saat: 24,
        aciklama: `bounce %${(oran * 100).toFixed(1)} (${bounceCount}/${gonderim})` };
    }
  } else if (bounceCount >= MUTLAK_BOUNCE_SINIRI) {
    // Az gonderimde oran yaniltici; ama 24 saatte 3 sert bounce her hacimde gercek sinyaldir.
    return { durdur: true, sebep: 'bounce_threshold', saat: 24,
      aciklama: `dusuk hacimde ${bounceCount} bounce (${gonderim} gonderim)` };
  }

  const sikayetOrani = gonderim > 0 ? complaintCount / gonderim : 0;
  if (sikayetOrani > COMPLAINT_RATE_THRESHOLD) {
    return { durdur: true, sebep: 'complaint_threshold', saat: 72,
      aciklama: `sikayet ${complaintCount}/${gonderim}` };
  }

  return { durdur: false };
}
