/**
 * Gönderim penceresi kontrolü — cold outreach deliverability (Feature: iş saatleri + hafta içi).
 *
 * Kampanya kolonları:
 *  - send_window_start / send_window_end → Postgres `time` (postgres.js bunu "HH:MM:SS" STRING döner;
 *    1083 OID'i için driver'da parser yok → Date'e çevrilmez).
 *  - send_days → integer[] (postgres.js'te number[]), ISO dow: 1=Pzt … 7=Paz.
 *
 * `isWithinSendWindow`, verilen anın Türkiye saatiyle (Europe/Istanbul, UTC+3) gönderim
 * penceresinde olup olmadığını söyler. Worker pencere dışındaki tick'lerde mail göndermez
 * (gece/hafta sonu gönderim = spam sinyali + düşük açılma).
 *
 * Pure: `now` dışarıdan enjekte edilir → test edilebilir. Yerel saat/gün Intl ile çözülür,
 * server UTC olsa bile doğru sonuç verir (DST'yi de tz veritabanı halleder; TR 2016'dan beri
 * sabit UTC+3).
 *
 * Eksik/geçersiz config'te ilgili kısıt UYGULANMAZ (fail-open): yanlışlıkla tüm kampanyaları
 * durdurmaktansa bugünkü 7/24 davranışına düşmek daha güvenli. Aralık `start < end` (iş saati)
 * varsayar; ters/boş aralık (end <= start, gece aşırı) desteklenmez → saat kısıtı atlanır.
 */

const ISO_WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** "HH:MM[:SS[.ffffff]]" → gün-içi dakika (0-1439). Parse edilemezse null. */
export function parseTimeToMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Verilen anın `tz`'deki yerel ISO dow (1-7) ve gün-içi dakika değeri. tz geçersizse null. */
function localParts(now: Date, tz: string): { isoDow: number; minutes: number } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23', // 00-23 garantisi (hour12:false bazı ortamlarda gece yarısı "24" döner)
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(now);
  } catch {
    return null; // geçersiz IANA tz
  }

  let weekday = '';
  let hour = NaN;
  let minute = NaN;
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value;
    else if (p.type === 'hour') hour = Number(p.value);
    else if (p.type === 'minute') minute = Number(p.value);
  }

  const isoDow = ISO_WEEKDAY[weekday];
  if (!isoDow || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return { isoDow, minutes: hour * 60 + minute };
}

/**
 * `now` (UTC instant) `tz`'de gönderim penceresinde mi?
 *  - days (ISO dow 1-7) doluysa: yerel gün listede olmalı.
 *  - start/end ("HH:MM:SS") parse edilebiliyor ve start < end ise: yerel saat [start, end)
 *    yarı-açık aralığında olmalı (start dahil, end hariç).
 * Eksik/geçersiz config ilgili kısıtı atlar (fail-open). tz çözülemezse true döner.
 */
export function isWithinSendWindow(
  now: Date,
  start: unknown,
  end: unknown,
  days: unknown,
  tz: string,
): boolean {
  const local = localParts(now, tz);
  if (!local) return true; // tz çözülemedi → engelleme (fail-open)

  // Gün kontrolü — days doluysa yerel gün listede olmalı
  if (Array.isArray(days) && days.length > 0) {
    const allowed = days.map(Number).filter((d) => Number.isInteger(d));
    if (allowed.length > 0 && !allowed.includes(local.isoDow)) return false;
  }

  // Saat aralığı kontrolü — [start, end) yarı-açık; ters/boş aralık atlanır
  const startMin = parseTimeToMinutes(start);
  const endMin = parseTimeToMinutes(end);
  if (startMin !== null && endMin !== null && endMin > startMin) {
    if (local.minutes < startMin || local.minutes >= endMin) return false;
  }

  return true;
}
