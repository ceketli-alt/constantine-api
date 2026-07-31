/**
 * mail/ — Singleton MailProvider erişimi (iki provider instance).
 *
 * Constantine iki ayrı Resend hesabı kullanır:
 *   - TRANSACTIONAL: digest, test mail, dashboard notifikasyonları
 *     domain: send.constantineyachts.com (verified, RESEND_API_KEY_TRANSACTIONAL)
 *   - OUTREACH: cold outreach campaign mesajları
 *     domain: constantineyachts.online (verify pending, RESEND_API_KEY_OUTREACH)
 *
 * Felsefe: cold outreach reputation'ı transactional'dan tamamen ayrı.
 *
 * Backward compat:
 *   - `mailProvider` = transactional (varsayılan, mevcut kodun tamamı bu)
 *   - Yeni kod: `mailProviderForKind('outreach')` ile outreach provider'ı al
 *
 * Provider switch (Resend → SendGrid vs):
 *   1. src/mail/sendgrid-adapter.ts yaz
 *   2. Buradaki `new ResendProvider(...)` satırını değiştir
 *   3. Geri kalan kod HİÇ değişmez
 */
import { ResendProvider } from './resend-adapter.js';
import type { MailProvider } from './types.js';

export type MailKind = 'transactional' | 'outreach';

const RESEND_BASE_URL = process.env.RESEND_BASE_URL ?? 'https://api.resend.com';

// İki ayrı Resend hesabı için ayrı key'ler.
// Backward compat: RESEND_API_KEY varsa transactional'a denk gelir.
const RESEND_KEY_TRANSACTIONAL =
  process.env.RESEND_API_KEY_TRANSACTIONAL ??
  process.env.RESEND_API_KEY ??
  '';

const RESEND_KEY_OUTREACH =
  process.env.RESEND_API_KEY_OUTREACH ??
  process.env.RESEND_API_KEY_TRANSACTIONAL ??  // fallback: tek hesap modu
  process.env.RESEND_API_KEY ??
  '';

// Warmup domainleri — her biri AYRI Resend hesabı (reputation izolasyonu, ücretsiz tier).
// Boş ise güvenli fallback aşağıda outreachProvider'a düşer (cy.online).
const RESEND_KEY_OUTREACH_BOAT = process.env.RESEND_API_KEY_OUTREACH_BOAT ?? '';
const RESEND_KEY_OUTREACH_YACHT = process.env.RESEND_API_KEY_OUTREACH_YACHT ?? '';

/** Transactional provider — digest, test mail, dashboard. Default. */
export const transactionalProvider: MailProvider = new ResendProvider(
  RESEND_KEY_TRANSACTIONAL,
  RESEND_BASE_URL,
);

/** Outreach provider — cold outreach campaign mesajları. constantineyachts.online (varsayılan). */
export const outreachProvider: MailProvider = new ResendProvider(
  RESEND_KEY_OUTREACH,
  RESEND_BASE_URL,
);

// Warmup domain provider'ları — ayrı Resend hesapları. Key yoksa cy.online'a güvenli fallback
// (yanlış key ile göndermektense bilinen-verified hesaptan gönder → sessiz bounce yerine tutarlı davranış).
const outreachProviderBoat: MailProvider = RESEND_KEY_OUTREACH_BOAT
  ? new ResendProvider(RESEND_KEY_OUTREACH_BOAT, RESEND_BASE_URL)
  : outreachProvider;
const outreachProviderYacht: MailProvider = RESEND_KEY_OUTREACH_YACHT
  ? new ResendProvider(RESEND_KEY_OUTREACH_YACHT, RESEND_BASE_URL)
  : outreachProvider;

/**
 * Sender domain → doğru Resend hesabı.
 * Her Resend key SADECE kendi domainini verified tanır; yanlış key → "domain is not verified" bounce.
 * Bu yüzden outreach gönderiminde provider'ı mail tipine DEĞİL, gönderen domaine göre seçiyoruz.
 * Bilinmeyen domain → varsayılan outreachProvider (cy.online).
 */
const OUTREACH_PROVIDER_BY_DOMAIN: Record<string, MailProvider> = {
  'constantineyachts.online': outreachProvider,
  'constantineboat.online': outreachProviderBoat,
  'constantineyacht.online': outreachProviderYacht,
};

/**
 * Outreach (kampanya) gönderiminde gönderen adrese göre doğru provider'ı verir.
 *   const provider = outreachProviderForSender('mert@constantineboat.online'); // → boat hesabı
 */
export function outreachProviderForSender(fromEmail: string): MailProvider {
  const domain = fromEmail.split('@')[1]?.toLowerCase().trim() ?? '';
  return OUTREACH_PROVIDER_BY_DOMAIN[domain] ?? outreachProvider;
}

/**
 * Backward-compat singleton — mevcut kodun çoğu bu kullanıyor.
 * Yeni kod `mailProviderForKind()` kullanmalı.
 */
export const mailProvider: MailProvider = transactionalProvider;

/**
 * Provider seçimi — mail tipi (transactional / outreach) bazında doğru hesap.
 *
 * Kullanım:
 *   const provider = mailProviderForKind('outreach');
 *   await provider.send({ ... });
 */
export function mailProviderForKind(kind: MailKind): MailProvider {
  return kind === 'outreach' ? outreachProvider : transactionalProvider;
}

// Re-export types for consumer convenience
export type {
  EventListFilter,
  MailEvent,
  MailEventType,
  MailProvider,
  MetricsDataPoint,
  MetricsFilter,
  MetricsRates,
  MetricsResult,
  MetricsTotals,
  MetricsWindow,
  SendAttachment,
  SendInput,
  SendResult,
} from './types.js';
