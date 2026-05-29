/**
 * resend-send.ts — Generic mail send helper (provider-agnostic).
 *
 * NOT: İsim "resend-send" tarihsel — gerçekte `mailProvider` (src/mail/) üzerinden gönderir,
 * Resend lock-in YOK. Adapter swap'lenebilir.
 *
 * Kullanım:
 *   - sendEmail(req) — internal mail send (threading + email_messages insert opsiyonel)
 *   - sendTestEmail(to) — test endpoint helper
 */
import { sql } from './db.js';
import { mailProvider } from './mail/index.js';

const DEFAULT_SENDER_EMAIL = process.env.DEFAULT_SENDER_EMAIL || 'info@constantineyachts.com';
const DEFAULT_SENDER_NAME = process.env.DEFAULT_SENDER_NAME || 'Constantine Yachts';
const DEFAULT_REPLY_TO = process.env.DEFAULT_REPLY_TO || 'info@constantineyachts.com';

export interface SendEmailRequest {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  fromName?: string;
  replyTo?: string;
  tags?: { name: string; value: string }[];
  // Kampanya ya da lead ile bağ
  campaignId?: string;
  leadId?: string;
  threadId?: string;
}

export async function sendEmail(req: SendEmailRequest): Promise<{ id: string; status: 'queued' | 'failed'; error?: string }> {
  const fromAddr = req.from ?? DEFAULT_SENDER_EMAIL;
  const fromName = req.fromName ?? DEFAULT_SENDER_NAME;
  const fromHeader = `${fromName} <${fromAddr}>`;
  const toArray = Array.isArray(req.to) ? req.to : [req.to];
  const primaryTo = toArray[0];
  if (!primaryTo) {
    return { id: '', status: 'failed', error: 'to address missing' };
  }

  const result = await mailProvider.send({
    from: fromHeader,
    to: toArray,
    subject: req.subject,
    html: req.html,
    text: req.text,
    replyTo: req.replyTo ?? DEFAULT_REPLY_TO,
    tags: req.tags,
  });

  if (!result.ok) {
    console.error('[mail.send] failed:', result.error);
    return { id: '', status: 'failed', error: result.error };
  }

  // email_messages tablosuna kaydet (thread_id varsa)
  // email_messages tablosu thread_id NOT NULL — thread yoksa transactional için skip et
  if (req.threadId && result.messageId) {
    try {
      await sql`
        INSERT INTO email_messages (
          thread_id, direction, from_email, to_email, subject, body_html, body_text,
          resend_message_id, campaign_id, sent_at
        ) VALUES (
          ${req.threadId}, 'outbound', ${fromAddr}, ${primaryTo}, ${req.subject},
          ${req.html ?? null}, ${req.text ?? null}, ${result.messageId},
          ${req.campaignId ?? null}, now()
        )
        ON CONFLICT DO NOTHING
      `;
    } catch (e: any) {
      console.warn('[mail.send] email_messages insert skipped:', e.message);
    }
  }

  return { id: result.messageId ?? '', status: 'queued' };
}

/** Test endpoint helper — bir test maili at + sonucu döner */
export async function sendTestEmail(to: string): Promise<{ id: string; status: string; error?: string }> {
  return sendEmail({
    to,
    subject: `[Test] Constantine API → ${mailProvider.name} bağlantı testi · ${new Date().toLocaleString('tr-TR')}`,
    html: `
      <h2>Mail provider yeşil ✅</h2>
      <p>Bu mail <strong>api.constantineyachts.com</strong> üzerinden gönderildi.</p>
      <p>Stack:</p>
      <ul>
        <li>Backend: Hono + Node 20 (api-constantine)</li>
        <li>DB: lokal PostgreSQL 16</li>
        <li>Provider: ${mailProvider.name}</li>
        <li>Sender: ${DEFAULT_SENDER_EMAIL}</li>
        <li>Tarih: ${new Date().toISOString()}</li>
      </ul>
      <p>—<br/>Aziz Claude</p>
    `,
    text: `Mail provider (${mailProvider.name}) kurulumu yeşil. ${new Date().toISOString()}`,
    tags: [{ name: 'kind', value: 'test' }],
  });
}
