#!/usr/bin/env node
/**
 * SICAK LİSTE — "bugün kimi arayalım?" (8 Eki 2026)
 *
 * Veri: soğuk maile 1.556 firmada 0 cevap, yüz yüze tanıdığımız 17 firmadan 3 cevap.
 * Mail tek başına satmıyor; işi, telefonla aranacak ılık firmaları süzmek.
 * Bu script son çalışmasından beri maili AÇAN / CEVAP VEREN acenteleri telefonlarıyla
 * listeler ve hafta içi 09:00'da Mert'e yollar. Liste boşsa mail atmaz (gürültü olmasın).
 *
 * Sıralama: cevap verenler > birden çok açanlar > bir kez açanlar.
 * Makine açılması ayıklanır: gönderimden sonraki 120 sn içindeki açılma Apple Mail /
 * güvenlik tarayıcısı ön yüklemesidir, insan değildir.
 *
 * node sicak-liste.mjs [--kuru]   (--kuru: mail atmaz, ekrana basar, son-çalışma işaretini oynatmaz)
 */
import postgres from 'postgres';
import fs from 'node:fs';

const KURU = process.argv.includes('--kuru');
const ALICI = 'ceketli@gmail.com';
const GONDEREN = 'Sıcak liste <monitor@send.constantineyachts.com>';
const ISARET = 'sicak_liste:son_calisma';
const MAKINE_SN = 120;

const env = Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const sql = postgres(env.DATABASE_URL);

const [isaret] = await sql`SELECT value FROM app_config WHERE key = ${ISARET}`;
const baslangic = isaret?.value ? new Date(isaret.value) : new Date(Date.now() - 24 * 3600e3);
const simdi = new Date();

// 1) Cevaplar — leade bağlanmış gelen mailler (otomatik yanıtlar hariç değil: classify ayrı;
//    burada "biri bize yazdı" yeter, Mert okuyup karar verir)
const cevaplar = await sql`
  SELECT l.id lead_id, l.company_name firma, l.primary_contact_phone tel, l.primary_contact_email mail,
         m.from_email kimden, m.subject konu, m.created_at zaman,
         m.raw_payload->>'lead_match' eslesme
  FROM email_messages m
  JOIN email_threads t ON t.id = m.thread_id
  JOIN leads l ON l.id = t.lead_id
  WHERE m.direction = 'inbound' AND m.created_at > ${baslangic}
  ORDER BY m.created_at`;

// 2) İnsan açılmaları — gönderimden MAKINE_SN sonra gelen her açılma
const acanlar = await sql`
  SELECT l.id lead_id, l.company_name firma, l.primary_contact_phone tel, l.primary_contact_email mail,
         count(*)::int acilma, min(e.occurred_at) ilk, max(e.occurred_at) son, max(m.sent_at) gonderim
  FROM email_events e
  JOIN email_messages m ON m.id = e.message_id
  JOIN email_threads t ON t.id = m.thread_id
  JOIN leads l ON l.id = t.lead_id
  WHERE e.event_type = 'opened' AND m.direction = 'outbound' AND m.campaign_id IS NOT NULL
    AND e.occurred_at > ${baslangic}
    AND e.occurred_at > m.sent_at + make_interval(secs => ${MAKINE_SN})
  GROUP BY l.id, l.company_name, l.primary_contact_phone, l.primary_contact_email
  ORDER BY count(*) DESC, max(e.occurred_at) DESC`;

// 3) Eşleşmeyen gelen — bir insan baksın
const eslesmeyen = await sql`
  SELECT from_email, from_name, subject, received_at FROM inbound_unmatched
  WHERE reviewed_at IS NULL AND created_at > ${baslangic} ORDER BY received_at`;

const cevapIds = new Set(cevaplar.map(c => c.lead_id));
const acanlarCevapsiz = acanlar.filter(a => !cevapIds.has(a.lead_id));
const toplam = cevaplar.length + acanlarCevapsiz.length + eslesmeyen.length;

const tr = d => new Date(d).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const telLink = t => t ? `<a href="tel:${t}" style="color:#0E7C86;text-decoration:none;font-weight:600">${t}</a>` : '<span style="color:#999">telefon yok</span>';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let metin = `SICAK LİSTE — ${tr(baslangic)} → ${tr(simdi)}\n`;
let html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:640px;color:#16202B">
<h2 style="margin:0 0 4px">Bugün aranacaklar</h2>
<p style="color:#5B6672;margin:0 0 18px;font-size:13px">${tr(baslangic)} → ${tr(simdi)} arasında maile dokunan acenteler.
Açılış cümlesi: <i>"Dün size kış grupları için bir mail atmıştık, gördünüz mü?"</i></p>`;

if (cevaplar.length) {
  html += `<h3 style="font-size:15px;color:#2A7F4F;margin:16px 0 6px">✉ Cevap verdi — önce bunlar (${cevaplar.length})</h3><ol style="padding-left:20px">`;
  metin += `\nCEVAP VERDİ (${cevaplar.length})\n`;
  for (const c of cevaplar) {
    const not = c.eslesme === 'header' ? ` · cevap ${c.kimden} adresinden (mail ${c.mail} adresine gitmişti)`
              : c.eslesme === 'domain' ? ` · ${c.kimden} yeni mail olarak yazdı` : '';
    html += `<li style="margin-bottom:10px"><b>${esc(c.firma)}</b> — ${telLink(c.tel)}<br>
      <span style="font-size:13px;color:#5B6672">${tr(c.zaman)} · "${esc(c.konu)}"${esc(not)}</span></li>`;
    metin += `  ${c.firma} — ${c.tel ?? 'telefon yok'} — ${tr(c.zaman)} "${c.konu}"${not}\n`;
  }
  html += `</ol>`;
}

if (acanlarCevapsiz.length) {
  html += `<h3 style="font-size:15px;color:#0E7C86;margin:16px 0 6px">👁 Maili açtı (${acanlarCevapsiz.length})</h3><ol style="padding-left:20px">`;
  metin += `\nMAİLİ AÇTI (${acanlarCevapsiz.length})\n`;
  for (const a of acanlarCevapsiz) {
    const kez = a.acilma > 1 ? `<b>${a.acilma} kez</b> açtı` : '1 kez açtı';
    html += `<li style="margin-bottom:10px"><b>${esc(a.firma)}</b> — ${telLink(a.tel)}<br>
      <span style="font-size:13px;color:#5B6672">${kez} · ilk ${tr(a.ilk)}${a.acilma > 1 ? ` · son ${tr(a.son)}` : ''} · ${esc(a.mail)}</span></li>`;
    metin += `  ${a.firma} — ${a.tel ?? 'telefon yok'} — ${a.acilma} kez, ilk ${tr(a.ilk)}\n`;
  }
  html += `</ol>`;
}

if (eslesmeyen.length) {
  html += `<h3 style="font-size:15px;color:#B4432D;margin:16px 0 6px">? Kime ait olduğunu bulamadığım gelen mail (${eslesmeyen.length})</h3>
    <p style="font-size:13px;color:#5B6672;margin:0 0 6px">Kayıtlı bir firmaya bağlayamadım; kutuda bir bak.</p><ul style="padding-left:20px">`;
  metin += `\nEŞLEŞMEYEN GELEN (${eslesmeyen.length})\n`;
  for (const u of eslesmeyen) {
    html += `<li style="margin-bottom:8px;font-size:13px">${esc(u.from_name ?? '')} &lt;${esc(u.from_email)}&gt; — "${esc(u.subject)}" · ${tr(u.received_at)}</li>`;
    metin += `  ${u.from_email} — "${u.subject}" — ${tr(u.received_at)}\n`;
  }
  html += `</ul>`;
}

html += `<p style="font-size:11px;color:#999;margin-top:22px;border-top:1px solid #eee;padding-top:10px">
Gönderimden sonraki ${MAKINE_SN} sn içindeki açılmalar sayılmadı (Apple Mail / güvenlik tarayıcısı ön yüklemesi).
Aradığın firmanın CRM notuna bir satır yazman yeterli. · sicak-liste.mjs</p></div>`;

if (KURU) {
  console.log(metin);
  console.log(`(kuru çalışma — ${toplam} kayıt, mail atılmadı, işaret oynatılmadı)`);
  await sql.end(); process.exit(0);
}

if (toplam === 0) {
  console.log(`${simdi.toISOString()} liste boş — mail atılmadı`);
} else {
  const konu = `Bugün ${toplam} acente: ${cevaplar.length} cevap · ${acanlarCevapsiz.length} açtı`
             + (eslesmeyen.length ? ` · ${eslesmeyen.length} eşleşmeyen` : '');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY_TRANSACTIONAL}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: GONDEREN, to: [ALICI], subject: konu, html, text: metin }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`${simdi.toISOString()} RESEND HATA ${r.status}`, j); await sql.end(); process.exit(1); }
  console.log(`${simdi.toISOString()} gönderildi (${toplam} kayıt) → ${j.id}`);
}
await sql`INSERT INTO app_config (key, value) VALUES (${ISARET}, ${simdi.toISOString()})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
await sql.end();
