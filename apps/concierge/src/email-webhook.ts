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

const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';

/**
 * Resend / Svix HMAC-SHA256 signature verification
 * Format: "v1,<base64>"  multiple separated by space
 */
function verifySvixSignature(payload: string, headers: { id: string; timestamp: string; signature: string }, secret: string): boolean {
  if (!secret || !secret.startsWith('whsec_')) return true; // dev mode: secret yoksa skip
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

export async function handleResendWebhook(c: Context): Promise<Response> {
  const raw = await c.req.text();
  const svixId = c.req.header('svix-id') ?? '';
  const svixTimestamp = c.req.header('svix-timestamp') ?? '';
  const svixSignature = c.req.header('svix-signature') ?? '';

  if (RESEND_WEBHOOK_SECRET) {
    const ok = verifySvixSignature(raw, { id: svixId, timestamp: svixTimestamp, signature: svixSignature }, RESEND_WEBHOOK_SECRET);
    if (!ok) {
      console.warn('[email-webhook] Invalid signature', { svixId });
      return c.json({ error: 'invalid_signature' }, 401);
    }
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
    if (resendMessageId) {
      const m = await sql`SELECT id FROM email_messages WHERE resend_message_id = ${resendMessageId} LIMIT 1`;
      messageId = m[0]?.id ?? null;
    }

    if (messageId) {
      // Sadece eşleşen message varsa event kaydet (FK NOT NULL)
      const eventTypeNorm = ['sent','delivered','opened','clicked','bounced','complained','failed','delivery_delayed'].includes(eventType) ? eventType : 'failed';
      await sql`
        INSERT INTO email_events (message_id, event_type, raw_payload, occurred_at)
        VALUES (${messageId}, ${eventTypeNorm}::email_event_type, ${body}::jsonb, now())
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
    } else {
      console.log(`[email-webhook] message_id eşleşmedi (resend_id=${resendMessageId}), event drop`);
    }

    // Reply-status / lead temperature güncellemeleri
    if (eventType === 'bounced' || eventType === 'complained') {
      // bounced/complained → lead opt-out olabilir, ileride
      console.log(`[email-webhook] ${eventType} for ${recipientEmail}`);
    }

    return c.json({ ok: true, event: eventType, messageId, resendMessageId });
  } catch (e: any) {
    console.error('[email-webhook] DB error:', e.message);
    return c.json({ error: 'db_error', message: e.message }, 500);
  }
}
