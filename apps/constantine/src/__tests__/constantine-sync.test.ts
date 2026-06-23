/**
 * Constantine çift-yön takvim senkronu — saf dönüşüm yardımcıları.
 * DB/Google'a dokunmaz; yalnız event↔booking eşleme mantığı.
 */
import { describe, it, expect } from 'vitest';
import {
  addDaysToDateStr,
  isCrmBlock,
  buildCrmBlockEvent,
  eventToIncomingDays,
  diffDays,
  clipDaysToWindow,
} from '../constantine-sync.js';
import type { CalendarEvent } from '../google.js';

describe('addDaysToDateStr', () => {
  it('basit +1', () => expect(addDaysToDateStr('2026-07-10', 1)).toBe('2026-07-11'));
  it('ay sınırı', () => expect(addDaysToDateStr('2026-07-31', 1)).toBe('2026-08-01'));
  it('yıl sınırı', () => expect(addDaysToDateStr('2026-12-31', 1)).toBe('2027-01-01'));
});

describe('isCrmBlock', () => {
  it('cy_sync=crm işaretli → true', () => {
    const ev = { id: 'x', start: {}, end: {}, extendedProperties: { private: { cy_sync: 'crm' } } } as CalendarEvent;
    expect(isCrmBlock(ev)).toBe(true);
  });
  it('işaretsiz event → false', () => {
    const ev = { id: 'x', start: {}, end: {} } as CalendarEvent;
    expect(isCrmBlock(ev)).toBe(false);
  });
  it('başka private prop → false', () => {
    const ev = { id: 'x', start: {}, end: {}, extendedProperties: { private: { foo: 'bar' } } } as CalendarEvent;
    expect(isCrmBlock(ev)).toBe(false);
  });
});

describe('buildCrmBlockEvent', () => {
  it('all-day Dolu blok + cy_sync işareti', () => {
    const ev = buildCrmBlockEvent('2026-07-10', 'bk-123');
    expect(ev.summary).toBe('Dolu');
    expect(ev.start.date).toBe('2026-07-10');
    expect(ev.end.date).toBe('2026-07-11'); // all-day end exclusive
    expect(ev.transparency).toBe('opaque');
    expect(ev.extendedProperties?.private?.cy_sync).toBe('crm');
    expect(ev.extendedProperties?.private?.booking_id).toBe('bk-123');
  });
  it('ürettiği blok isCrmBlock ile kendini tanır (round-trip)', () => {
    const ev = buildCrmBlockEvent('2026-07-10', 'bk-1') as unknown as CalendarEvent;
    expect(isCrmBlock(ev)).toBe(true);
  });
});

describe('eventToIncomingDays', () => {
  it('all-day tek gün → 1 satır', () => {
    const ev = { id: 'e', start: { date: '2026-07-10' }, end: { date: '2026-07-11' } } as CalendarEvent;
    expect(eventToIncomingDays(ev)).toEqual([{ date: '2026-07-10', start_time: null, duration_hours: null }]);
  });

  it('all-day çok gün → end exclusive, gün başına satır', () => {
    const ev = { id: 'e', start: { date: '2026-07-10' }, end: { date: '2026-07-13' } } as CalendarEvent;
    expect(eventToIncomingDays(ev)).toEqual([
      { date: '2026-07-10', start_time: null, duration_hours: null },
      { date: '2026-07-11', start_time: null, duration_hours: null },
      { date: '2026-07-12', start_time: null, duration_hours: null },
    ]);
  });

  it('all-day end yok → tek gün', () => {
    const ev = { id: 'e', start: { date: '2026-07-10' }, end: {} } as CalendarEvent;
    expect(eventToIncomingDays(ev)).toEqual([{ date: '2026-07-10', start_time: null, duration_hours: null }]);
  });

  it('all-day end==start (dejenere) → fallback tek gün', () => {
    const ev = { id: 'e', start: { date: '2026-07-10' }, end: { date: '2026-07-10' } } as CalendarEvent;
    expect(eventToIncomingDays(ev)).toEqual([{ date: '2026-07-10', start_time: null, duration_hours: null }]);
  });

  it('saatli event → tek gün + start_time + süre (Istanbul lokal)', () => {
    const ev = {
      id: 'e',
      start: { dateTime: '2026-07-10T10:00:00+03:00', timeZone: 'Europe/Istanbul' },
      end: { dateTime: '2026-07-10T14:00:00+03:00', timeZone: 'Europe/Istanbul' },
    } as CalendarEvent;
    expect(eventToIncomingDays(ev)).toEqual([{ date: '2026-07-10', start_time: '10:00', duration_hours: 4 }]);
  });

  it('saatli event, end yok/sıfır süre → duration_hours null', () => {
    const ev = {
      id: 'e',
      start: { dateTime: '2026-07-10T10:00:00+03:00', timeZone: 'Europe/Istanbul' },
      end: {},
    } as CalendarEvent;
    const out = eventToIncomingDays(ev);
    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe('2026-07-10');
    expect(out[0]!.start_time).toBe('10:00');
    expect(out[0]!.duration_hours).toBeNull();
  });
});

describe('diffDays (drift / eksik-gün reconcile)', () => {
  it('hiç değişiklik yok → boş', () => {
    expect(diffDays(['2026-07-10', '2026-07-11'], ['2026-07-10', '2026-07-11']))
      .toEqual({ toAdd: [], toCancel: [] });
  });
  it('yeni event (mevcut yok) → hepsi toAdd', () => {
    expect(diffDays(['2026-07-10', '2026-07-11'], []))
      .toEqual({ toAdd: ['2026-07-10', '2026-07-11'], toCancel: [] });
  });
  it('eksik gün onarımı → eksik olan toAdd, mevcutlar korunur', () => {
    expect(diffDays(['2026-07-10', '2026-07-11', '2026-07-12'], ['2026-07-10', '2026-07-12']))
      .toEqual({ toAdd: ['2026-07-11'], toCancel: [] });
  });
  it('tarih kaydı (drift) → eski toCancel + yeni toAdd', () => {
    expect(diffDays(['2026-07-27'], ['2026-07-25']))
      .toEqual({ toAdd: ['2026-07-27'], toCancel: ['2026-07-25'] });
  });
  it('event küçüldü → düşen gün toCancel', () => {
    expect(diffDays(['2026-07-10'], ['2026-07-10', '2026-07-11', '2026-07-12']))
      .toEqual({ toAdd: [], toCancel: ['2026-07-11', '2026-07-12'] });
  });
});

describe('clipDaysToWindow (güvenlik: ufuk kırpma)', () => {
  const rows = [
    { date: '2026-06-20', start_time: null, duration_hours: null },
    { date: '2026-06-22', start_time: null, duration_hours: null },
    { date: '2026-12-22', start_time: null, duration_hours: null },
  ];
  it('pencere içi günler kalır, dışındakiler düşer', () => {
    expect(clipDaysToWindow(rows, '2026-06-21', '2026-09-21').map((r) => r.date))
      .toEqual(['2026-06-22']);
  });
  it('sınırlar dahil (from/to inclusive)', () => {
    expect(clipDaysToWindow(rows, '2026-06-22', '2026-12-22').map((r) => r.date))
      .toEqual(['2026-06-22', '2026-12-22']);
  });
  it('hepsi pencere dışıysa boş', () => {
    expect(clipDaysToWindow(rows, '2027-01-01', '2027-06-01')).toEqual([]);
  });
});
