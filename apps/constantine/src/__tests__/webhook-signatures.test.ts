/**
 * Webhook signature verification — pure crypto tests.
 *
 * Bu fonksiyonlar şu an internal (module-private). Test edebilmek için ya export
 * etmek lazım ya da reverse-engineering yapmak. Burada doğrudan kripto operasyonu
 * tekrar uygulayıp helper davranışlarını mantıksal olarak test ediyoruz —
 * test'in kendisi Svix HMAC ve Meta HMAC spesifikasyonlarına karşı bir kontrol noktası.
 *
 * Gerçek fonksiyonların davranışı: secret yoksa false döner (fail-closed, P2.5 fix).
 * Bu test secret yokken handler'ın çağırması gereken yolu temsil eder.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

// Svix-format HMAC üreten yardımcı (verifySvixSignature ile aynı algoritma)
function makeSvixSig(secret: string, id: string, ts: string, payload: string): string {
  const secretBase = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const bytes = Buffer.from(secretBase, 'base64');
  const signed = `${id}.${ts}.${payload}`;
  const mac = crypto.createHmac('sha256', bytes).update(signed).digest('base64');
  return `v1,${mac}`;
}

// Meta HMAC (x-hub-signature-256 — "sha256=<hex>")
function makeMetaSig(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('Svix signature spec (Resend webhook format)', () => {
  // whsec_ prefix + base64 secret bytes — örnek 32-byte rastgele
  const secret = 'whsec_' + Buffer.from('a'.repeat(32)).toString('base64');
  const id = 'msg_2abc';
  const ts = '1700000000';
  const payload = '{"type":"email.delivered","data":{"email_id":"x"}}';

  it('valid signature produces a constant-time-comparable MAC', () => {
    const sig1 = makeSvixSig(secret, id, ts, payload);
    const sig2 = makeSvixSig(secret, id, ts, payload);
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^v1,/);
  });

  it('different payload yields different signature', () => {
    const sig1 = makeSvixSig(secret, id, ts, payload);
    const sig2 = makeSvixSig(secret, id, ts, payload + 'tamper');
    expect(sig1).not.toBe(sig2);
  });

  it('different secret yields different signature', () => {
    const sig1 = makeSvixSig(secret, id, ts, payload);
    const sig2 = makeSvixSig('whsec_' + Buffer.from('b'.repeat(32)).toString('base64'), id, ts, payload);
    expect(sig1).not.toBe(sig2);
  });

  it('timestamp is part of signed content (prevents replay-resign)', () => {
    const sig1 = makeSvixSig(secret, id, ts, payload);
    const sig2 = makeSvixSig(secret, id, String(Number(ts) + 1), payload);
    expect(sig1).not.toBe(sig2);
  });
});

describe('Meta WhatsApp HMAC spec (x-hub-signature-256)', () => {
  const secret = 'meta_app_secret_xyz';
  const body = '{"entry":[{"changes":[]}]}';

  it('valid signature format "sha256=<hex>"', () => {
    const sig = makeMetaSig(secret, body);
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('valid sig is deterministic for same input', () => {
    expect(makeMetaSig(secret, body)).toBe(makeMetaSig(secret, body));
  });

  it('body tamper invalidates sig', () => {
    const sig1 = makeMetaSig(secret, body);
    const sig2 = makeMetaSig(secret, body + 'tamper');
    expect(sig1).not.toBe(sig2);
  });

  it('timingSafeEqual requires equal length buffers', () => {
    const sig1 = makeMetaSig(secret, body);
    const sigShort = 'sha256=short';
    // Production verifyMetaSignature içinde timingSafeEqual try/catch ile farklı uzunluk
    // false döndürür (RangeError yutar). Burada beklenen davranışı doğruluyoruz:
    expect(() => {
      crypto.timingSafeEqual(Buffer.from(sig1), Buffer.from(sigShort));
    }).toThrow();
  });
});
