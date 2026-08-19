/**
 * Anonim (giriş yapmamış) istemci hangi tabloları okuyabilir?
 *
 * Regresyon kaynağı (2026-08-19 güvenlik denetimi): `agency_tokens` hem
 * ANON_READ_TABLES hem PUBLIC_TABLES_VIEW listesindeydi. Bu tablonun SATIRLARI
 * acente portalının tek kimlik bilgisi; sonuç olarak
 *   curl https://api.constantineyachts.com/rest/v1/agency_tokens
 * internetteki herkese 7 adet süresiz token'ı düz metin döndürüyordu.
 *
 * Bu test listeyi kilitler: anon okuma yalnız gerçekten herkese açık olabilecek
 * veriler için olmalı. Listeye tablo eklemek bilinçli bir karar olmalı.
 */
import { describe, it, expect } from 'vitest';
import { checkTableAccess } from '../middleware.js';

const AUTHED = { userId: 'u1', role: 'partner', email: 'x@y.z' } as never;

describe('anon tablo erişimi', () => {
  it('agency_tokens anonim OKUNAMAZ (kimlik bilgisi sızdırır)', () => {
    expect(checkTableAccess('agency_tokens', 'read').ok).toBe(false);
  });

  it('agency_tokens anonim YAZILAMAZ', () => {
    expect(checkTableAccess('agency_tokens', 'write').ok).toBe(false);
  });

  it('giriş yapmış kullanıcı agency_tokens okuyabilir (Ayarlar → Acenteler paneli)', () => {
    expect(checkTableAccess('agency_tokens', 'read', AUTHED).ok).toBe(true);
  });

  it('public_boats anonim okunabilir — kasıtlı olarak herkese açık', () => {
    expect(checkTableAccess('public_boats', 'read').ok).toBe(true);
  });

  it('hassas tablolar anonim okunamaz', () => {
    for (const t of ['bookings', 'profiles', 'leads', 'expenses', 'channels', 'boat_assignments']) {
      expect(checkTableAccess(t, 'read').ok, `${t} anon okunabilir olmamalı`).toBe(false);
    }
  });

  it('anon YAZMA hiçbir tabloda serbest değil — public_boats dahil', () => {
    expect(checkTableAccess('public_boats', 'write').ok).toBe(false);
  });
});
