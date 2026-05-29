/**
 * wp-send — WhatsApp Cloud API template send
 * Port of supabase/functions/wp-send/index.ts
 *
 * Akış:
 *   1. Unconfigured check (META_WP_TOKEN + PHONE_NUMBER_ID)
 *   2. Lead var mı + telefon var mı
 *   3. unsubscribes check (channel IN ('whatsapp','all')) → 403
 *   4. iys-check (in-process, HTTP overhead yok) → 403
 *   5. wp_templates approved + name match
 *   6. Meta Graph API POST /<phone_id>/messages
 *   7. lead.status='new' → 'contacted'
 *
 * Endpoint: POST /functions/v1/wp-send
 * Auth: super_admin/partner (JWT)
 */
import type { Context } from 'hono';
import { sql } from './db.js';
import { requireAuth } from './middleware.js';
import { performIysCheck } from './iys-check.js';

// Backwards-compat: kaynaktaki orijinal isimler META_WP_*, memory'de Mert'in
// kullandığı WHATSAPP_* — ikisini de kabul et, önce WHATSAPP_* baktıktan sonra META_WP_*'a düş.
const META_WP_TOKEN =
  process.env.WHATSAPP_ACCESS_TOKEN ?? process.env.META_WP_TOKEN ?? '';
const META_WP_PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID ?? process.env.META_WP_PHONE_NUMBER_ID ?? '';
const META_GRAPH_BASE = process.env.META_GRAPH_BASE ?? 'https://graph.facebook.com/v19.0';

interface SendRequest {
  lead_id: string;
  template_name: string;
  variables: Record<string, string>;
  test_mode?: boolean;
}

interface LeadRow {
  id: string;
  status: string;
  primary_contact_phone: string | null;
  company_name: string | null;
}

interface TemplateRow {
  id: string;
  name: string;
  status: string;
  language: string | null;
}

export async function handleWpSend(c: Context): Promise<Response> {
  if (c.req.method !== 'POST') {
    return c.json({ error: 'method_not_allowed' }, 405);
  }

  // Auth — UI'dan tetiklenecek, super_admin/partner gerekli
  const auth = requireAuth(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  if (auth.role !== 'super_admin' && auth.role !== 'partner') {
    return c.json({ error: 'forbidden', message: 'super_admin veya partner rolü gerek' }, 403);
  }

  // Unconfigured check — kullanıcı dostu mesaj
  if (!META_WP_TOKEN || !META_WP_PHONE_NUMBER_ID) {
    return c.json({
      error: 'wp_send_unconfigured',
      message: 'WhatsApp Business hesabı bağlı değil. WHATSAPP_ACCESS_TOKEN ve WHATSAPP_PHONE_NUMBER_ID .env\'e eklenmeli.',
      configured: false,
    }, 503);
  }

  let body: SendRequest;
  try {
    body = (await c.req.json()) as SendRequest;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  if (!body.lead_id || !body.template_name) {
    return c.json({ error: 'lead_id ve template_name zorunlu' }, 400);
  }

  // 1. Lead
  const leadRows = await sql<LeadRow[]>`
    SELECT id, status, primary_contact_phone, company_name
    FROM leads
    WHERE id = ${body.lead_id}
    LIMIT 1
  `;
  const lead = leadRows[0];
  if (!lead) return c.json({ error: 'Lead bulunamadı' }, 404);
  if (!lead.primary_contact_phone) {
    return c.json({ error: 'Lead\'in telefon numarası yok' }, 400);
  }

  // 2. Unsubscribe check
  const unsubRows = await sql`
    SELECT id FROM unsubscribes
    WHERE identifier = ${lead.primary_contact_phone}
      AND channel IN ('whatsapp', 'all')
    LIMIT 1
  `;
  if (unsubRows.length > 0) {
    return c.json({ error: 'Bu numara WhatsApp opt-out registry\'de', blocked: true }, 403);
  }

  // 3. İYS check — direct in-process call (HTTP overhead yok)
  try {
    const iysResult = await performIysCheck({ phones: [lead.primary_contact_phone] });
    const phoneIYS = iysResult.results?.phones?.[lead.primary_contact_phone];
    const iysAllowed = phoneIYS?.allowed?.includes('MESAJ');
    if (!iysAllowed) {
      return c.json({ error: 'İYS izni yok', blocked: true, iys: phoneIYS }, 403);
    }
  } catch (e: any) {
    console.warn('[wp-send] iys-check başarısız:', e?.message);
    // Defansif: İYS erişilemiyorsa Sprint 1 stub mode varsayımıyla bloklamayalım
  }

  // 4. Template fetch
  const templateRows = await sql<TemplateRow[]>`
    SELECT id, name, status, language
    FROM wp_templates
    WHERE name = ${body.template_name}
      AND status = 'approved'
    LIMIT 1
  `;
  const template = templateRows[0];
  if (!template) {
    return c.json({
      error: `Template '${body.template_name}' approved durumda değil veya bulunamadı`,
    }, 400);
  }

  // 5. Meta API
  try {
    const components: any[] = [{
      type: 'body',
      parameters: Object.keys(body.variables ?? {}).sort().map((k) => ({
        type: 'text',
        text: body.variables[k],
      })),
    }];

    const metaResp = await fetch(
      `${META_GRAPH_BASE}/${META_WP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${META_WP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: lead.primary_contact_phone,
          type: 'template',
          template: {
            name: template.name,
            language: { code: template.language ?? 'tr' },
            components,
          },
        }),
      },
    );

    const metaData = await metaResp.json().catch(() => ({}));
    if (!metaResp.ok) {
      console.warn('[wp-send] Meta API error:', metaData);
      return c.json({ error: 'meta_api_error', meta: metaData }, 502);
    }

    // 6. Lead status update (new → contacted)
    if (lead.status === 'new') {
      await sql`
        UPDATE leads SET status = 'contacted' WHERE id = ${lead.id}
      `;
    }

    // 7. activity_events log (best-effort)
    try {
      await sql`
        INSERT INTO activity_events (
          user_id, event_type, category, points, target_type, target_id, metadata
        ) VALUES (
          ${auth.userId}::uuid,
          'wp_template_sent',
          'standard',
          0,
          'lead',
          ${lead.id}::uuid,
          ${sql.json({
            template_name: template.name,
            phone: lead.primary_contact_phone,
            message_id: (metaData as any)?.messages?.[0]?.id ?? null,
            test_mode: body.test_mode ?? false,
          })}
        )
      `;
    } catch (e: any) {
      console.warn('[wp-send] activity_events insert skipped:', e?.message);
    }

    return c.json({
      success: true,
      message_id: (metaData as any)?.messages?.[0]?.id,
      test_mode: body.test_mode ?? false,
    });
  } catch (e: any) {
    console.error('[wp-send] hatası:', e);
    return c.json({ error: e?.message ?? 'unknown' }, 500);
  }
}
