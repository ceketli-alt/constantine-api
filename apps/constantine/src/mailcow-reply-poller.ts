/**
 * Mailcow IMAP → CRM reply köprüsü.
 *
 * Cold outreach reply'ları @constantineyachts.online'a (Mailcow) düşer; Resend Inbound
 * webhook'una DEĞİL. Bu poller Mailcow mailbox'larını IMAP'tan okur ve reply'ları
 * `processInboundEmail` ile CRM'e işler → takip sequence durur + reply-classify + A/B reply-rate.
 *
 * Tasarım kararları (güvenlik + Instantly ile birlikte yaşama):
 *  - GATED: `MAILCOW_REPLY_POLLER_ENABLED=true` değilse hiç başlamaz.
 *  - LAZY import: imapflow/mailparser/db/email-inbound sadece poll çalışınca yüklenir →
 *    eksik dep VEYA DATABASE_URL'siz test ortamı modülü import etmeyi KIRMAZ (saf helper'lar test edilebilir).
 *  - READ-ONLY mailbox + UID watermark: mesajlara DOKUNMAZ (\Seen değişmez). Instantly aynı
 *    mailbox'ı warmup için kullanırken çakışma olmaz; Mert webmail'de unread görmeye devam eder.
 *  - BASELINE: ilk çalışmada eski yığını işlemez — sadece o andan SONRAKİ mailleri işler.
 *  - processInboundEmail message_id_header ile idempotent → tekrar okuma güvenli.
 *  - Lead eşleşmeyen mailler (warmup/spam) processInboundEmail'de no_lead_match → atlanır.
 *
 * Env:
 *  MAILCOW_REPLY_POLLER_ENABLED   '1'/'true' → aktif
 *  MAILCOW_IMAP_HOST              default mail.constantineyachts.online
 *  MAILCOW_IMAP_PORT              default 993
 *  MAILCOW_REPLY_MAILBOXES       "user1:pass1,user2:pass2"
 *  MAILCOW_REPLY_POLL_MS         default 180000 (3 dk)
 *  MAILCOW_REPLY_MAX_PER_TICK    default 50 (mailbox başına tick limiti)
 */

const ENABLED = ['1', 'true', 'yes'].includes((process.env.MAILCOW_REPLY_POLLER_ENABLED ?? '').toLowerCase());
const IMAP_HOST = process.env.MAILCOW_IMAP_HOST ?? 'mail.constantineyachts.online';
const IMAP_PORT = Number(process.env.MAILCOW_IMAP_PORT ?? 993);
const POLL_MS = Number(process.env.MAILCOW_REPLY_POLL_MS ?? 180_000);
const MAX_PER_TICK = Number(process.env.MAILCOW_REPLY_MAX_PER_TICK ?? 50);

interface Mailbox {
  user: string;
  pass: string;
}

interface PollDeps {
  ImapFlow: any;
  simpleParser: (source: any) => Promise<any>;
  sql: any;
  processInboundEmail: (input: any) => Promise<{ tracked: boolean; deduped?: boolean }>;
}

/** "user1:pass1,user2:pass2" → [{user,pass}]. Şifrede ':' olabilir → ilk ':' ayraç. */
export function parseMailboxes(raw: string | undefined): Mailbox[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx < 1) return null;
      return { user: entry.slice(0, idx).trim(), pass: entry.slice(idx + 1) };
    })
    .filter((m): m is Mailbox => !!m && m.user.includes('@') && m.pass.length > 0);
}

export function refsToString(references: unknown): string {
  if (Array.isArray(references)) return references.join(' ');
  if (typeof references === 'string') return references;
  return '';
}

const WATERMARK_PREFIX = 'sales.imap_poll.';

interface Watermark {
  uidvalidity: string;
  last_uid: number;
}

async function readWatermark(sql: any, mailbox: string): Promise<Watermark | null> {
  try {
    const rows = await sql`SELECT value FROM app_config WHERE key = ${WATERMARK_PREFIX + mailbox}`;
    if (!rows[0]?.value) return null;
    const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    if (v && typeof v.last_uid === 'number' && typeof v.uidvalidity === 'string') return v;
    return null;
  } catch {
    return null;
  }
}

async function writeWatermark(sql: any, mailbox: string, wm: Watermark): Promise<void> {
  await sql`
    INSERT INTO app_config (key, value)
    VALUES (${WATERMARK_PREFIX + mailbox}, ${JSON.stringify(wm)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

/** Tek mailbox'ı yokla. Hata fırlatmaz — loglar ve döner. */
async function pollMailbox(mb: Mailbox, deps: PollDeps): Promise<{ processed: number; tracked: number }> {
  const { ImapFlow, simpleParser, sql, processInboundEmail } = deps;
  const stat = { processed: 0, tracked: 0 };
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: mb.user, pass: mb.pass },
    logger: false,
  });

  try {
    await client.connect();
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    const uidValidity = String(box.uidValidity ?? '0');
    const uidNext = Number(box.uidNext ?? 1);
    const highestUid = Math.max(0, uidNext - 1);

    const wm = await readWatermark(sql, mb.user);

    // Baseline: ilk çalışma VEYA uidvalidity değişti → eski yığını işleme, sadece şu anı işaretle
    if (!wm || wm.uidvalidity !== uidValidity) {
      await writeWatermark(sql, mb.user, { uidvalidity: uidValidity, last_uid: highestUid });
      console.log(`[reply-poller] ${mb.user}: baseline set (uid=${highestUid}), backlog atlandı`);
      return stat;
    }

    const lastUid = wm.last_uid;
    if (highestUid <= lastUid) return stat; // yeni mail yok

    let maxUid = lastUid;
    const collected: any[] = [];
    // UID range: lastUid+1 .. * (options.uid=true → UID modu)
    for await (const msg of client.fetch(`${lastUid + 1}:*`, { source: true, internalDate: true }, { uid: true })) {
      if (typeof msg.uid !== 'number' || msg.uid <= lastUid) continue; // "N:*" quirk guard
      collected.push(msg);
      if (collected.length >= MAX_PER_TICK) break;
    }

    for (const msg of collected) {
      try {
        const parsed = await simpleParser(msg.source);
        const fromAddr = parsed.from?.value?.[0];
        const toAddr = parsed.to?.value?.[0];
        // Auto-reply/OOO algılama için ilgili header'ları çıkar (mailparser headers = lowercased Map)
        const autoHdrs: Record<string, string> = {};
        const wantedHdrs = ['auto-submitted', 'x-autoreply', 'x-autorespond', 'x-auto-response-suppress', 'precedence', 'x-mail-autoreply'];
        const pH = parsed.headers as any;
        if (pH && typeof pH.get === 'function') {
          for (const k of wantedHdrs) {
            const v = pH.get(k);
            if (v != null) autoHdrs[k] = typeof v === 'string' ? v : String(v?.value ?? v);
          }
        }
        const res = await processInboundEmail({
          from_email: fromAddr?.address ?? '',
          from_name: fromAddr?.name ?? null,
          to_email: toAddr?.address ?? mb.user,
          subject: parsed.subject ?? '(konusuz)',
          body_text: parsed.text ?? null,
          body_html: (parsed.html || null) as string | null,
          message_id_header: parsed.messageId ?? null,
          in_reply_to: parsed.inReplyTo ?? null,
          references: refsToString(parsed.references),
          headers: autoHdrs,
          received_at: (parsed.date ?? msg.internalDate ?? new Date()).toISOString(),
          raw_payload: { source: 'mailcow-imap', mailbox: mb.user, uid: msg.uid, message_id: parsed.messageId ?? null },
          source: 'imap',
        });
        stat.processed++;
        if (res.tracked && !res.deduped) stat.tracked++;
      } catch (e: any) {
        console.warn(`[reply-poller] ${mb.user} uid=${msg.uid} parse/process hata:`, e?.message);
      }
      if (typeof msg.uid === 'number' && msg.uid > maxUid) maxUid = msg.uid;
    }

    if (maxUid > lastUid) {
      await writeWatermark(sql, mb.user, { uidvalidity: uidValidity, last_uid: maxUid });
    }
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }

  return stat;
}

let pollingNow = false;

/** Bir poll turu — tüm mailbox'lar. Hata izole, asla throw etmez. Lazy import (test/startup güvenli). */
export async function runMailcowReplyPollOnce(): Promise<{ ok: boolean; mailboxes: number; processed: number; tracked: number; reason?: string }> {
  const mailboxes = parseMailboxes(process.env.MAILCOW_REPLY_MAILBOXES);
  if (mailboxes.length === 0) {
    return { ok: false, mailboxes: 0, processed: 0, tracked: 0, reason: 'no_mailboxes_configured' };
  }
  if (pollingNow) {
    return { ok: false, mailboxes: mailboxes.length, processed: 0, tracked: 0, reason: 'already_running' };
  }
  pollingNow = true;
  let processed = 0;
  let tracked = 0;
  try {
    const { ImapFlow } = await import('imapflow');
    const { simpleParser } = await import('mailparser');
    const { sql } = await import('./db.js');
    const { processInboundEmail } = await import('./email-inbound.js');
    const deps: PollDeps = { ImapFlow, simpleParser, sql, processInboundEmail };
    for (const mb of mailboxes) {
      try {
        const r = await pollMailbox(mb, deps);
        processed += r.processed;
        tracked += r.tracked;
      } catch (e: any) {
        console.warn(`[reply-poller] ${mb.user} bağlantı/poll hata:`, e?.message);
      }
    }
    if (processed > 0) console.log(`[reply-poller] tur bitti: processed=${processed} tracked=${tracked}`);
    return { ok: true, mailboxes: mailboxes.length, processed, tracked };
  } finally {
    pollingNow = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startMailcowReplyPoller(): void {
  if (!ENABLED) {
    console.log('[reply-poller] disabled (MAILCOW_REPLY_POLLER_ENABLED yok) — başlatılmadı');
    return;
  }
  const mailboxes = parseMailboxes(process.env.MAILCOW_REPLY_MAILBOXES);
  if (mailboxes.length === 0) {
    console.warn('[reply-poller] MAILCOW_REPLY_MAILBOXES boş — başlatılmadı');
    return;
  }
  console.log(`[reply-poller] starting (poll=${POLL_MS}ms, mailboxes=${mailboxes.length}, host=${IMAP_HOST})`);
  // İlk tur kısa gecikmeyle (startup'ı bloklamadan)
  setTimeout(() => { runMailcowReplyPollOnce().catch((e) => console.warn('[reply-poller] ilk tur hata:', e?.message)); }, 5_000);
  timer = setInterval(() => {
    runMailcowReplyPollOnce().catch((e) => console.warn('[reply-poller] tur hata:', e?.message));
  }, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopMailcowReplyPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[reply-poller] stopped');
  }
}
