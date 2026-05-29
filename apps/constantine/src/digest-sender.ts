/**
 * digest-sender.ts — Digest mail gönderim helper'ı (provider-agnostic).
 *
 * Hem `cron-daily-digest.ts` (Sales) hem `daily-digest.ts` (Ops) kullanır.
 * Idempotency / lead_id ile bağlı değil — simple system mail.
 *
 * Mimari: `mailProvider` (src/mail/) — Resend bağımlılığı tek bir adapter'da soyutlu.
 * Provider değişimi için bu dosya HİÇ değişmez.
 */
import { mailProvider } from './mail/index.js';

export interface DigestSendInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  senderEmail: string;            // e.g. 'ops@send.constantineyachts.com'
  senderName: string;             // e.g. 'Constantine Operasyon'
  replyTo?: string;
  tags?: Array<{ name: string; value: string }>;
}

export interface DigestSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export async function sendDigestViaResend(input: DigestSendInput): Promise<DigestSendResult> {
  const result = await mailProvider.send({
    from: `${input.senderName} <${input.senderEmail}>`,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo ?? 'mert@constantineyachts.com',
    tags: input.tags ?? [],
  });
  return {
    ok: result.ok,
    messageId: result.messageId,
    error: result.error,
  };
}
