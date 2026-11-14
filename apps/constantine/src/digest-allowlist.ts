/**
 * Günlük özet alıcı kısıtı — 2026-11-03, Mert: "ekibe giden günlük özet sadece bana gelsin".
 *
 * Sabah/akşam operasyon özeti (daily-digest.ts) ve satış günlük özeti (cron-daily-digest.ts)
 * yalnız bu listedeki adreslere gider; profillerdeki daily_digest_enabled tercihi bunun
 * içinde geçerli kalır. Test gönderimi (test_user_id) de aynı listeye tabi — uç kimliksiz
 * tetiklenebildiği için başkasının adına özet attırılamasın.
 *
 * DIGEST_ONLY_EMAILS: virgüllü liste. Tanımsızsa varsayılan Mert. '*' = kısıt yok (eski davranış).
 * Haftalık trend özeti (cron-weekly-digest.ts) bu kısıtın DIŞINDA.
 */
const DEFAULT_ONLY = 'ceketli@gmail.com';

export function digestOnlyEmails(): Set<string> | null {
  const raw = (process.env.DIGEST_ONLY_EMAILS || DEFAULT_ONLY).trim(); // boş = varsayılan
  if (raw === '*') return null;
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export function filterDigestRecipients<T extends { email?: string | null }>(rows: T[]): T[] {
  const only = digestOnlyEmails();
  if (!only) return rows;
  return rows.filter((r) => !!r.email && only.has(r.email.trim().toLowerCase()));
}
