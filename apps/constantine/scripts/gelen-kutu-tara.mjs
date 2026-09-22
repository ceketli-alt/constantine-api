#!/usr/bin/env node
/**
 * GELEN KUTUSU TARAMASI — CRM'in "0 cevap" dedigi dogru mu?
 * 21 Eyl bulgusu: poller leadi YALNIZCA birebir adresle esliyor (`lower(primary_contact_email) = from`).
 * info@firma.com'a attigimiz maile ahmet@firma.com'dan gelen cevap `no_lead_match` ile
 * SESSIZCE dusuyor (yalnizca console.log). Bu script 6 kutuya dogrudan IMAP'ten bakar:
 * 1 Eyl'den beri gelen, In-Reply-To tasiyan ya da "Re:" ile baslayan her mesaji listeler.
 * SALT OKUNUR — \Seen degistirmez.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import postgres from 'postgres';
import fs from 'node:fs';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const SINCE = new Date('2026-09-01T00:00:00Z');
const kutular = (env.MAILCOW_REPLY_MAILBOXES||'').split(',').map(e=>{const i=e.indexOf(':');return {user:e.slice(0,i).trim(),pass:e.slice(i+1)};}).filter(m=>m.user);

// bizim gonderdigimiz mesaj id'leri -> In-Reply-To eslestirmek icin
const bizim = new Set((await sql`SELECT message_id_header FROM email_messages WHERE direction='outbound' AND message_id_header IS NOT NULL AND created_at > now()-interval '60 days'`).map(r=>r.message_id_header));
const leadMail = new Set((await sql`SELECT lower(primary_contact_email) m FROM leads WHERE primary_contact_email IS NOT NULL`).map(r=>r.m));
const leadDomain = new Map();
for (const r of await sql`SELECT lower(split_part(primary_contact_email,'@',2)) d, company_name FROM leads WHERE primary_contact_email IS NOT NULL`) leadDomain.set(r.d, r.company_name);

const bulgular=[];
for (const mb of kutular) {
  const c = new ImapFlow({ host: env.MAILCOW_IMAP_HOST, port: Number(env.MAILCOW_IMAP_PORT||993), secure: true,
    auth:{ user: mb.user, pass: mb.pass }, logger: false });
  try {
    await c.connect();
    const lock = await c.getMailboxLock('INBOX');
    try {
      let toplam=0;
      for await (const msg of c.fetch({ since: SINCE }, { source: true, internalDate: true, uid: true })) {
        toplam++;
        const p = await simpleParser(msg.source);
        const from = (p.from?.value?.[0]?.address||'').toLowerCase();
        const subj = p.subject||'';
        const irt = p.inReplyTo||'';
        const refs = Array.isArray(p.references)?p.references:(p.references?[p.references]:[]);
        const bizeCevap = (irt && bizim.has(irt)) || refs.some(r=>bizim.has(r));
        const reGibi = /^\s*(re|ynt|aw|sv|fwd?)\s*:/i.test(subj);
        if (!bizeCevap && !reGibi) continue;
        const auto = /auto-submitted|autoreply|out of office|ofis dışı|otomatik|automatic reply|abwesenheit/i.test(subj + ' ' + (p.headers?.get?.('auto-submitted')||''));
        const dom = from.split('@')[1]||'';
        bulgular.push({ kutu: mb.user, tarih: (p.date||msg.internalDate).toISOString().slice(0,10), from, subj: subj.slice(0,60),
          bizeCevap, auto, leadBirebir: leadMail.has(from), leadDomain: leadDomain.get(dom)||null });
      }
      console.log(`${mb.user.padEnd(36)} 1 Eyl'den beri ${toplam} mesaj`);
    } finally { lock.release(); }
    await c.logout();
  } catch (e) { console.log(`${mb.user.padEnd(36)} HATA: ${e.message}`); }
}
console.log(`\n=== CEVAP GIBI GORUNEN: ${bulgular.length} ===`);
for (const b of bulgular.sort((a,b)=>a.tarih.localeCompare(b.tarih))) {
  const etiket = b.auto ? 'OTOMATIK' : (b.leadBirebir ? 'LEAD-BIREBIR' : (b.leadDomain ? `LEAD-ALAN(${b.leadDomain.slice(0,18)})` : 'ESLESMEDI'));
  console.log(`  ${b.tarih} ${b.kutu.split('@')[0].padEnd(8)} ${(b.bizeCevap?'↩':' ')} ${etiket.padEnd(30)} ${b.from.padEnd(34)} ${b.subj}`);
}
await sql.end();
