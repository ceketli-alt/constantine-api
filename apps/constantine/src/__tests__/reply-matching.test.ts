/**
 * Cevap eşleştirme yardımcıları + toplayıcı nabzı (8 Eki 2026).
 *
 * Neden: cevap toplayıcı leadi yalnızca birebir adresten arıyordu. info@acente.com'a
 * yazdık, ahmet@acente.com cevap verdi → cevap atılıyordu, In-Reply-To'ya hiç bakılmıyordu.
 * SQL kısmı veritabanına bağlı; burada saf mantık test edilir.
 */
import { describe, it, expect } from 'vitest';
import { headerRefIds, isWarmupTraffic, isOwnAddress } from '../email-inbound.js';
import { recordHeartbeat, HEARTBEAT_PREFIX } from '../mailcow-reply-poller.js';

describe('headerRefIds', () => {
  it('In-Reply-To tek başına', () => {
    expect(headerRefIds('abc@mail.x', '')).toEqual(['abc@mail.x']);
  });

  it('References içindeki köşeli parantezli kimlikleri ayıklar', () => {
    expect(headerRefIds(null, '<a@x> <b@y>')).toEqual(['a@x', 'b@y']);
  });

  it('In-Reply-To ile References aynı kimliği taşırsa tekilleştirir', () => {
    expect(headerRefIds('a@x', '<a@x> <b@y>')).toEqual(['a@x', 'b@y']);
  });

  it('başlık yoksa boş liste (yeni mail, cevap değil)', () => {
    expect(headerRefIds(null, null)).toEqual([]);
    expect(headerRefIds(null, undefined)).toEqual([]);
    expect(headerRefIds(null, '   ')).toEqual([]);
  });
});

describe('isWarmupTraffic', () => {
  it('Instantly warmup etiketi konudaysa warmup sayılır', () => {
    expect(isWarmupTraffic('Re: our list | H3F6MZ7 GCDQP58')).toBe(true);
  });

  it('gerçek bir acente cevabı warmup DEĞİL', () => {
    expect(isWarmupTraffic('Re: Bu kış gruplarınız için Boğaz')).toBe(false);
    expect(isWarmupTraffic('YNT: Kış sezonunda gruplarınız için Boğaz')).toBe(false);
  });

  it('boş konu warmup değil (eşleşmeyen listesine düşsün, kaybolmasın)', () => {
    expect(isWarmupTraffic('')).toBe(false);
    expect(isWarmupTraffic(null)).toBe(false);
  });
});

describe('isOwnAddress', () => {
  it('kendi gönderici alan adlarımız müşteri sayılmaz', () => {
    expect(isOwnAddress('mert@constantineyachts.online')).toBe(true);
    expect(isOwnAddress('Tanitim@ConstantineBoat.online')).toBe(true);
  });
  it('acente adresi kendi adresimiz değil', () => {
    expect(isOwnAddress('info@kuzentur.com')).toBe(false);
    expect(isOwnAddress('')).toBe(false);
  });
});

describe('recordHeartbeat', () => {
  function fakeSql() {
    const calls: { text: string; values: unknown[] }[] = [];
    const fn: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve([]);
    };
    return { fn, calls };
  }

  it('nabzı app_config anahtarına JSON olarak yazar', async () => {
    const { fn, calls } = fakeSql();
    await recordHeartbeat(fn, 'mailcow', {
      at: '2026-10-08T10:00:00.000Z', ok_mailboxes: 6, total_mailboxes: 6, last_error: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('INSERT INTO app_config');
    expect(calls[0]!.values[0]).toBe(HEARTBEAT_PREFIX + 'mailcow');
    expect(JSON.parse(String(calls[0]!.values[1]))).toMatchObject({ ok_mailboxes: 6, total_mailboxes: 6 });
  });

  it('kutuların bir kısmı hata verdiyse bunu kaydeder (26 Eyl sertifika olayı)', async () => {
    const { fn, calls } = fakeSql();
    await recordHeartbeat(fn, 'mailcow', {
      at: '2026-10-08T10:00:00.000Z', ok_mailboxes: 0, total_mailboxes: 6,
      last_error: 'mert@cy.online: certificate has expired',
    });
    const v = JSON.parse(String(calls[0]!.values[1]));
    expect(v.ok_mailboxes).toBe(0);
    expect(v.last_error).toContain('certificate');
  });

  it('veritabanı hatasında throw etmez — nabız yazılamadı diye toplama durmamalı', async () => {
    const failing: any = () => Promise.reject(new Error('db down'));
    await expect(recordHeartbeat(failing, 'mailcow', {
      at: 'x', ok_mailboxes: 1, total_mailboxes: 1, last_error: null,
    })).resolves.toBeUndefined();
  });
});
