import { describe, it, expect, beforeAll } from 'vitest';

/**
 * DATE kolonları (OID 1082) REST'e düz 'YYYY-MM-DD' gitmeli — PostgREST ile birebir.
 * Regresyon: postgres-js varsayılanı DATE'i JS Date'e çevirip '…T00:00:00.000Z' bastırıyordu;
 * <input type="date"> bunu BOŞ gösteriyor, `due_date === today` eşitlikleri hiç tutmuyordu
 * (6 Eki 2026). TIMESTAMP(TZ) Date kalmalı (ISO'ya o çevrilir).
 */
let parsers: Record<number, ((x: string) => unknown) | undefined>;
/** OID için ayrıştırıcı — yoksa test açıkça düşsün (noUncheckedIndexedAccess). */
function parse(oid: number, raw: string): unknown {
  const fn = parsers[oid];
  if (!fn) throw new Error(`OID ${oid} için parser yok`);
  return fn(raw);
}
beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test'; // bağlanmaz, sadece seçenekleri kurar
  const { sql } = await import('../db.js');
  parsers = (sql as unknown as { options: { parsers: typeof parsers } }).options.parsers;
});

describe('db.ts tarih ayrıştırma', () => {
  it('DATE (1082) düz string kalır', () => {
    expect(parse(1082, '2026-09-15')).toBe('2026-09-15');
  });
  it('TIMESTAMPTZ (1184) ve TIMESTAMP (1114) Date olur', () => {
    const ts = parse(1184, '2026-09-15T10:00:00+03:00');
    expect(ts).toBeInstanceOf(Date);
    expect((ts as Date).toISOString()).toBe('2026-09-15T07:00:00.000Z');
    expect(parse(1114, '2026-09-15 10:00:00')).toBeInstanceOf(Date);
  });
  it('numeric hâlâ number', () => {
    expect(parse(1700, '12.50')).toBe(12.5);
  });
});
