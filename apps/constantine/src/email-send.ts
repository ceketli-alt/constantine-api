/**
 * /functions/v1/email-send — Resend send endpoint (Supabase Edge Function port)
 *
 * İki export:
 *  - `handleEmailSend(c)` — HTTP handler (Hono Context)
 *  - `sendEmailCore(input, ctx)` — internal function (worker'lar için, auth context inject edilir)
 *
 * Akış (10 adım):
 *  1. Lead fetch (primary_contact_email + source_meta)
 *  2. override_to_email whitelist (lead'in bilinen email seti)
 *  3. Unsubscribe registry check (channel: email/all)
 *  3b. Idempotency check (campaign_id + to_email)
 *  4. Template render (mustache {{var}} substitution)
 *  5. Threading (aynı subject + last 30 gün → append; yoksa yeni thread)
 *  6. Sanitize HTML + footer + unsubscribe URL inject (ETK 6563)
 *  7. Resend POST /emails (retry: 429/5xx için 3 deneme 1s/5s/30s)
 *  8. email_messages insert
 *  9. email_threads update
 * 10. leads update
 * 11. activity_events insert (email_sent veya email_send_failed)
 */
import type { Context } from 'hono';
import sanitizeHtml from 'sanitize-html';
import { sql, withRequestContext } from './db.js';
import { requireAuth } from './middleware.js';
import { mailProviderForKind, type MailKind } from './mail/index.js';
import type { MailProvider, SendInput } from './mail/types.js';
import { resolveSpintax } from './spintax.js';
import { buildUnsubscribeUrl, buildListUnsubscribeHeaders } from './unsubscribe.js';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const DEFAULT_SENDER_EMAIL = process.env.DEFAULT_SENDER_EMAIL || 'mert@send.constantineyachts.com';
const DEFAULT_SENDER_NAME = process.env.DEFAULT_SENDER_NAME || 'Mert Ödemiş';
const DEFAULT_REPLY_TO = process.env.DEFAULT_REPLY_TO || 'info@constantineyachts.com';
const SALES_BASE_URL = process.env.SALES_BASE_URL || 'https://sales.constantineyachts.com';
const DEFAULT_REP_PHONE = process.env.DEFAULT_REP_PHONE || '';
const DEFAULT_REP_CALENDLY = process.env.DEFAULT_REP_CALENDLY || '';

// app_config'den fallback (60s cache) — generic resolver for sales config keys
const _appConfigCache = new Map<string, { v: string; at: number }>();
async function resolveAppConfigString(key: string, envFallback: string = ''): Promise<string> {
  if (envFallback) return envFallback;
  const now = Date.now();
  const cached = _appConfigCache.get(key);
  if (cached && now - cached.at < 60_000) return cached.v;
  try {
    const rows = await sql`SELECT value FROM app_config WHERE key = ${key}`;
    const raw = rows[0]?.value;
    const str = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
    const cleaned = str.replace(/^"|"$/g, '').trim();
    _appConfigCache.set(key, { v: cleaned, at: now });
    return cleaned;
  } catch {
    return '';
  }
}

async function resolveRepPhone(): Promise<string> {
  return resolveAppConfigString('sales.rep_phone', DEFAULT_REP_PHONE);
}

async function resolveAgencyPanelUrl(): Promise<string> {
  return resolveAppConfigString('sales.agency_panel_url');
}

export interface EmailSendInput {
  lead_id: string;
  template_id?: string;
  variables?: Record<string, string>;
  subject?: string;
  body_html?: string;
  body_text?: string;
  sender_email?: string;
  sender_name?: string;
  reply_to?: string;
  campaign_id?: string;
  in_reply_to?: string;
  override_to_email?: string;
  /**
   * Follow-up: rendered subject'i bununla override et (template subject'ini ezer).
   * Worker takip maillerini ilk thread'in subject'i ile gönderir → in-thread takip.
   */
  subject_override?: string;
  /** Sequence adımı: 0 = ilk mail, 1+ = takip. Idempotency + email_messages.sequence_step. */
  sequence_step?: number;
  /** A/B varyant: 'b' ise template'in subject_b/body_*_b alanları kullanılır (varsa). */
  variant?: 'a' | 'b';
  /** Text-only gönderim (HTML part'ı atlanır) — deliverability taktiği. body_html DB'de yine saklanır. */
  text_only?: boolean;
}

export interface EmailSendOutput {
  success: boolean;
  thread_id?: string;
  message_id?: string;
  resend_message_id?: string;
  error?: string;
  detail?: unknown;
  blocked?: boolean;
  channel?: string;
  configured?: boolean;
  deduped?: boolean;
  /** HTTP status önerisi — handler tarafından response code'a aktarılır */
  status?: number;
}

export interface EmailSendCtx {
  /** activity_events.user_id ve RLS auth.uid() için zorunlu */
  userId: string;
  role?: string;
  email?: string;
  jwt?: string;
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const RESEND_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RESEND_RETRY_DELAYS_MS = [1000, 5000, 30000];

const HTML_SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'a', 'strong', 'em', 'b', 'i', 'u', 'span',
    'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'pre', 'code',
    'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'width', 'height', 'style'],
    span: ['style'],
    div: ['style'],
    p: ['style'],
    table: ['style', 'border', 'cellpadding', 'cellspacing', 'width'],
    td: ['style', 'colspan', 'rowspan', 'align', 'valign'],
    th: ['style', 'colspan', 'rowspan', 'align', 'valign'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: (tagName: string, attribs: Record<string, string>) => ({
      tagName,
      attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
    }),
  },
};

const FOOTER_HTML = `
<hr style="margin-top:32px;border:none;border-top:1px solid #e5e5e5"/>
<p style="font-size:12px;color:#888;margin:8px 0;">
  Constantine Yachts<br/>
  Beşiktaş, İstanbul<br/>
  <a href="mailto:info@constantineyachts.com">info@constantineyachts.com</a>
</p>
<p style="font-size:11px;color:#aaa;margin:8px 0;">
  Bu mail, Constantine Yachts B2B partner programı kapsamında size gönderilmiştir.
  Aboneliğinizi <a href="{{unsubscribe_url}}">buradan</a> sonlandırabilirsiniz.
</p>
`;

const FOOTER_TEXT = `

--
Constantine Yachts
Beşiktaş, İstanbul
info@constantineyachts.com

Bu mail, Constantine Yachts B2B partner programı kapsamında size gönderilmiştir.
Abonelikten çıkmak için: {{unsubscribe_url}}
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeBodyHtml(html: string): string {
  if (!html) return html;
  return sanitizeHtml(html, HTML_SANITIZE_OPTS);
}

function renderTemplate(text: string, vars: Record<string, string>): string {
  // 1. mustache {{var}} — değişken substitution (çift süslü)
  const substituted = text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  // 2. spintax {a|b|c} — rastgele varyant (tek süslü, pipe içerenler). Her mail
  //    benzersizleşir → deliverability. mustache ÖNCE çözülür ki {{x}} bozulmasın.
  return resolveSpintax(substituted);
}

function buildWhatsAppUrl(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.length < 8) return '';
  return `https://wa.me/${digits}`;
}

interface ProviderSendResult {
  ok: boolean;
  status: number;
  data: any;
}

/**
 * MailProvider.send() ile 3-step retry on 429/5xx.
 * 4xx (validation) hatalarında retry yok — direkt dönüş.
 *
 * NOT: Bu fonksiyon mailProvider'a bağımlı (src/mail/), Resend'e direkt değil.
 * Provider değişimi (SendGrid/Postmark/Mailgun) bu kodu HİÇ etkilemez.
 *
 * `provider` parametresi: campaign_id varsa outreach, yoksa transactional.
 */
async function sendWithRetry(payload: SendInput, provider: MailProvider): Promise<ProviderSendResult> {
  let lastResult: ProviderSendResult = { ok: false, status: 0, data: null };
  for (let attempt = 0; attempt <= RESEND_RETRY_DELAYS_MS.length; attempt++) {
    const result = await provider.send(payload);
    if (result.ok) {
      return { ok: true, status: result.status ?? 200, data: result.raw ?? { id: result.messageId } };
    }
    const status = result.status ?? 0;
    lastResult = { ok: false, status, data: result.raw ?? { message: result.error } };
    if (status === 0) {
      // Network error — retry et
      if (attempt < RESEND_RETRY_DELAYS_MS.length) {
        console.warn(`[email-send] network error (attempt ${attempt + 1}): ${result.error}`);
        await sleep(RESEND_RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      return lastResult;
    }
    if (!RESEND_RETRY_STATUSES.has(status) || attempt >= RESEND_RETRY_DELAYS_MS.length) {
      return lastResult;
    }
    const delay = RESEND_RETRY_DELAYS_MS[attempt] ?? 1000;
    console.warn(`[email-send] provider ${status} (attempt ${attempt + 1}), retrying in ${delay}ms`);
    await sleep(delay);
  }
  return lastResult;
}

/**
 * Core send logic — HTTP handler veya worker tarafından çağrılır.
 * Auth context dışarıdan inject edilir; bu function auth check yapmaz.
 */
export async function sendEmailCore(
  input: EmailSendInput,
  ctx: EmailSendCtx,
): Promise<EmailSendOutput> {
  if (!RESEND_API_KEY) {
    return { success: false, configured: false, error: 'RESEND_API_KEY env eksik', status: 503 };
  }
  if (!input.lead_id) {
    return { success: false, error: 'lead_id required', status: 400 };
  }
  if (!ctx.userId) {
    return { success: false, error: 'ctx.userId required (activity_events.user_id NOT NULL)', status: 500 };
  }

  try {
    return await withRequestContext(
      { userId: ctx.userId, role: ctx.role, email: ctx.email, jwt: ctx.jwt },
      async (tx: any): Promise<EmailSendOutput> => {
        // ─── 1. Lead fetch ───────────────────────────────────────────
        const leadRows = await tx`
          SELECT id, primary_contact_email, primary_contact_name, company_name,
                 status, source_meta
          FROM leads
          WHERE id = ${input.lead_id}
        `;
        const lead = leadRows[0];
        if (!lead) {
          return { success: false, error: 'Lead bulunamadı', status: 404 };
        }
        if (!lead.primary_contact_email) {
          return { success: false, error: "Lead'in email adresi yok", status: 400 };
        }

        // ─── 2. override_to_email whitelist ─────────────────────────
        let recipient: string = lead.primary_contact_email;
        if (input.override_to_email) {
          const override = input.override_to_email.trim().toLowerCase();
          if (!EMAIL_RE.test(override)) {
            return { success: false, error: 'override_to_email geçerli email formatında değil', status: 400 };
          }
          const knownEmails = new Set<string>();
          knownEmails.add(lead.primary_contact_email.toLowerCase());
          const sm = (lead.source_meta ?? {}) as Record<string, unknown>;
          const byRole = (sm.emails_by_role ?? {}) as Record<string, string[]>;
          for (const arr of Object.values(byRole)) {
            for (const e of arr || []) knownEmails.add(String(e).toLowerCase());
          }
          const scraped = (sm.scraped_emails_relevant ?? []) as string[];
          for (const e of scraped) knownEmails.add(String(e).toLowerCase());
          if (!knownEmails.has(override)) {
            return {
              success: false,
              error: "override_to_email lead'in tanınan email setinde değil",
              status: 400,
            };
          }
          recipient = override;
        }

        // ─── 3. Unsubscribe registry check ──────────────────────────
        const unsubRows = await tx`
          SELECT id FROM unsubscribes
          WHERE identifier = ${recipient}
            AND channel IN ('email', 'all')
          LIMIT 1
        `;
        if (unsubRows.length > 0) {
          return {
            success: false,
            error: "Bu email opt-out registry'de",
            blocked: true,
            channel: 'email',
            status: 403,
          };
        }

        // ─── 3b. Idempotency check ──────────────────────────────────
        if (input.campaign_id) {
          // Idempotency adım-bazlı: aynı (campaign, recipient, step) iki kez gitmesin.
          // Farklı step (takip) ENGELLENMEZ — sequence ilerleyebilsin.
          const existingRows = await tx`
            SELECT id, thread_id, resend_message_id
            FROM email_messages
            WHERE campaign_id = ${input.campaign_id}
              AND to_email = ${recipient}
              AND direction = 'outbound'
              AND sequence_step = ${input.sequence_step ?? 0}
            LIMIT 1
          `;
          if (existingRows[0]) {
            return {
              success: true,
              thread_id: existingRows[0].thread_id,
              message_id: existingRows[0].id,
              resend_message_id: existingRows[0].resend_message_id,
              deduped: true,
              status: 200,
            };
          }
        }

        // ─── 4. Template render (varsa) ─────────────────────────────
        let subject: string = input.subject ?? '';
        let bodyHtml: string = input.body_html ?? '';
        let bodyText: string = input.body_text ?? '';
        let templateName: string | null = null;
        let templateId: string | null = null;

        const senderEmail = input.sender_email ?? DEFAULT_SENDER_EMAIL;
        const senderName = input.sender_name ?? DEFAULT_SENDER_NAME;
        const replyTo = input.reply_to ?? DEFAULT_REPLY_TO;

        if (input.template_id) {
          const tplRows = await tx`
            SELECT id, name, subject, body_html, body_text,
                   subject_b, body_html_b, body_text_b
            FROM email_templates
            WHERE id = ${input.template_id}
          `;
          const template = tplRows[0];
          if (!template) {
            return { success: false, error: 'Template bulunamadı', status: 404 };
          }

          const senderFirst = senderName.split(' ')[0] ?? senderName;
          const repPhone = input.variables?.rep_phone ?? await resolveRepPhone();
          const repCalendly = input.variables?.rep_calendly ?? DEFAULT_REP_CALENDLY;
          const agencyPanelUrl = input.variables?.agency_panel_url ?? await resolveAgencyPanelUrl();
          const contactFirstName: string = input.variables?.contact_first_name ??
            (lead.primary_contact_name
              ? (String(lead.primary_contact_name).trim().split(/\s+/)[0] ?? '')
              : '');

          const vars: Record<string, string> = {
            ...(input.variables ?? {}),
            company_name: lead.company_name ?? '',
            primary_contact_name: lead.primary_contact_name ?? '',
            sender_first_name: senderFirst,
            sender_full_name: senderName,
            agency_name: lead.company_name ?? '',
            contact_first_name: contactFirstName,
            rep_name: senderFirst,
            rep_full_name: senderName,
            rep_phone: repPhone,
            rep_calendly: repCalendly,
            rep_whatsapp_url: buildWhatsAppUrl(repPhone),
            agency_panel_url: agencyPanelUrl,
          };

          // A/B varyant seçimi — 'b' istenmiş + ilgili B alanı doluysa onu kullan
          // (alan-bazlı fallback: sadece subject_b varsa subject B + body A — subject testi).
          const useB = input.variant === 'b';
          const tplSubject = useB && template.subject_b ? template.subject_b : template.subject;
          const tplHtml = useB && template.body_html_b ? template.body_html_b : (template.body_html ?? '');
          const tplText = useB && template.body_text_b ? template.body_text_b : (template.body_text ?? '');
          subject = renderTemplate(tplSubject, vars);
          bodyHtml = renderTemplate(tplHtml, vars);
          bodyText = renderTemplate(tplText, vars);
          templateName = template.name;
          templateId = template.id;
        }

        // Follow-up: orijinal thread subject'i ile gönder (template'in subject'ini ezer).
        // Body takip metnini taşır; subject ilk mailinkiyle birebir → Gmail/Outlook
        // aynı thread'de gruplar, threading (adım 5) de aynı email_thread'e ekler.
        if (input.subject_override && input.subject_override.trim()) {
          subject = input.subject_override.trim();
        }

        if (!subject || (!bodyHtml && !bodyText)) {
          return { success: false, error: 'subject ve body_html/body_text gerekli', status: 400 };
        }

        // ─── 5. Threading ────────────────────────────────────────────
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        const existingThreadRows = await tx`
          SELECT id, message_count
          FROM email_threads
          WHERE lead_id = ${lead.id}
            AND subject = ${subject}
            AND last_message_at >= ${thirtyDaysAgo}
          ORDER BY last_message_at DESC
          LIMIT 1
        `;

        let threadId: string;
        let prevMessageCount = 0;
        if (existingThreadRows[0]) {
          threadId = existingThreadRows[0].id;
          prevMessageCount = Number(existingThreadRows[0].message_count ?? 0);
        } else {
          const newThreadRows = await tx`
            INSERT INTO email_threads (lead_id, subject, message_count, status)
            VALUES (${lead.id}, ${subject}, 0, 'open')
            RETURNING id
          `;
          if (!newThreadRows[0]) {
            return { success: false, error: 'Thread oluşturulamadı', status: 500 };
          }
          threadId = newThreadRows[0].id;
        }

        // ─── 6. Sanitize + Footer + unsubscribe URL ─────────────────
        const safeBodyHtml = sanitizeBodyHtml(bodyHtml);
        // Tokenli backend unsubscribe URL'i — hem footer linki hem List-Unsubscribe header'ı bunu kullanır.
        // (Eski SALES_BASE_URL frontend route'u POST one-click'i handle edemiyordu.)
        const unsubscribeUrl = buildUnsubscribeUrl(lead.id, 'email');
        const finalHtml = safeBodyHtml + FOOTER_HTML.replaceAll('{{unsubscribe_url}}', unsubscribeUrl);
        const finalText = bodyText + FOOTER_TEXT.replaceAll('{{unsubscribe_url}}', unsubscribeUrl);
        const fromField = `${senderName} <${senderEmail}>`;

        // ─── 7. Mail provider'a POST (Resend veya başka adapter) ─────
        const sendPayload: SendInput = {
          from: fromField,
          to: [recipient],
          replyTo,
          subject,
          // text-only ise HTML part'ı gönderme (deliverability). DB'de body_html yine saklanır (kayıt).
          ...(input.text_only ? {} : { html: finalHtml }),
          text: finalText,
          tags: [
            { name: 'lead_id', value: lead.id },
            { name: 'template', value: templateName ?? 'ad-hoc' },
            // kind tag → metrics aggregation outreach vs transactional ayır
            { name: 'kind', value: input.campaign_id ? 'outreach' : 'transactional' },
          ],
        };
        if (input.campaign_id) {
          sendPayload.tags!.push({ name: 'campaign_id', value: input.campaign_id });
        }
        const mailHeaders: Record<string, string> = {};
        if (input.in_reply_to) {
          mailHeaders['In-Reply-To'] = input.in_reply_to;
          // References zinciri — Gmail/Outlook threading'i sağlamlaştırır (sadece In-Reply-To'dan iyi).
          mailHeaders['References'] = input.in_reply_to;
        }
        // RFC 8058 one-click unsubscribe — SADECE kampanya (bulk) mailleri.
        // Gmail/Yahoo bulk gönderici zorunluluğu; manuel 1:1 transactional yanıta eklenmez.
        if (input.campaign_id) {
          Object.assign(mailHeaders, buildListUnsubscribeHeaders(lead.id, 'email'));
        }
        if (Object.keys(mailHeaders).length > 0) {
          sendPayload.headers = mailHeaders;
        }

        // ─── Provider seçimi ─────────────────────────────────────────
        // campaign_id varsa cold outreach (constantineyachts.online).
        // Yoksa transactional (send.constantineyachts.com) — manual reply, follow-up vs.
        const mailKind: MailKind = input.campaign_id ? 'outreach' : 'transactional';
        const provider = mailProviderForKind(mailKind);

        const sendResult = await sendWithRetry(sendPayload, provider);
        const resendData = sendResult.data;
        const resendStatus = sendResult.status;

        if (!sendResult.ok) {
          console.warn('[email-send] Resend API error:', resendStatus, resendData);
          const failMeta = {
            lead_id: lead.id,
            template: templateName,
            error: resendData,
            status: resendStatus,
            campaign_id: input.campaign_id ?? null,
          };
          try {
            await tx`
              INSERT INTO activity_events (user_id, event_type, category, points, metadata)
              VALUES (${ctx.userId}::uuid, 'email_send_failed', 'standard', 0, ${tx.json(failMeta)})
            `;
          } catch (e: any) {
            console.warn('[email-send] activity_events log skipped:', e.message);
          }
          return {
            success: false,
            error: resendData?.message ?? 'Resend API hatası',
            detail: resendData,
            status: resendStatus || 500,
          };
        }

        const nowIso = new Date().toISOString();

        // ─── 8. email_messages insert ────────────────────────────────
        const msgRows = await tx`
          INSERT INTO email_messages (
            thread_id, direction, from_email, from_name, to_email, subject,
            body_html, body_text, resend_message_id, template_id,
            campaign_id, sent_at, in_reply_to, sequence_step
          ) VALUES (
            ${threadId}, 'outbound', ${senderEmail}, ${senderName}, ${recipient}, ${subject},
            ${finalHtml}, ${finalText}, ${resendData.id}, ${templateId},
            ${input.campaign_id ?? null}, ${nowIso}, ${input.in_reply_to ?? null}, ${input.sequence_step ?? 0}
          )
          RETURNING id
        `;
        const messageId: string | null = msgRows[0]?.id ?? null;

        // ─── 9. email_threads update ─────────────────────────────────
        await tx`
          UPDATE email_threads
          SET message_count = ${prevMessageCount + 1},
              last_message_at = ${nowIso},
              last_direction = 'outbound'
          WHERE id = ${threadId}
        `;

        // ─── 10. leads update ────────────────────────────────────────
        if (lead.status === 'new') {
          await tx`
            UPDATE leads
            SET last_contacted_at = ${nowIso},
                email_thread_id = ${threadId},
                status = 'contacted'
            WHERE id = ${lead.id}
          `;
        } else {
          await tx`
            UPDATE leads
            SET last_contacted_at = ${nowIso},
                email_thread_id = ${threadId}
            WHERE id = ${lead.id}
          `;
        }

        // ─── 11. activity_events: email_sent ─────────────────────────
        const sentMeta = {
          lead_id: lead.id,
          template: templateName,
          thread_id: threadId,
          resend_message_id: resendData.id,
          campaign_id: input.campaign_id ?? null,
        };
        try {
          await tx`
            INSERT INTO activity_events (user_id, event_type, category, points, metadata)
            VALUES (${ctx.userId}::uuid, 'email_sent', 'standard', 0, ${tx.json(sentMeta)})
          `;
        } catch (e: any) {
          console.error('[email-send] activity_events insert FAILED:', e.message);
        }

        return {
          success: true,
          thread_id: threadId,
          message_id: messageId ?? undefined,
          resend_message_id: resendData.id,
          status: 200,
        };
      },
    );
  } catch (e: any) {
    console.error('[email-send] unhandled:', e);
    return { success: false, error: e?.message ?? 'unknown_error', status: 500 };
  }
}

/**
 * HTTP handler — auth check + JSON I/O. sendEmailCore'u sarar.
 */
export async function handleEmailSend(c: Context): Promise<Response> {
  const auth = requireAuth(c);
  if (!auth) {
    return c.json({ success: false, error: 'Auth gerek' }, 401);
  }

  let input: EmailSendInput;
  try {
    input = await c.req.json() as EmailSendInput;
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }

  const result = await sendEmailCore(input, {
    userId: auth.userId,
    role: auth.role,
    email: auth.email,
    jwt: auth.raw,
  });

  const status = result.status ?? (result.success ? 200 : 500);
  // status'u response body'sinden ayrıştır (UX için body'de tutmaya gerek yok)
  const { status: _drop, ...body } = result;
  return c.json(body, status as any);
}
