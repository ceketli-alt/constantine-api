/**
 * Concierge (v3.3) saf katman testleri — Claude'suz, deterministik.
 * normalizeParse: Haiku çıktısını doğrular/sınırlar/default uygular (güvenlik ağı).
 * Prompt builder'lar: bugün + dil + "uydurma yasak" içeriği.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeParse,
  buildParseSystemPrompt,
  buildNarrateSystemPrompt,
  CONCIERGE_DEFAULT_START,
  CONCIERGE_DEFAULT_DURATION,
} from '../agency-concierge.js';

const TODAY = '2026-06-14';

describe('normalizeParse — geçerli arama', () => {
  it('tüm alanlar verilmişse aynen geçirir (default uygulanmaz)', () => {
    const r = normalizeParse(
      { intent: 'search', date: '2026-06-20', start_time: '19:00', duration_hours: 3, guests: 8, message: null },
      TODAY,
    );
    expect(r.intent).toBe('search');
    expect(r.parsed).toEqual({ date: '2026-06-20', start_time: '19:00', duration_hours: 3, guests: 8 });
  });

  it('bugün geçerli (diff 0)', () => {
    const r = normalizeParse({ intent: 'search', date: TODAY, start_time: '12:00', duration_hours: 4 }, TODAY);
    expect(r.intent).toBe('search');
    expect(r.parsed.date).toBe(TODAY);
  });

  it('start_time yoksa default 14:00', () => {
    const r = normalizeParse({ intent: 'search', date: '2026-06-20', duration_hours: 3 }, TODAY);
    expect(r.parsed.start_time).toBe(CONCIERGE_DEFAULT_START);
    expect(r.parsed.start_time).toBe('14:00');
  });

  it('duration yoksa default 4', () => {
    const r = normalizeParse({ intent: 'search', date: '2026-06-20', start_time: '10:00' }, TODAY);
    expect(r.parsed.duration_hours).toBe(CONCIERGE_DEFAULT_DURATION);
    expect(r.parsed.duration_hours).toBe(4);
  });

  it('gece turu 23:00 geçerli', () => {
    const r = normalizeParse({ intent: 'search', date: '2026-06-20', start_time: '23:00', duration_hours: 2 }, TODAY);
    expect(r.parsed.start_time).toBe('23:00');
  });
});

describe('normalizeParse — sınır/clamp', () => {
  it('start_time aralık dışı (02:00) → default', () => {
    const r = normalizeParse({ intent: 'search', date: '2026-06-20', start_time: '02:00', duration_hours: 3 }, TODAY);
    expect(r.parsed.start_time).toBe('14:00');
  });

  it('duration 20 → 12, 0.1 → 0.5', () => {
    expect(normalizeParse({ intent: 'search', date: '2026-06-20', duration_hours: 20 }, TODAY).parsed.duration_hours).toBe(12);
    expect(normalizeParse({ intent: 'search', date: '2026-06-20', duration_hours: 0.1 }, TODAY).parsed.duration_hours).toBe(0.5);
  });

  it('guests: 8→8, 0→null, 12.7→13, negatif→null, devasa→500', () => {
    expect(normalizeParse({ intent: 'search', date: '2026-06-20', guests: 8 }, TODAY).parsed.guests).toBe(8);
    expect(normalizeParse({ intent: 'search', date: '2026-06-20', guests: 0 }, TODAY).parsed.guests).toBeNull();
    expect(normalizeParse({ intent: 'search', date: '2026-06-20', guests: 12.7 }, TODAY).parsed.guests).toBe(13);
    expect(normalizeParse({ intent: 'search', date: '2026-06-20', guests: -5 }, TODAY).parsed.guests).toBeNull();
    expect(normalizeParse({ intent: 'search', date: '2026-06-20', guests: 10000 }, TODAY).parsed.guests).toBe(500);
  });
});

describe('normalizeParse — tarih güvenliği → unclear', () => {
  it('geçmiş tarih → unclear', () => {
    const r = normalizeParse({ intent: 'search', date: '2026-06-13', start_time: '12:00', duration_hours: 3 }, TODAY);
    expect(r.intent).toBe('unclear');
  });

  it('60 günden uzak → unclear', () => {
    const r = normalizeParse({ intent: 'search', date: '2026-09-20', start_time: '12:00', duration_hours: 3 }, TODAY);
    expect(r.intent).toBe('unclear');
  });

  it('60. gün sınırı dahil → search', () => {
    const r = normalizeParse({ intent: 'search', date: '2026-08-13', start_time: '12:00', duration_hours: 3 }, TODAY);
    expect(r.intent).toBe('search');
  });

  it('hatalı tarih formatı (2026/06/20) → unclear', () => {
    const r = normalizeParse({ intent: 'search', date: '2026/06/20' }, TODAY);
    expect(r.intent).toBe('unclear');
  });
});

describe('normalizeParse — unclear / bozuk girdi', () => {
  it("LLM intent='unclear' + message korunur", () => {
    const r = normalizeParse({ intent: 'unclear', date: null, message: 'Hangi tarih?' }, TODAY);
    expect(r.intent).toBe('unclear');
    expect(r.message).toBe('Hangi tarih?');
  });

  it('null/string/garbage → güvenli unclear', () => {
    expect(normalizeParse(null, TODAY).intent).toBe('unclear');
    expect(normalizeParse('boom', TODAY).intent).toBe('unclear');
    expect(normalizeParse(42, TODAY).intent).toBe('unclear');
    expect(normalizeParse({}, TODAY).intent).toBe('unclear');
  });

  it('intent=search ama tarih yok → unclear', () => {
    const r = normalizeParse({ intent: 'search', date: null, start_time: '12:00' }, TODAY);
    expect(r.intent).toBe('unclear');
  });

  it('message 300 karaktere kırpılır', () => {
    const long = 'x'.repeat(500);
    const r = normalizeParse({ intent: 'unclear', message: long }, TODAY);
    expect(r.message!.length).toBe(300);
  });
});

describe('prompt builders', () => {
  it('parse prompt bugünü ve dili içerir', () => {
    const p = buildParseSystemPrompt(TODAY, 'tr');
    expect(p).toContain(TODAY);
    expect(p).toContain('Turkish');
  });

  it('narrate prompt dil + uydurma yasağı içerir', () => {
    const p = buildNarrateSystemPrompt('en');
    expect(p).toContain('English');
    expect(p).toContain('NEVER invent');
  });
});
