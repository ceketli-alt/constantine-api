/**
 * THROWAWAY salt-okunur denetim — Instantly warmup dolaylı sinyali.
 * Mailcow IMAP mailbox'larına read-only bağlanır; INBOX/Sent/Junk klasörlerinde
 * son 24s/48s/7g mesaj hacmini + son mesaj zamanını + INBOX'ta örnek konuları sayar.
 * Hiçbir mesajı OKUNDU işaretlemez (fetch sadece envelope, no seen flag), hiçbir şey silmez/taşımaz.
 */
import { ImapFlow } from 'imapflow';

const HOST = process.env.MAILCOW_IMAP_HOST ?? 'mail.constantineyachts.online';
const PORT = Number(process.env.MAILCOW_IMAP_PORT ?? 993);
const raw = process.env.MAILCOW_REPLY_MAILBOXES ?? '';

interface MB { user: string; pass: string; }
const mailboxes: MB[] = raw
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const i = entry.indexOf(':');
    return { user: entry.slice(0, i).trim(), pass: entry.slice(i + 1).trim() };
  });

const now = Date.now();
const H = 3600_000;
const buckets = (dates: Date[]) => {
  let d1 = 0, d2 = 0, d7 = 0;
  let last: Date | null = null;
  for (const d of dates) {
    const age = now - d.getTime();
    if (age <= 24 * H) d1++;
    if (age <= 48 * H) d2++;
    if (age <= 7 * 24 * H) d7++;
    if (!last || d > last) last = d;
  }
  return { d1, d2, d7, last };
};

const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '—');

async function scanFolder(client: any, path: string) {
  const lock = await client.getMailboxLock(path);
  try {
    const exists: number = client.mailbox.exists ?? 0;
    if (!exists) return { exists: 0, d1: 0, d2: 0, d7: 0, last: null as Date | null, sample: [] as any[] };
    const start = Math.max(1, exists - 249); // son ~250 mesaj yeterli (24-48s sinyali)
    const dates: Date[] = [];
    const sample: any[] = [];
    for await (const msg of client.fetch(`${start}:${exists}`, { envelope: true, internalDate: true })) {
      const dt: Date = msg.internalDate ?? msg.envelope?.date ?? new Date(0);
      dates.push(dt);
      const fromAddr = msg.envelope?.from?.[0];
      sample.push({
        dt,
        from: fromAddr ? `${fromAddr.address}` : '?',
        subject: (msg.envelope?.subject ?? '(konusuz)').slice(0, 48),
      });
    }
    const b = buckets(dates);
    const last5 = sample.sort((a, b2) => b2.dt.getTime() - a.dt.getTime()).slice(0, 4);
    return { exists, ...b, sample: last5 };
  } finally {
    lock.release();
  }
}

async function run() {
  console.log(`\n=== WARMUP IMAP SİNYALİ — ${HOST}:${PORT} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC ===\n`);
  for (const mb of mailboxes) {
    const client = new ImapFlow({ host: HOST, port: PORT, secure: true, auth: { user: mb.user, pass: mb.pass }, logger: false });
    client.on('error', () => {});
    try {
      await client.connect();
      const list = await client.list();
      const names = list.map((f: any) => f.path);
      // Junk klasör adını bul (Mailcow: "Junk"; bazıları "Spam")
      const junkPath = names.find((n: string) => /junk|spam/i.test(n)) ?? null;
      const sentPath = names.find((n: string) => /^sent/i.test(n) || /sent/i.test(n)) ?? 'Sent';

      const inbox = await scanFolder(client, 'INBOX');
      const sent = names.some((n: string) => n.toLowerCase() === sentPath.toLowerCase()) ? await scanFolder(client, sentPath) : null;
      const junk = junkPath ? await scanFolder(client, junkPath) : null;

      console.log(`📬 ${mb.user}`);
      console.log(`   INBOX : top ${inbox.exists} | 24s:${inbox.d1}  48s:${inbox.d2}  7g:${inbox.d7} | son: ${fmt(inbox.last)}`);
      if (sent) console.log(`   SENT  : top ${sent.exists} | 24s:${sent.d1}  48s:${sent.d2}  7g:${sent.d7} | son: ${fmt(sent.last)}`);
      if (junk) console.log(`   JUNK  : top ${junk.exists} | 24s:${junk.d1}  48s:${junk.d2}  7g:${junk.d7} | son: ${fmt(junk.last)}  ${junkPath !== 'Junk' ? '('+junkPath+')' : ''}`);
      if (inbox.sample.length) {
        console.log(`   ↳ son INBOX:`);
        for (const s of inbox.sample) console.log(`      ${fmt(s.dt)} | ${s.from.padEnd(34).slice(0,34)} | ${s.subject}`);
      }
      console.log('');
      await client.logout();
    } catch (e: any) {
      console.log(`📬 ${mb.user}  ❌ HATA: ${e?.message ?? e}\n`);
      try { await client.close(); } catch {}
    }
  }
  process.exit(0);
}
run();
