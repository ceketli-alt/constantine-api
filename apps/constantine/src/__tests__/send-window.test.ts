/**
 * Gönderim penceresi (iş saatleri + hafta içi, TR saati) — pure-logic testleri.
 *
 * Referans tz: Europe/Istanbul = UTC+3 (DST yok). Doğrulanmış 2026 günleri:
 *   2026-05-29 Cuma (ISO 5), 2026-06-01 Pzt (1), 2026-06-06 Cmt (6), 2026-06-07 Paz (7).
 * UTC instant → +3 saat = TR yerel saati (ör. 06:30Z → 09:30 TR).
 */
import { describe, it, expect } from 'vitest';
import { isWithinSendWindow, parseTimeToMinutes } from '../send-window.js';

const TZ = 'Europe/Istanbul';
const START = '09:30:00';
const END = '17:30:00';
const WEEKDAYS = [1, 2, 3, 4, 5];
// UTC saatinden TR (UTC+3) yerel saatine kuran yardımcı: verilen TR saat/dakikayı UTC'ye çevirir.
const trAt = (isoDate: string, trHour: number, trMin = 0): Date =>
  new Date(`${isoDate}T${String(trHour - 3).padStart(2, '0')}:${String(trMin).padStart(2, '0')}:00Z`);

describe('parseTimeToMinutes', () => {
  it('"09:30:00" → 570', () => expect(parseTimeToMinutes('09:30:00')).toBe(570));
  it('"17:30" → 1050 (saniyesiz)', () => expect(parseTimeToMinutes('17:30')).toBe(1050));
  it('"00:00:00" → 0', () => expect(parseTimeToMinutes('00:00:00')).toBe(0));
  it('"23:59:59.123" → 1439 (fraksiyon)', () => expect(parseTimeToMinutes('23:59:59.123')).toBe(1439));
  it('null/sayı/bozuk → null', () => {
    expect(parseTimeToMinutes(null)).toBeNull();
    expect(parseTimeToMinutes(undefined)).toBeNull();
    expect(parseTimeToMinutes(930)).toBeNull();
    expect(parseTimeToMinutes('abc')).toBeNull();
    expect(parseTimeToMinutes('25:00')).toBeNull(); // saat > 23
    expect(parseTimeToMinutes('09:75')).toBeNull(); // dakika > 59
  });
});

describe('isWithinSendWindow', () => {
  it('hafta içi, pencere ortası (Cuma 12:00 TR) → true', () => {
    expect(isWithinSendWindow(trAt('2026-05-29', 12, 0), START, END, WEEKDAYS, TZ)).toBe(true);
  });

  it('hafta içi ama pencere öncesi (Cuma 09:00 TR) → false', () => {
    expect(isWithinSendWindow(trAt('2026-05-29', 9, 0), START, END, WEEKDAYS, TZ)).toBe(false);
  });

  it('hafta içi ama pencere sonrası (Cuma 18:00 TR) → false', () => {
    expect(isWithinSendWindow(trAt('2026-05-29', 18, 0), START, END, WEEKDAYS, TZ)).toBe(false);
  });

  it('tam başlangıç sınırı (09:30 TR) → true (dahil)', () => {
    expect(isWithinSendWindow(trAt('2026-05-29', 9, 30), START, END, WEEKDAYS, TZ)).toBe(true);
  });

  it('başlangıçtan 1 dk önce (09:29 TR) → false', () => {
    expect(isWithinSendWindow(trAt('2026-05-29', 9, 29), START, END, WEEKDAYS, TZ)).toBe(false);
  });

  it('tam bitiş sınırı (17:30 TR) → false (hariç, yarı-açık)', () => {
    expect(isWithinSendWindow(trAt('2026-05-29', 17, 30), START, END, WEEKDAYS, TZ)).toBe(false);
  });

  it('bitişten 1 dk önce (17:29 TR) → true', () => {
    expect(isWithinSendWindow(trAt('2026-05-29', 17, 29), START, END, WEEKDAYS, TZ)).toBe(true);
  });

  it('Cumartesi iş saati (12:00 TR) → false (gün dışı)', () => {
    expect(isWithinSendWindow(trAt('2026-06-06', 12, 0), START, END, WEEKDAYS, TZ)).toBe(false);
  });

  it('Pazar iş saati (12:00 TR) → false (gün dışı)', () => {
    expect(isWithinSendWindow(trAt('2026-06-07', 12, 0), START, END, WEEKDAYS, TZ)).toBe(false);
  });

  it('Pazartesi iş saati (12:00 TR) → true', () => {
    expect(isWithinSendWindow(trAt('2026-06-01', 12, 0), START, END, WEEKDAYS, TZ)).toBe(true);
  });

  it('tz day-rollover: Cuma 23:00Z = Cmt 02:00 TR → false (gün+saat dışı)', () => {
    // Hem gün (Cmt) hem saat (02:00) pencere dışı; UTC günü/saatine değil TR yereline bakılmalı.
    expect(isWithinSendWindow(new Date('2026-05-29T23:00:00Z'), START, END, WEEKDAYS, TZ)).toBe(false);
  });

  it('tz: server UTC olsa da TR saatine göre değerlendirir (Cuma 06:30Z = 09:30 TR) → true', () => {
    expect(isWithinSendWindow(new Date('2026-05-29T06:30:00Z'), START, END, WEEKDAYS, TZ)).toBe(true);
  });

  // --- fail-open: eksik/geçersiz config ilgili kısıtı atlar ---
  it('days boş → gün kısıtı yok (Cumartesi iş saatinde bile true)', () => {
    expect(isWithinSendWindow(trAt('2026-06-06', 12, 0), START, END, [], TZ)).toBe(true);
  });

  it('days null → gün kısıtı yok', () => {
    expect(isWithinSendWindow(trAt('2026-06-07', 12, 0), START, END, null, TZ)).toBe(true);
  });

  it('start/end null → saat kısıtı yok (hafta içi gece bile true)', () => {
    expect(isWithinSendWindow(trAt('2026-05-29', 3, 0), null, null, WEEKDAYS, TZ)).toBe(true);
  });

  it('ters aralık (end <= start) → saat kısıtı atlanır (fail-open)', () => {
    expect(isWithinSendWindow(trAt('2026-05-29', 3, 0), '17:30:00', '09:30:00', WEEKDAYS, TZ)).toBe(true);
  });

  it('geçersiz tz → true (fail-open)', () => {
    expect(isWithinSendWindow(trAt('2026-06-06', 12, 0), START, END, WEEKDAYS, 'Not/AZone')).toBe(true);
  });

  it('hafta içi + saat ok ama days sadece {6,7} → false (gün dışı)', () => {
    expect(isWithinSendWindow(trAt('2026-05-29', 12, 0), START, END, [6, 7], TZ)).toBe(false);
  });
});
