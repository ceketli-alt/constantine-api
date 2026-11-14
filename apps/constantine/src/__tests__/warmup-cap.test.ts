/**
 * capForDay — kutu sayısına göre ölçeklenen warmup tavanı (21 Eki 2026).
 * Eskiden "2 kutu" sabitti: 6 kutulu kampanya bile günde 50'de kilitleniyordu.
 */
import { describe, it, expect } from 'vitest';
import { capForDay, mailboxCount } from '../cron-warmup-tick.js';

describe('capForDay', () => {
  it('varsayılan (2 kutu) eski eğriyle birebir aynı — mevcut kampanyalar etkilenmez', () => {
    expect([1, 3, 4, 7, 8, 14, 15, 60].map((d) => capForDay(d))).toEqual([20, 20, 30, 30, 40, 40, 50, 50]);
  });
  it('6 kutu: kararlı durumda kutu başına 25 → 150', () => {
    expect(capForDay(30, 6)).toBe(150);
    expect(capForDay(1, 6)).toBe(60);
  });
  it('tek kutu: kutu başına tavanın üstüne çıkmaz', () => {
    expect(capForDay(30, 1)).toBe(25);
  });
  it('geçersiz kutu sayısı en az 1 sayılır', () => {
    expect(capForDay(30, 0)).toBe(25);
  });
});

describe('mailboxCount', () => {
  it('havuz boyu', () => {
    expect(mailboxCount(['a@x.com', 'b@y.com', 'c@z.com'])).toBe(3);
  });
  it('havuz yoksa ya da bozuksa 1', () => {
    expect(mailboxCount(null)).toBe(1);
    expect(mailboxCount([])).toBe(1);
    expect(mailboxCount(['bozuk'])).toBe(1);
  });
});
