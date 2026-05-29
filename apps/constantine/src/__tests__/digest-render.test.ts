/**
 * digest-render pure formatting unit testleri.
 *
 * fmtDateLong/fmtDateShort defansif Date kabulü (postgres-js bazen Date object döner)
 * — bu fonksiyonlar private, render edilen ortak çıktıyı renderDigestByRole üzerinden
 * test etmek daha pahalı; bu yüzden bir renderer entry point seçip basit invariant'lar
 * doğruluyoruz.
 *
 * Public API: renderDigestByRole bir DigestData alır ve { subject, html, text } döner.
 * Subject formatında "🌅 Constantine — <kısa-tarih>" pattern'i fmtDateShort sonucunu içerir.
 */
import { describe, it, expect } from 'vitest';
import { renderDigestByRole } from '../digest-render.js';

describe('renderDigestByRole — defansif Date kabul ve format', () => {
  const minimalData = {
    user: { id: 'u1', email: 'test@x.com', full_name: 'Test User', role: 'super_admin' as const },
    boatsById: {},
    todayBookings: [],
    tomorrowBookings: [],
    todayTasks: [],
    overdueTasks: [],
    openBreakdowns: [],
    upcomingMaintenance: [],
    overdueUnpaidBookings: [],
    pendingApprovals: [],
    weekStats: undefined,
    monthlyFinancials: undefined,
    weeklyOccupancy: undefined,
  };

  it('renders without throwing for super_admin morning (empty data → empty branch)', () => {
    const r = renderDigestByRole({
      data: minimalData as any,
      weather: null,
      dateIso: '2026-05-26',
      tomorrowIso: '2026-05-27',
      variant: 'morning',
    });
    expect(r).toBeDefined();
    expect(r.subject).toBeTypeOf('string');
    // Tamamen boş data → empty branch tetiklenir
    expect(r.html).toMatch(/Bugün|Yarın|Boş|Constantine/);
    expect(r.text).toBeTypeOf('string');
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('handles tomorrowIso for evening variant', () => {
    const r = renderDigestByRole({
      data: minimalData as any,
      weather: null,
      dateIso: '2026-05-26',
      tomorrowIso: '2026-05-27',
      variant: 'evening',
    });
    expect(r.subject).toBeTypeOf('string');
    // Evening variant subject "Yarin"a referans verir
    expect(r.html.length).toBeGreaterThan(0);
  });

  it('formats Turkish date pattern "26 May" in subject (fmtDateShort)', () => {
    const r = renderDigestByRole({
      data: minimalData as any,
      weather: null,
      dateIso: '2026-05-26',
      tomorrowIso: '2026-05-27',
      variant: 'morning',
    });
    // 26 May 2026 → Salı (Tuesday). fmtDateShort: "26 May Sal"
    expect(r.subject).toContain('26 May');
  });

  it('does not throw on dateIso missing day parts (defansif)', () => {
    // Eğer caller bir şekilde "2026-05" gibi eksik string verirse, fmtDate helper
    // crash etmemeli — orijinal string'i geri vermeli (defansif S5/P1 fix).
    expect(() => {
      renderDigestByRole({
        data: minimalData as any,
        weather: null,
        dateIso: '2026-05', // intentionally truncated
        tomorrowIso: '2026-05-27',
        variant: 'morning',
      });
    }).not.toThrow();
  });
});
