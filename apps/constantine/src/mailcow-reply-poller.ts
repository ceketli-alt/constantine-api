/**
 * IMAP → CRM reply köprüsü (multi-host).
 *
 * Cold outreach reply'ları @constantineyachts.online'a (Mailcow) düşer; Resend Inbound
 * webhook'una DEĞİL. Bu poller IMAP mailbox'larını okur ve reply'ları
 * `processInboundEmail` ile CRM'e işler → takip sequence durur + reply-classify + A/B reply-rate.
 *
 * 2026-06-10: Multi-host destek eklendi. Mailcow (cy.online) ile info@cy.com (farklı
 * IMAP sunucu) aynı kod yoluyla poll'lanır. Her host için ayrı timer + watermark.
 *
 * Tasarım kararları (güvenlik + Instantly ile birlikte yaşama):
 *  - GATED: `MAILCOW_REPLY_POLLER_ENABLED=true` değilse Mailcow grubu başlamaz.
 *           `INFO_IMAP_ENABLED=true` ise info grubu da başlar.
 *  - LAZY import: imapflow/mailparser/db/email-inbound sadece poll çalışınca yüklenir →
 *    eksik dep VEYA DATABASE_URL'siz test ortamı modülü import etmeyi KIRMAZ (saf helper'lar test edilebilir).
 *  - READ-ONLY mailbox + UID watermark: mesajlara DOKUNMAZ (\Seen değişmez). Instantly aynı
 *    mailbox'ı warmup için kullanırken çakışma olmaz; Mert webmail'de unread görmeye devam eder.
 *  - BASELINE: ilk çalışmada eski yığını işlemez — sadece o andan SONRAKİ mailleri işler.
 *  - processInboundEmail message_id_header ile idempotent → tekrar okuma güvenli.
 *  - Lead eşleşmeyen mailler (warmup/spam) processInboundEmail'de no_lead_match → atlanır.
 *
 * Env (Mailcow grubu — legacy):
 *  MAILCOW_REPLY_POLLER_ENABLED   '1'/'true' → aktif
 *  MAILCOW_IMAP_HOST              default mail.constantineyachts.online
 *  MAILCOW_IMAP_PORT              default 993
 *  MAILCOW_REPLY_MAILBOXES       "user1:pass1,user2:pass2"
 *  MAILCOW_REPLY_POLL_MS         default 180000 (3 dk)
 *  MAILCOW_REPLY_MAX_PER_TICK    default 50 (mailbox başına tick limiti)
 *
 * Env (Info grubu — 2026-06-10):
 *  INFO_IMAP_ENABLED              '1'/'true' → aktif
 *  INFO_IMAP_HOST                 default mail.constantineyachts.com
 *  INFO_IMAP_PORT                 default 993
 *  INFO_IMAP_MAILBOXES            "info@constantineyachts.com:SECRET"
 *  INFO_IMAP_POLL_MS              default = MAILCOW_REPLY_POLL_MS
 *  INFO_IMAP_MAX_PER_TICK         default = MAILCOW_REPLY_MAX_PER_TICK
 */

const ENABLED = ['1', 'true', 'yes'].includes((process.env.MAILCOW_REPLY_POLLER_ENABLED ?? '').toLowerCase());
const IMAP_HOST = process.env.MAILCOW_IMAP_HOST ?? 'mail.constantineyachts.online';
const IMAP_PORT = Number(process.env.MAILCOW_IMAP_PORT ?? 993);
const POLL_MS = Number(process.env.MAILCOW_REPLY_POLL_MS ?? 180_000);
const MAX_PER_TICK = Number(process.env.MAILCOW_REPLY_MAX_PER_TICK ?? 50);

/** Bir IMAP grubunun çalışma konfigürasyonu — multi-host destek için. */
interface PollerInstance {
  label: string;        // log + state için anlamlı isim ('mailcow', 'info')
  host: string;
  port: number;
  mailboxes: Mailbox[];
  pollMs: number;
  maxPerTick: number;
}

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
async function pollMailbox(
  mb: Mailbox,
  deps: PollDeps,
  conn: { host: string; port: number; maxPerTick: number },
): Promise<{ processed: number; tracked: number }> {
  const { ImapFlow, simpleParser, sql, processInboundEmail } = deps;
  const stat = { processed: 0, tracked: 0 };
  const client = new ImapFlow({
    host: conn.host,
    port: conn.port,
    secure: true,
    auth: { user: mb.user, pass: mb.pass },
    logger: false,
  });
  // imapflow TLS kapanınca 'error' event fırlatır; listener olmasa unhandled exception → process crash
  client.on('error', (e: any) => {
    console.warn(`[reply-poller] ${mb.user} imap client error:`, e?.message ?? e);
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
      if (collected.length >= conn.maxPerTick) break;
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

// pollingNow Mailcow grubu için tek-tick guard; multi-host'ta her grup için ayrı.
const pollingLocks = new Set<string>();

/**
 * Bir grubun (config'in) tüm mailbox'larını yokla. Hata izole, throw etmez.
 * Config verilmezse legacy Mailcow grubu env'lerinden oluşturulur (backward compat).
 */
export async function runReplyPollOnce(
  cfg?: PollerInstance,
): Promise<{ ok: boolean; mailboxes: number; processed: number; tracked: number; reason?: string; label?: string }> {
  const config: PollerInstance = cfg ?? {
    label: 'mailcow',
    host: IMAP_HOST,
    port: IMAP_PORT,
    mailboxes: parseMailboxes(process.env.MAILCOW_REPLY_MAILBOXES),
    pollMs: POLL_MS,
    maxPerTick: MAX_PER_TICK,
  };
  if (config.mailboxes.length === 0) {
    return { ok: false, mailboxes: 0, processed: 0, tracked: 0, reason: 'no_mailboxes_configured', label: config.label };
  }
  if (pollingLocks.has(config.label)) {
    return { ok: false, mailboxes: config.mailboxes.length, processed: 0, tracked: 0, reason: 'already_running', label: config.label };
  }
  pollingLocks.add(config.label);
  let processed = 0;
  let tracked = 0;
  try {
    const { ImapFlow } = await import('imapflow');
    const { simpleParser } = await import('mailparser');
    const { sql } = await import('./db.js');
    const { processInboundEmail } = await import('./email-inbound.js');
    const deps: PollDeps = { ImapFlow, simpleParser, sql, processInboundEmail };
    const conn = { host: config.host, port: config.port, maxPerTick: config.maxPerTick };
    for (const mb of config.mailboxes) {
      try {
        const r = await pollMailbox(mb, deps, conn);
        processed += r.processed;
        tracked += r.tracked;
      } catch (e: any) {
        console.warn(`[reply-poller:${config.label}] ${mb.user} bağlantı/poll hata:`, e?.message);
      }
    }
    if (processed > 0) console.log(`[reply-poller:${config.label}] tur bitti: processed=${processed} tracked=${tracked}`);
    return { ok: true, mailboxes: config.mailboxes.length, processed, tracked, label: config.label };
  } finally {
    pollingLocks.delete(config.label);
  }
}

/** Backward compat — eski kodun çağırdığı fonksiyon. */
export const runMailcowReplyPollOnce = runReplyPollOnce;

const timers: NodeJS.Timeout[] = [];

function startSinglePoller(cfg: PollerInstance): void {
  console.log(`[reply-poller:${cfg.label}] starting (poll=${cfg.pollMs}ms, mailboxes=${cfg.mailboxes.length}, host=${cfg.host})`);
  // İlk tur kısa gecikmeyle (startup'ı bloklamadan)
  setTimeout(() => {
    runReplyPollOnce(cfg).catch((e) => console.warn(`[reply-poller:${cfg.label}] ilk tur hata:`, e?.message));
  }, 5_000);
  const t = setInterval(() => {
    runReplyPollOnce(cfg).catch((e) => console.warn(`[reply-poller:${cfg.label}] tur hata:`, e?.message));
  }, cfg.pollMs);
  if (typeof t.unref === 'function') t.unref();
  timers.push(t);
}

/**
 * Tüm poller gruplarını başlat.
 * Mailcow grubu: MAILCOW_REPLY_POLLER_ENABLED=true ise.
 * Info grubu  : INFO_IMAP_ENABLED=true ise.
 */
export function startMailcowReplyPoller(): void {
  let started = 0;

  // Grup 1 — Mailcow (legacy, cold outreach)
  if (ENABLED) {
    const mailcow: PollerInstance = {
      label: 'mailcow',
      host: IMAP_HOST,
      port: IMAP_PORT,
      mailboxes: parseMailboxes(process.env.MAILCOW_REPLY_MAILBOXES),
      pollMs: POLL_MS,
      maxPerTick: MAX_PER_TICK,
    };
    if (mailcow.mailboxes.length === 0) {
      console.warn('[reply-poller:mailcow] MAILCOW_REPLY_MAILBOXES boş — başlatılmadı');
    } else {
      startSinglePoller(mailcow);
      started++;
    }
  } else {
    console.log('[reply-poller:mailcow] disabled (MAILCOW_REPLY_POLLER_ENABLED yok)');
  }

  // Grup 2 — Info (cy.com mail server, manuel mail + eski info@'a düşen reply'ler)
  const infoEnabled = ['1', 'true', 'yes'].includes((process.env.INFO_IMAP_ENABLED ?? '').toLowerCase());
  if (infoEnabled) {
    const info: PollerInstance = {
      label: 'info',
      host: process.env.INFO_IMAP_HOST ?? 'mail.constantineyachts.com',
      port: Number(process.env.INFO_IMAP_PORT ?? 993),
      mailboxes: parseMailboxes(process.env.INFO_IMAP_MAILBOXES),
      pollMs: Number(process.env.INFO_IMAP_POLL_MS ?? POLL_MS),
      maxPerTick: Number(process.env.INFO_IMAP_MAX_PER_TICK ?? MAX_PER_TICK),
    };
    if (info.mailboxes.length === 0) {
      console.warn('[reply-poller:info] INFO_IMAP_MAILBOXES boş — başlatılmadı');
    } else {
      startSinglePoller(info);
      started++;
    }
  } else {
    console.log('[reply-poller:info] disabled (INFO_IMAP_ENABLED yok)');
  }

  if (started === 0) {
    console.log('[reply-poller] hiçbir grup aktif değil');
  }
}

export function stopMailcowReplyPoller(): void {
  while (timers.length > 0) {
    const t = timers.pop();
    if (t) clearInterval(t);
  }
  console.log('[reply-poller] all groups stopped');
}
