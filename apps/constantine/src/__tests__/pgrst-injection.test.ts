/**
 * SQL enjeksiyonu regresyon testleri — `is.` operatörü.
 *
 * 2026-08-19 denetiminde bulundu: `buildSingleFilter` içindeki `is` dalı, switch'teki
 * TEK yerdi ki kullanıcı değerini parametre yerine doğrudan SQL METNİNE basıyordu.
 * Ölçülen çıktı (izole ayrıştırıcı koşusu, DB'ye dokunulmadan):
 *
 *   ?id=is.null;SELECT 1;--
 *   → SELECT * FROM "agency_tokens" WHERE "id" IS null;SELECT 1;--     params=[]
 *
 * params boş kaldığı için postgres.js simple protocol'e düşüyor ve o protokol
 * zincirlenmiş komutlara izin veriyor. DB rolü tabloların sahibi + BYPASSRLS olduğu
 * için etki tam veritabanı kontrolüydü.
 *
 * Bu testler iki şeyi kilitler:
 *  1) `is` operandı katı beyaz listede (null/true/false/unknown) — başka her şey REDDEDİLİR.
 *  2) Hiçbir filtre operatörü kullanıcı değerini SQL metnine sızdırmaz; değer params'a gider.
 */
import { describe, it, expect } from 'vitest';
import { parseQuery, buildSelectSQL, buildCountSQL } from '../pgrst-parser.js';

function build(qs: string, table = 'bookings') {
  const pq = parseQuery(new URL(`https://api.test/rest/v1/${table}?${qs}`));
  const params: unknown[] = [];
  const { sqlText } = buildSelectSQL(table, pq, params);
  return { sqlText, params };
}

describe('is. operatörü — beyaz liste', () => {
  it('is.null → IS NULL', () => {
    expect(build('id=is.null').sqlText).toContain('"id" IS NULL');
  });

  it('is.true / is.false → IS TRUE / IS FALSE', () => {
    expect(build('active=is.true').sqlText).toContain('"active" IS TRUE');
    expect(build('active=is.false').sqlText).toContain('"active" IS FALSE');
  });

  it('not.is.null → NOT (... IS NULL)', () => {
    expect(build('contact=not.is.null').sqlText).toContain('NOT ("contact" IS NULL)');
  });

  it('ZİNCİRLENMİŞ KOMUT reddedilir', () => {
    expect(() => build('id=is.null;SELECT 1;--')).toThrow(/is operatörü/);
  });

  it('TAUTOLOJİ (OR 1=1) reddedilir', () => {
    expect(() => build('id=is.null OR 1=1')).toThrow(/is operatörü/);
  });

  it('alt sorgu enjeksiyonu reddedilir', () => {
    expect(() => build('id=is.null OR id IN (SELECT id FROM profiles)')).toThrow(/is operatörü/);
  });

  it('rastgele metin reddedilir', () => {
    expect(() => build('id=is.yes')).toThrow(/is operatörü/);
    expect(() => build('id=is.1')).toThrow(/is operatörü/);
  });

  it('count sorgusunda da aynı koruma var', () => {
    const pq = parseQuery(new URL('https://api.test/rest/v1/bookings?id=is.null;DROP TABLE bookings;--'));
    expect(() => buildCountSQL('bookings', pq, [])).toThrow(/is operatörü/);
  });
});

describe('genel: kullanıcı değeri SQL metnine sızmaz', () => {
  const payload = "x'; DROP TABLE bookings; --";

  it.each([
    ['eq', `guest_name=eq.${payload}`],
    ['neq', `guest_name=neq.${payload}`],
    ['like', `guest_name=like.${payload}`],
    ['ilike', `guest_name=ilike.${payload}`],
    ['gt', `date=gt.${payload}`],
    ['lte', `date=lte.${payload}`],
    ['in', `id=in.(${payload})`],
    ['fts', `guest_name=fts.${payload}`],
  ])('%s operatöründe değer parametreye gider', (_op, qs) => {
    const { sqlText, params } = build(qs);
    // Kullanıcı verisinin HİÇBİR parçası SQL metnine girmemeli.
    // (Metindeki tek tırnaklar koda gömülü sabitlerden olabilir — ör. fts'teki
    // `to_tsvector('simple', ...)` — o yüzden tırnak değil, YÜKÜN KENDİSİ aranır.)
    expect(sqlText).not.toContain('DROP TABLE');
    expect(sqlText).not.toContain('bookings; --');
    expect(sqlText.includes(payload)).toBe(false);
    expect(params.length).toBeGreaterThan(0);
    // Yük, parametrelerden birinde bozulmadan durmalı (yani gerçekten oraya gitti)
    expect(params.some((p) => String(p).includes('DROP TABLE'))).toBe(true);
  });

  it('bilinmeyen operatör de parametrelenir (eşitlik gibi davranır)', () => {
    const { sqlText, params } = build(`guest_name=bilinmeyenop.${payload}`);
    expect(sqlText).not.toContain('DROP TABLE');
    expect(params.length).toBeGreaterThan(0);
  });

  it('geçersiz kolon adı reddedilir (identifier beyaz listesi)', () => {
    expect(() => build('id;DROP TABLE bookings=eq.1')).toThrow(/identifier/i);
  });

  it('sıralama yönü yalnız ASC/DESC üretir', () => {
    const { sqlText } = build('order=date.desc;DROP TABLE bookings');
    expect(sqlText).not.toContain('DROP');
  });
});
