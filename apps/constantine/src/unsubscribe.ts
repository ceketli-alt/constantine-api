/**
 * /functions/v1/unsubscribe — One-click + human unsubscribe endpoint (RFC 8058)
 *
 * Neden backend endpoint? Gmail/Yahoo (Şub 2024 bulk gönderici kuralları) `List-Unsubscribe`
 * header'ına bir POST atar (one-click). Frontend SPA route'u POST'u handle edemez → bu yüzden
 * kendi backend endpoint'imiz. Aynı URL hem footer linkinden (GET, insan tıklar) hem de
 * mail sağlayıcısından (POST, one-click) çağrılır.
 *
 * Güvenlik: lead_id enumerasyonunu engellemek için HMAC token. Token sadece bizim ürettiğimiz
 * linklerde olur; manipüle edilen URL 400 döner.
 *
 * İşlem (token geçerliyse):
 *  1. Lead'in TÜM bilinen email'lerini topla (primary + emails_by_role + scraped) → şirket-seviyesi opt-out
 *  2. unsubscribes registry'ye ekle (channel='email', her email için, ON CONFLICT DO NOTHING)
 *  3. leads.status='opted_out' (+ opted_out_at/channel/reason)
 *  4. campaign_targets (queued|sent) → 'opted_out' + next_followup_at NULL (sequence durur)
 *  5. activity_events log
 *  GET → onay HTML sayfası · POST → 200 JSON (one-click)
 */
import type { Context } from 'hono';
import crypto from 'node:crypto';
import { sql } from './db.js';

const API_BASE_URL = process.env.API_BASE_URL || 'https://api.constantineyachts.com';
const UNSUB_SECRET =
  process.env.UNSUBSCRIBE_SECRET || process.env.RESEND_WEBHOOK_SECRET || 'constantine-unsub-v1';

/** HMAC-SHA256(lead:channel) → 32-hex token. email-send.ts ve bu handler aynı fonksiyonu kullanır. */
export function unsubscribeToken(leadId: string, channel: string): string {
  return crypto
    .createHmac('sha256', UNSUB_SECRET)
    .update(`${leadId}:${channel}`)
    .digest('hex')
    .slice(0, 32);
}

/** Footer + List-Unsubscribe header için tokenli public URL üretir. */
export function buildUnsubscribeUrl(leadId: string, channel: string = 'email'): string {
  const token = unsubscribeToken(leadId, channel);
  return `${API_BASE_URL}/functions/v1/unsubscribe?lead=${encodeURIComponent(leadId)}&channel=${encodeURIComponent(channel)}&token=${token}`;
}

/**
 * RFC 8058 one-click header çifti. Sadece kampanya (bulk) mailleri için kullanılmalı.
 * `List-Unsubscribe`: https URI (Gmail POST atar) · `List-Unsubscribe-Post`: One-Click sinyali.
 */
export function buildListUnsubscribeHeaders(leadId: string, channel: string = 'email'): Record<string, string> {
  return {
    'List-Unsubscribe': `<${buildUnsubscribeUrl(leadId, channel)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

function tokenValid(leadId: string, channel: string, token: string | undefined | null): boolean {
  if (!token) return false;
  const expected = unsubscribeToken(leadId, channel);
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Lead'in tüm bilinen email adreslerini topla (şirket-seviyesi opt-out için). */
function collectLeadEmails(lead: any): string[] {
  const emails = new Set<string>();
  if (lead.primary_contact_email) emails.add(String(lead.primary_contact_email).toLowerCase().trim());
  const sm = (lead.source_meta ?? {}) as Record<string, unknown>;
  const byRole = (sm.emails_by_role ?? {}) as Record<string, string[]>;
  for (const arr of Object.values(byRole)) {
    for (const e of arr || []) {
      const v = String(e).toLowerCase().trim();
      if (v) emails.add(v);
    }
  }
  const scraped = (sm.scraped_emails_relevant ?? []) as string[];
  for (const e of scraped || []) {
    const v = String(e).toLowerCase().trim();
    if (v) emails.add(v);
  }
  return [...emails];
}

const CONFIRM_HTML = (company: string) => `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Abonelik İptal Edildi</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f7f8;color:#222;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;max-width:440px;padding:40px;border-radius:14px;box-shadow:0 2px 24px rgba(0,0,0,.06);text-align:center}
h1{font-size:20px;margin:0 0 12px}p{color:#666;line-height:1.6;font-size:14px;margin:8px 0}.ok{color:#10b981;font-size:40px;margin-bottom:8px}</style>
</head><body><div class="card">
<div class="ok">✓</div>
<h1>Aboneliğiniz sonlandırıldı</h1>
<p>${company ? company + ' adına ' : ''}artık Constantine Yachts B2B partner programından e-posta almayacaksınız.</p>
<p style="font-size:12px;color:#aaa;margin-top:20px">Yanlışlıkla mı tıkladınız? <a href="mailto:info@constantineyachts.com">info@constantineyachts.com</a></p>
</div></body></html>`;

const ERROR_HTML = `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"/><title>Geçersiz Bağlantı</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f7f8;color:#222;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;max-width:440px;padding:40px;border-radius:14px;box-shadow:0 2px 24px rgba(0,0,0,.06);text-align:center}</style>
</head><body><div class="card"><h1>Geçersiz bağlantı</h1>
<p>Bu abonelik iptal bağlantısı geçersiz. Lütfen <a href="mailto:info@constantineyachts.com">info@constantineyachts.com</a> ile iletişime geçin.</p>
</div></body></html>`;

/**
 * Çekirdek opt-out işlemi — token doğrulandıktan sonra çağrılır.
 * Hem GET hem POST aynı mantığı kullanır.
 */
async function performUnsubscribe(leadId: string, channel: string): Promise<{ ok: boolean; company?: string; reason?: string }> {
  const leadRows = await sql`
    SELECT id, company_name, primary_contact_email, source_meta, status
    FROM leads WHERE id = ${leadId} LIMIT 1
  `;
  const lead = leadRows[0];
  if (!lead) return { ok: false, reason: 'lead_not_found' };

  const emails = collectLeadEmails(lead);

  // 1. unsubscribes registry — şirketin tüm adresleri
  for (const email of emails) {
    try {
      await sql`
        INSERT INTO unsubscribes (channel, identifier, reason, source)
        VALUES (${channel}, ${email}, 'one_click_unsubscribe', 'list_unsubscribe')
        ON CONFLICT (channel, identifier) DO NOTHING
      `;
    } catch (e: any) {
      console.warn('[unsubscribe] registry insert skipped:', email, e?.message);
    }
  }

  // 2. lead opted_out
  try {
    await sql`
      UPDATE leads
      SET status = 'opted_out',
          opted_out_at = ${new Date().toISOString()},
          opted_out_channel = ${channel}::contact_channel,
          opted_out_reason = 'one_click_unsubscribe'
      WHERE id = ${leadId}
    `;
  } catch (e: any) {
    // opted_out_* kolonları yoksa status'u yine de set et (graceful)
    console.warn('[unsubscribe] lead opt-out partial:', e?.message);
    try {
      await sql`UPDATE leads SET status = 'opted_out' WHERE id = ${leadId}`;
    } catch (e2: any) {
      console.error('[unsubscribe] lead status update failed:', e2?.message);
    }
  }

  // 3. aktif campaign_targets → opted_out (sequence durur)
  try {
    await sql`
      UPDATE campaign_targets
      SET status = 'opted_out', next_followup_at = NULL
      WHERE lead_id = ${leadId} AND status IN ('queued', 'sent')
    `;
  } catch (e: any) {
    console.warn('[unsubscribe] campaign_targets stop skipped:', e?.message);
  }

  // 4. activity_events
  try {
    const adminRows = await sql`
      SELECT id FROM profiles WHERE role = 'super_admin' AND active = true ORDER BY created_at LIMIT 1
    `;
    const adminId = adminRows[0]?.id;
    if (adminId) {
      await sql`
        INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
        VALUES (${adminId}::uuid, 'lead_unsubscribed', 'standard', 0, 'lead', ${leadId}::uuid,
          ${sql.json({ channel, emails, source: 'list_unsubscribe' })})
      `;
    }
  } catch (e: any) {
    console.warn('[unsubscribe] activity_events skipped:', e?.message);
  }

  return { ok: true, company: lead.company_name ?? '' };
}

/** HTTP handler — GET (insan) + POST (one-click). server.ts ikisini de bu fonksiyona bağlar. */
export async function handleUnsubscribe(c: Context): Promise<Response> {
  const leadId = c.req.query('lead') ?? '';
  const channel = c.req.query('channel') ?? 'email';
  const token = c.req.query('token') ?? '';
  const isPost = c.req.method === 'POST';

  if (!leadId || !tokenValid(leadId, channel, token)) {
    if (isPost) return c.json({ ok: false, error: 'invalid_token' }, 400);
    return c.html(ERROR_HTML, 400);
  }

  let result: { ok: boolean; company?: string; reason?: string };
  try {
    result = await performUnsubscribe(leadId, channel);
  } catch (e: any) {
    console.error('[unsubscribe] unhandled:', e?.message);
    if (isPost) return c.json({ ok: false, error: 'internal_error' }, 500);
    return c.html(ERROR_HTML, 500);
  }

  if (!result.ok) {
    if (isPost) return c.json({ ok: false, error: result.reason }, 404);
    return c.html(ERROR_HTML, 404);
  }

  // One-click (POST) → sade 200; insan (GET) → onay sayfası
  if (isPost) return c.json({ ok: true, unsubscribed: true });
  return c.html(CONFIRM_HTML(result.company ?? ''));
}
