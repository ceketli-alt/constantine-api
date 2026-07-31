/**
 * Resend webhook endpoint — /functions/v1/email-webhook
 *
 * Resend Dashboard → Webhooks → Add Endpoint:
 *   URL: https://api.constantineyachts.com/functions/v1/email-webhook
 *   Events: delivered, opened, clicked, bounced, complained, failed
 *
 * Resend her webhook'u svix-signature header'ı ile imzalar.
 * Bu modül imzayı verify eder + Postgres'te email_events tablosuna yazar.
 *
 * Şema (constantine.email_events):
 *   id uuid PK
 *   email_message_id uuid FK email_messages
 *   event_type text  (delivered/opened/clicked/bounced/complained/failed)
 *   created_at timestamptz
 *   payload jsonb  (Resend'in tam payload'ı)
 */
import type { Context } from 'hono';
import crypto from 'node:crypto';
import { sql } from './db.js';

// Her Resend hesabının KENDİ svix imza secret'ı var (cy.online + boat + yacht warmup hesapları).
// Gelen webhook'ta hangi hesaptan geldiği bilgisi yok → imza tüm secret'lara karşı denenir.
const RESEND_WEBHOOK_SECRETS = [
  process.env.RESEND_WEBHOOK_SECRET,
  process.env.RESEND_WEBHOOK_SECRET_BOAT,
  process.env.RESEND_WEBHOOK_SECRET_YACHT,
].filter((s): s is string => typeof s === 'string' && s.startsWith('whsec_'));

/**
 * Resend / Svix HMAC-SHA256 signature verification
 * Format: "v1,<base64>"  multiple separated by space
 */
function verifySvixSignature(payload: string, headers: { id: string; timestamp: string; signature: string }, secret: string): boolean {
  // Fail closed — caller secret'ı pre-validate eder, buraya boş gelmemeli.
  if (!secret || !secret.startsWith('whsec_')) return false;
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const secretBytes = Buffer.from(secret.replace('whsec_', ''), 'base64');
  const signedContent = `${headers.id}.${headers.timestamp}.${payload}`;
  const computed = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  // Header birden çok sig içerebilir ("v1,sigA v1,sigB")
  const sigs = headers.signature.split(' ').map((s) => s.trim().replace(/^v1,/, ''));
  return sigs.some((s) => {
    try { return crypto.timingSafeEqual(Buffer.from(s), Buffer.from(computed)); } catch { return false; }
  });
}

const EVENT_TYPE_MAP: Record<string, string> = {
  'email.sent':       'sent',
  'email.delivered':  'delivered',
  'email.delivery_delayed': 'delivery_delayed',
  'email.opened':     'opened',
  'email.clicked':    'clicked',
  'email.bounced':    'bounced',
  'email.complained': 'complained',
  'email.failed':     'failed',
};

/**
 * email_event_type enum'unun KABUL ETTİĞİ değerler (sprint_2'de bilinçli dar tutuldu).
 * Resend bunların DIŞINDA da event yollar (email.sent / email.delivery_delayed /
 * email.failed) — bunlar email_events'e YAZILMAZ: enum dışı oldukları için
 * `::email_event_type` cast'i hata atar (önceden INSERT patlıyor → 500 → Resend retry).
 * Side-effect'leri de yok ('sent' zaten email_messages.sent_at'te; 'failed'/'delivery_delayed'
 * send-side, ayrı izleniyor) → sadece 200 ack döneriz. Bu liste DB enum'uyla BİREBİR
 * olmalı (drift guard: scripts/test-email-event-enum.mjs).
 */
export const PERSISTED_EVENT_TYPES = ['delivered', 'opened', 'clicked', 'bounced', 'complained', 'replied'] as const;

export async function handleResendWebhook(c: Context): Promise<Response> {
  const raw = await c.req.text();
  const svixId = c.req.header('svix-id') ?? '';
  const svixTimestamp = c.req.header('svix-timestamp') ?? '';
  const svixSignature = c.req.header('svix-signature') ?? '';

  if (RESEND_WEBHOOK_SECRETS.length === 0) {
    console.error('[email-webhook] RESEND_WEBHOOK_SECRET* not configured — rejecting webhook (fail-closed)');
    return c.json({ error: 'webhook_not_configured' }, 503);
  }
  const ok = RESEND_WEBHOOK_SECRETS.some((secret) =>
    verifySvixSignature(raw, { id: svixId, timestamp: svixTimestamp, signature: svixSignature }, secret),
  );
  if (!ok) {
    console.warn('[email-webhook] Invalid signature', { svixId });
    return c.json({ error: 'invalid_signature' }, 401);
  }

  let body: any;
  try { body = JSON.parse(raw); } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const eventType = EVENT_TYPE_MAP[body?.type] ?? body?.type ?? 'unknown';
  const resendMessageId = body?.data?.email_id ?? body?.data?.id ?? null;
  const recipientEmail = (body?.data?.to ?? [])[0] ?? null;

  try {
    // email_messages'ta resend_message_id eşleşeni bul
    let messageId: string | null = null;
    let lookupMethod = 'none';
    if (resendMessageId) {
      const m = await sql`SELECT id FROM email_messages WHERE resend_message_id = ${resendMessageId} LIMIT 1`;
      messageId = m[0]?.id ?? null;
      if (messageId) lookupMethod = 'resend_id';
    }
    // Fallback 1: outbound recipient + son 7 gün (resend_id drift için)
    if (!messageId && recipientEmail) {
      const fb = await sql`
        SELECT id FROM email_messages
        WHERE direction='outbound'
          AND lower(to_email) = lower(${recipientEmail})
          AND sent_at > now() - interval '7 days'
        ORDER BY sent_at DESC NULLS LAST
        LIMIT 1
      `;
      if (fb[0]?.id) {
        messageId = fb[0].id;
        lookupMethod = 'recipient+date';
        console.log(`[email-webhook] resend_id=${resendMessageId} eşleşmedi → recipient+date ile fallback bulundu: ${messageId} (${recipientEmail})`);
      }
    }

    if (messageId && (PERSISTED_EVENT_TYPES as readonly string[]).includes(eventType)) {
      // Eşleşen message + enum-geçerli tip → event kaydet (FK NOT NULL + email_event_type cast)
      await sql`
        INSERT INTO email_events (message_id, event_type, raw_payload, occurred_at)
        VALUES (${messageId}, ${eventType}::email_event_type, ${body}::jsonb, now())
      `;
      // email_messages timestamp güncelle
      const stampCol = ({
        'delivered': 'delivered_at',
        'opened':    'opened_at',
        'clicked':   'clicked_at',
        'bounced':   'bounced_at',
      } as Record<string,string>)[eventType];
      if (stampCol) {
        await sql.unsafe(`UPDATE email_messages SET ${stampCol} = now() WHERE id = $1`, [messageId]);
      }
    } else if (!messageId) {
      console.log(`[email-webhook] message_id eşleşmedi (resend_id=${resendMessageId}, recipient=${recipientEmail}, type=${eventType}, lookup=${lookupMethod}), event drop`);
    } else {
      // Enum dışı tip (sent/delivery_delayed/failed/unknown): kaydetmeden ack — cast hatası önlenir.
      // (bounced/complained PERSISTED'da → yukarıda kaydedilir; suppression aşağıda yine çalışır.)
      console.log(`[email-webhook] event_type='${eventType}' email_event_type enum dışı → kaydedilmedi (ack)`);
    }

    // ─── Hard bounce / spam complaint → suppression + lead opt-out ───
    // Reputation koruması: bu adrese bir daha gönderme (follow-up dahil). email-send.ts
    // send-time'da unsubscribes'i exact-match kontrol eder (channel IN ('email','all')),
    // o yüzden lead'in STORED email'ini identifier yapıyoruz ki ileride tutsun.
    // NOT: 'delivery_delayed' (geçici/soft) suppress EDİLMEZ — sadece kalıcı bounce + complaint.
    if ((eventType === 'bounced' || eventType === 'complained') && recipientEmail) {
      const reason = eventType === 'complained' ? 'spam_complaint' : 'hard_bounce';
      try {
        const leadRows = await sql`
          SELECT id, primary_contact_email
          FROM leads
          WHERE lower(primary_contact_email) = lower(${recipientEmail})
          LIMIT 1
        `;
        const suppressIdentifier: string = leadRows[0]?.primary_contact_email ?? recipientEmail;

        // 1. Suppression registry (idempotent — UNIQUE(channel, identifier))
        await sql`
          INSERT INTO unsubscribes (channel, identifier, reason, source)
          VALUES ('email', ${suppressIdentifier}, ${reason}, 'resend_webhook')
          ON CONFLICT (channel, identifier) DO NOTHING
        `;

        // 2. Lead'i opt-out işaretle (bir daha campaign'e enroll olmasın) + 3. takipleri durdur
        if (leadRows[0]?.id) {
          const leadId: string = leadRows[0].id;
          await sql`
            UPDATE leads
            SET status = 'opted_out',
                opted_out_at = COALESCE(opted_out_at, now()),
                opted_out_channel = 'email',
                opted_out_reason = ${reason}
            WHERE id = ${leadId}
          `;
          await sql`
            UPDATE campaign_targets
            SET status = 'opted_out', next_followup_at = NULL
            WHERE lead_id = ${leadId} AND status IN ('queued', 'sent')
          `;
        }
        console.log(`[email-webhook] ${eventType} → suppressed ${recipientEmail} (reason=${reason}, lead=${leadRows[0]?.id ?? 'none'})`);
      } catch (suppressErr: any) {
        // Suppression hatası event kaydını bozmasın — logla, 200 dön (Resend retry'ı önle)
        console.error(`[email-webhook] suppress error for ${recipientEmail}:`, suppressErr?.message);
      }
    }

    return c.json({ ok: true, event: eventType, messageId, resendMessageId, lookupMethod });
  } catch (e: any) {
    console.error('[email-webhook] DB error:', e.message);
    return c.json({ error: 'db_error', message: e.message }, 500);
  }
}
