/**
 * /functions/v1/email-inbound — Resend Inbound webhook
 *
 * Resend Inbound: DNS MX → Resend → POST our webhook.
 * Setup:
 *   1. DNS: send.constantineyachts.com MX → feedback-smtp.us-east-1.amazonses.com (Resend)
 *   2. Resend dashboard → Domains → send.constantineyachts.com → Inbound enable
 *   3. Endpoint URL: https://api.constantineyachts.com/functions/v1/email-inbound
 *
 * Akış (kanonik Supabase fn'in Hono portu):
 *  1. Svix HMAC imza doğrula (RESEND_WEBHOOK_SECRET — webhook'la aynı)
 *  2. payload.type === 'inbound_email' kontrolü
 *  3. Lead match by from.email
 *  4. Thread matching: in_reply_to → references → subject normalize (son 30 gün)
 *  5. Hiçbiri yoksa yeni thread (direction='inbound')
 *  6. email_messages insert (direction='inbound', raw_payload sakla)
 *  7. email_threads counters update (unread_count++, last_direction)
 *  8. email_events insert (event_type='replied')
 *  9. leads update (email_thread_id) + temperature trigger
 * 10. reply-classify fire-and-forget invoke
 * 11. activity_events insert (email_replied)
 */
import type { Context } from 'hono';
import crypto from 'node:crypto';
import { sql } from './db.js';
import { runReplyClassify } from './reply-classify.js';

const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';

function stripBrackets(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.replace(/^[<\s]+|[>\s]+$/g, '').trim() || null;
}

/**
 * Auto-reply / OOO algılama. Amaç: otomatik yanıtlar (out-of-office, vacation responder, robot)
 * cold-outreach sequence'ini DURDURMASIN ve reply-rate'i (A/B winner) ŞİŞİRMESİN.
 *
 * Yalnızca GÜÇLÜ sinyaller kullanılır (false-positive maliyetli: gerçek yanıtı kaçırırsak
 * insana mail atmaya devam ederiz). RFC 3834 `Auto-Submitted` + yaygın vendor header'ları +
 * net OOO subject kalıpları (TR + EN).
 */
export function isAutoReply(subject: string | null | undefined, headers?: Record<string, string> | null): boolean {
  // Header anahtarlarını normalize et: 'Auto-Submitted' / 'auto_submitted' → 'auto-submitted'
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    norm[k.toLowerCase().replace(/_/g, '-')] = String(v ?? '').toLowerCase();
  }
  const autoSubmitted = norm['auto-submitted'];
  if (autoSubmitted && autoSubmitted !== 'no') return true; // auto-replied | auto-generated
  if (norm['x-autoreply'] || norm['x-autorespond'] || norm['x-auto-response-suppress']) return true;
  if (norm['x-autoreply-domain'] || norm['x-mail-autoreply']) return true;
  const precedence = norm['precedence'];
  if (precedence === 'auto_reply') return true;

  const s = (subject ?? '').toLowerCase();
  if (!s) return false;
  const patterns: RegExp[] = [
    /out of (the )?office/,
    /automatic(ally)? repl/,
    /auto[\s-]?reply/,
    /auto[\s-]?response/,
    /away from (the )?office/,
    /on (vacation|holiday|annual leave|leave)/,
    /otomatik yan[ıi]t/,
    /ofis(im)? d[ıi][şs][ıi]nda/,
    /ofis\w*\s+uzak/,
    /uzaktay[ıi]m/,
    /y[ıi]ll[ıi]k izin/,
    /izinde(yim)?/,
    /tatilde(yim)?/,
    /d[öo]n[üu][şs](te|ümde)/,
  ];
  return patterns.some((re) => re.test(s));
}

function verifySvixSignature(
  payload: string,
  headers: { id: string; timestamp: string; signature: string },
  secret: string,
): boolean {
  // Fail closed — caller secret'ı pre-validate eder.
  if (!secret) return false;
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const secretBase = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secretBase, 'base64');
  } catch {
    return false;
  }
  const signedContent = `${headers.id}.${headers.timestamp}.${payload}`;
  const computed = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  const sigs = headers.signature.split(' ').map((s) => s.trim().replace(/^v1,/, ''));
  return sigs.some((s) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(s), Buffer.from(computed));
    } catch {
      return false;
    }
  });
}

/** Normalize edilmiş inbound email — hem Resend webhook hem Mailcow IMAP poller buradan geçer. */
export interface InboundEmailInput {
  from_email: string;
  from_name?: string | null;
  to_email?: string | null;
  subject?: string | null;
  body_html?: string | null;
  body_text?: string | null;
  message_id_header?: string | null;
  in_reply_to?: string | null;
  references?: string | null;
  /** Ham mail header'ları (auto-reply/OOO algılama için). Resend: data.headers, IMAP: parsed headers. */
  headers?: Record<string, string> | null;
  received_at?: string; // ISO; yoksa now
  raw_payload?: unknown; // jsonb storage (resend payload veya imap parsed)
  source?: string; // 'resend' | 'imap' — log/teşhis
}

export interface InboundEmailResult {
  ok: boolean;
  tracked: boolean;
  deduped?: boolean;
  reason?: string;
  thread_id?: string | null;
  message_id?: string | null;
  lead_id?: string | null;
  /** true ise OOO/otomatik yanıt: sequence durmadı, reply-rate'e sayılmadı. */
  auto_reply?: boolean;
}

/**
 * Inbound email ortak işleme çekirdeği (kaynak-agnostik).
 *  - Lead match (from_email)
 *  - Thread eşleme (in_reply_to → references → subject normalize, son 30 gün)
 *  - email_messages (inbound) + thread counters + email_events('replied')
 *  - campaign_targets 'replied' → takip durur
 *  - reply-classify fire-and-forget + activity_events
 * message_id_header ile idempotent (aynı mesaj iki kez işlenmez → IMAP re-poll güvenli).
 */
export async function processInboundEmail(input: InboundEmailInput): Promise<InboundEmailResult> {
  const fromEmail = String(input.from_email ?? '').toLowerCase().trim();
  const fromName = input.from_name ?? null;
  const toEmail = input.to_email ?? '';
  const subject = input.subject ?? '(konusuz)';
  const messageIdHeader = stripBrackets(input.message_id_header);
  const inReplyTo = stripBrackets(input.in_reply_to);
  const referencesHeader: string = input.references ?? '';
  const receivedIso = input.received_at ?? new Date().toISOString();
  const rawJson = input.raw_payload == null ? null : sql.json(input.raw_payload as any);
  // Auto-reply/OOO ise: mesajı SAKLA ama sequence'i durdurma + reply-rate'e sayma.
  const autoReply = isAutoReply(subject, input.headers);

  if (!fromEmail) {
    return { ok: true, tracked: false, reason: 'no_from_email' };
  }

  try {
    // 0. Idempotency — aynı message_id_header daha önce işlendiyse atla (IMAP re-poll için kritik)
    if (messageIdHeader) {
      const dup = await sql`
        SELECT id, thread_id FROM email_messages
        WHERE message_id_header = ${messageIdHeader} AND direction = 'inbound'
        LIMIT 1
      `;
      if (dup[0]) {
        return { ok: true, tracked: true, deduped: true, message_id: dup[0].id, thread_id: dup[0].thread_id };
      }
    }

    // 1. Lead lookup
    const leadRows = await sql`
      SELECT id, company_name, email_thread_id
      FROM leads
      WHERE lower(primary_contact_email) = ${fromEmail}
      LIMIT 1
    `;
    const lead = leadRows[0];
    if (!lead) {
      console.log(`[email-inbound] no lead match for ${fromEmail} (source=${input.source ?? '?'})`);
      return { ok: true, tracked: false, reason: 'no_lead_match' };
    }

    // 2. Thread matching
    let threadId: string | null = null;

    if (inReplyTo) {
      const rows = await sql`
        SELECT thread_id FROM email_messages
        WHERE message_id_header = ${inReplyTo}
        LIMIT 1
      `;
      if (rows[0]) threadId = rows[0].thread_id;
    }

    if (!threadId && referencesHeader) {
      const refs = referencesHeader
        .split(/\s+/)
        .map((r: string) => stripBrackets(r))
        .filter((r): r is string => !!r);
      if (refs.length > 0) {
        const rows = await sql`
          SELECT thread_id FROM email_messages
          WHERE message_id_header = ANY(${refs as any})
          LIMIT 1
        `;
        if (rows[0]) threadId = rows[0].thread_id;
      }
    }

    if (!threadId) {
      // Subject normalize fallback (RE:/FW:/YN: strip, son 30 gün)
      const normalized = String(subject).replace(/^(re|fw|fwd|yn|i?lt):\s*/gi, '').trim();
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const rows = await sql`
        SELECT id FROM email_threads
        WHERE lead_id = ${lead.id}
          AND subject ILIKE ${'%' + normalized + '%'}
          AND last_message_at >= ${since}
        ORDER BY last_message_at DESC
        LIMIT 1
      `;
      if (rows[0]) threadId = rows[0].id;
    }

    // 3. Yeni thread (yoksa)
    if (!threadId) {
      const newThreadRows = await sql`
        INSERT INTO email_threads (
          lead_id, subject, message_count, last_direction, last_message_at,
          unread_count, status
        ) VALUES (
          ${lead.id}, ${subject}, 0, 'inbound', ${receivedIso}, 0, 'open'
        )
        RETURNING id
      `;
      if (!newThreadRows[0]) {
        return { ok: false, tracked: false, reason: 'thread_create_failed' };
      }
      threadId = newThreadRows[0].id;
    }

    // 4. email_messages insert (direction='inbound')
    const msgRows = await sql`
      INSERT INTO email_messages (
        thread_id, direction, from_email, from_name, to_email, subject,
        body_html, body_text, message_id_header, in_reply_to,
        received_at, replied_at, raw_payload
      ) VALUES (
        ${threadId}, 'inbound', ${fromEmail}, ${fromName}, ${toEmail}, ${subject},
        ${input.body_html ?? null}, ${input.body_text ?? null}, ${messageIdHeader}, ${inReplyTo},
        ${receivedIso}, ${receivedIso}, ${rawJson}
      )
      RETURNING id
    `;
    const messageId = msgRows[0]?.id ?? null;

    // 5. email_threads counters update
    await sql`
      UPDATE email_threads
      SET message_count = message_count + 1,
          unread_count  = unread_count + 1,
          last_message_at = ${receivedIso},
          last_direction  = 'inbound'
      WHERE id = ${threadId}
    `;

    // 6. email_events insert (replied) — auto-reply ise ATLA (reply-rate / A/B winner temiz kalsın)
    if (messageId && !autoReply) {
      try {
        await sql`
          INSERT INTO email_events (message_id, event_type, occurred_at, raw_payload)
          VALUES (${messageId}, 'replied', ${receivedIso}, ${rawJson})
        `;
      } catch (e: any) {
        console.warn('[email-inbound] email_events insert skipped:', e.message);
      }
    }

    // 7. leads update — email_thread_id
    await sql`
      UPDATE leads
      SET email_thread_id = ${threadId}
      WHERE id = ${lead.id}
    `;

    // 7b. Cold outreach takip sequence'ini durdur — lead GERÇEK reply attı.
    // 'sent' campaign_targets → 'replied' + next_followup_at NULL → worker takip göndermez.
    // Auto-reply (OOO) ise ATLA: kişi sadece uzakta, sequence devam etmeli.
    if (!autoReply) {
      try {
        await sql`
          UPDATE campaign_targets
          SET status = 'replied', replied_at = ${receivedIso}, next_followup_at = NULL
          WHERE lead_id = ${lead.id} AND status = 'sent'
        `;
      } catch (e: any) {
        console.warn('[email-inbound] campaign_targets replied update skipped:', e.message);
      }

      // 7c. G8 — şirket-seviyesi reply-stop: stop_company_on_reply açık kampanyalarda, yanıt veren
      // lead ile AYNI email domain'indeki diğer lead'lerin target'larını durdur (queued→company_stopped,
      // sent→takip iptal). Sadece yanıtlayan lead'in dahil olduğu kampanyalarla sınırlı (Instantly paritesi).
      const domain = fromEmail.includes('@') ? fromEmail.split('@')[1] : '';
      if (domain) {
        try {
          await sql`
            UPDATE campaign_targets ct
            SET status = CASE WHEN ct.status = 'queued' THEN 'company_stopped'::campaign_target_status ELSE ct.status END,
                next_followup_at = NULL
            FROM campaigns c, leads l
            WHERE ct.campaign_id = c.id
              AND c.stop_company_on_reply = true
              AND ct.lead_id = l.id
              AND ct.lead_id <> ${lead.id}
              AND ct.status IN ('queued', 'sent')
              AND lower(split_part(l.primary_contact_email, '@', 2)) = ${domain}
              AND ct.campaign_id IN (SELECT campaign_id FROM campaign_targets WHERE lead_id = ${lead.id})
          `;
        } catch (e: any) {
          console.warn('[email-inbound] company-reply-stop skipped:', e.message);
        }
      }
    }

    // 8. Sınıflandırma. Auto-reply ise Claude'u ÇAĞIRMA (zaten 'irrelevant') → token tasarrufu +
    //    thread'i doğrudan 'irrelevant' etiketle (UI'da görünür). Değilse normal classify.
    if (messageId && autoReply) {
      try {
        await sql`
          UPDATE email_threads
          SET classification = 'irrelevant'::email_classification, classified_at = ${receivedIso}
          WHERE id = ${threadId}
        `;
      } catch (e: any) {
        console.warn('[email-inbound] auto-reply classify skipped:', e.message);
      }
    } else if (messageId) {
      runReplyClassify({ thread_id: threadId ?? undefined, message_id: messageId, lead_id: lead.id })
        .then((r) => {
          if (!r.ok) console.warn('[email-inbound] classify skipped:', r.error);
        })
        .catch((e) => console.warn('[email-inbound] classify invoke failed:', e?.message));
    }

    // 9. activity_events insert (system event → fallback super_admin)
    try {
      const adminRows = await sql`
        SELECT id FROM profiles
        WHERE role = 'super_admin' AND active = true
        ORDER BY created_at
        LIMIT 1
      `;
      const adminId = adminRows[0]?.id;
      if (adminId) {
        await sql`
          INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
          VALUES (
            ${adminId}::uuid, 'email_replied', 'standard', 0, 'lead', ${lead.id}::uuid,
            ${sql.json({ thread_id: threadId, message_id: messageId, from_email: fromEmail, subject, source: input.source ?? 'resend', auto_reply: autoReply })}
          )
        `;
      }
    } catch (e: any) {
      console.warn('[email-inbound] activity_events insert skipped:', e.message);
    }

    return { ok: true, tracked: true, thread_id: threadId, message_id: messageId, lead_id: lead.id, auto_reply: autoReply };
  } catch (e: any) {
    console.error('[email-inbound] processInboundEmail unhandled:', e);
    return { ok: false, tracked: false, reason: e?.message ?? 'internal_error' };
  }
}

export async function handleResendInbound(c: Context): Promise<Response> {
  const rawBody = await c.req.text();

  // 1. Svix imza — fail-closed
  if (!RESEND_WEBHOOK_SECRET) {
    console.error('[email-inbound] RESEND_WEBHOOK_SECRET not configured — rejecting webhook');
    return c.json({ error: 'webhook_not_configured' }, 503);
  }
  const svixId = c.req.header('svix-id') ?? '';
  const svixTimestamp = c.req.header('svix-timestamp') ?? '';
  const svixSignature = c.req.header('svix-signature') ?? '';
  const valid = verifySvixSignature(
    rawBody,
    { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
    RESEND_WEBHOOK_SECRET,
  );
  if (!valid) {
    console.warn('[email-inbound] invalid signature', { svixId });
    return c.json({ error: 'invalid_signature' }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  // 2. Event type
  if (payload?.type !== 'inbound_email') {
    return c.json({ ok: true, skipped: 'wrong_event_type', received: payload?.type });
  }

  const data = payload.data ?? payload;
  const result = await processInboundEmail({
    from_email: data.from?.email ?? '',
    from_name: data.from?.name ?? null,
    to_email: data.to?.[0]?.email ?? '',
    subject: data.subject ?? '(konusuz)',
    body_html: data.html ?? null,
    body_text: data.text ?? null,
    message_id_header: data.headers?.message_id ?? data.message_id ?? null,
    in_reply_to: data.headers?.in_reply_to ?? data.in_reply_to ?? null,
    references: data.headers?.references ?? data.references ?? '',
    headers: data.headers ?? null,
    received_at: undefined,
    raw_payload: payload,
    source: 'resend',
  });

  return c.json(result, (result.ok ? 200 : 500) as any);
}
