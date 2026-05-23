/**
 * Resend send wrapper
 * Backend'in /rest/v1/rpc/send_email çağrılarına denk veya internal kullanım.
 *
 * Resend API: https://resend.com/docs/api-reference/emails/send-email
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer re_<API_KEY>
 *   Body: { from, to, subject, html, text, reply_to, ... }
 */
import { sql } from './db.js';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
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
  if (!RESEND_API_KEY) {
    return { id: '', status: 'failed', error: 'RESEND_API_KEY tanımsız' };
  }

  const fromAddr = req.from ?? DEFAULT_SENDER_EMAIL;
  const fromName = req.fromName ?? DEFAULT_SENDER_NAME;
  const fromHeader = `${fromName} <${fromAddr}>`;
  const toArray = Array.isArray(req.to) ? req.to : [req.to];

  const payload = {
    from: fromHeader,
    to: toArray,
    subject: req.subject,
    html: req.html,
    text: req.text,
    reply_to: req.replyTo ?? DEFAULT_REPLY_TO,
    tags: req.tags,
  };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json() as any;
    if (!res.ok) {
      console.error('[resend] send failed:', data);
      return { id: '', status: 'failed', error: data?.message ?? `HTTP ${res.status}` };
    }

    // email_messages tablosuna kaydet (eğer tablo varsa)
    // email_messages tablosu thread_id NOT NULL — thread yoksa transactional için skip et
    if (req.threadId) {
      try {
        await sql`
          INSERT INTO email_messages (
            thread_id, direction, from_email, to_email, subject, body_html, body_text,
            resend_message_id, campaign_id, sent_at
          ) VALUES (
            ${req.threadId}, 'outbound', ${fromAddr}, ${toArray[0]}, ${req.subject},
            ${req.html ?? null}, ${req.text ?? null}, ${data.id},
            ${req.campaignId ?? null}, now()
          )
          ON CONFLICT DO NOTHING
        `;
      } catch (e: any) {
        console.warn('[resend] email_messages insert skipped:', e.message);
      }
    }

    return { id: data.id, status: 'queued' };
  } catch (e: any) {
    console.error('[resend] fetch error:', e.message);
    return { id: '', status: 'failed', error: e.message };
  }
}

/** Test endpoint helper — bir test maili at + sonucu döner */
export async function sendTestEmail(to: string): Promise<{ id: string; status: string; error?: string }> {
  return sendEmail({
    to,
    subject: `[Test] Constantine API → Resend bağlantı testi · ${new Date().toLocaleString('tr-TR')}`,
    html: `
      <h2>Resend kurulumu yeşil ✅</h2>
      <p>Bu mail <strong>api.constantineyachts.com</strong> üzerinden gönderildi.</p>
      <p>Stack:</p>
      <ul>
        <li>Backend: Hono + Node 20 (api-constantine)</li>
        <li>DB: lokal PostgreSQL 16</li>
        <li>Sender: ${DEFAULT_SENDER_EMAIL}</li>
        <li>Tarih: ${new Date().toISOString()}</li>
      </ul>
      <p>—<br/>Aziz Claude</p>
    `,
    text: `Resend kurulumu yeşil. Backend api.constantineyachts.com üzerinden gönderildi. ${new Date().toISOString()}`,
    tags: [{ name: 'kind', value: 'test' }],
  });
}
