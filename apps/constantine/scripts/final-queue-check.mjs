/**
 * IST-ACENTE kuyrugu — VERITABANI tarafi son kontrol.
 * Site icerik kontrolu ayri (final-site-check.py); bu script DB tutarliligina bakar.
 */
import postgres from 'postgres';
import fs from 'node:fs';

const CAMPAIGN = 'cf291a24-25e5-4b68-98a4-6a621f425513';
const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sql = postgres(env.DATABASE_URL);
const show = (t, rows) => {
  console.log(`\n── ${t}: ${rows.length}`);
  for (const r of rows.slice(0, 25)) console.log('   ', JSON.stringify(r));
};

const q = await sql`
  SELECT ct.id target_id, l.id lead_id, l.company_name, l.primary_contact_email email,
         l.primary_contact_phone phone, l.website, l.district, l.tags, l.last_contacted_at,
         l.opted_out_at, l.status
  FROM campaign_targets ct JOIN leads l ON l.id = ct.lead_id
  WHERE ct.campaign_id = ${CAMPAIGN} AND ct.status = 'queued'`;
console.log(`kuyrukta ${q.length} kayıt`);

// 1) opt-out / suppression
show('OPT-OUT olmuş ama kuyrukta', q.filter((r) => r.opted_out_at));
const unsub = await sql`
  SELECT lower(u.identifier) e FROM unsubscribes u WHERE u.channel='email'`;
const unsubSet = new Set(unsub.map((r) => r.e));
show('unsubscribes listesinde', q.filter((r) => unsubSet.has((r.email || '').toLowerCase())));

// 2) daha once temas edilmis
show('daha önce temas edilmiş (last_contacted_at dolu)', q.filter((r) => r.last_contacted_at)
  .map((r) => ({ firma: r.company_name, tarih: r.last_contacted_at })));

// 3) baska kampanyada da hedeflenmis mi
const cross = await sql`
  SELECT l.company_name, l.primary_contact_email, c.name kampanya, ct.status
  FROM campaign_targets ct JOIN leads l ON l.id=ct.lead_id JOIN campaigns c ON c.id=ct.campaign_id
  WHERE ct.campaign_id <> ${CAMPAIGN}
    AND ct.lead_id IN (SELECT lead_id FROM campaign_targets WHERE campaign_id=${CAMPAIGN} AND status='queued')`;
show('başka kampanyada da hedeflenmiş', cross);

// 4) kuyruk ici tekrar: ayni e-posta veya ayni mail domaini
const byEmail = {}, byDom = {};
for (const r of q) {
  const e = (r.email || '').toLowerCase();
  (byEmail[e] ??= []).push(r.company_name);
  const d = e.split('@')[1] || '';
  (byDom[d] ??= []).push(r.company_name);
}
show('AYNI e-posta birden fazla kayıtta',
  Object.entries(byEmail).filter(([, v]) => v.length > 1).map(([e, v]) => ({ e, firmalar: v })));
show('aynı mail domaini birden fazla firmada',
  Object.entries(byDom).filter(([, v]) => v.length > 1).map(([d, v]) => ({ d, firmalar: v })));

// 5) sistemimizin kendi domainleri / test adresleri
const OWN = ['constantineyachts', 'constantineboat', 'constantineyacht', 'example', 'test'];
show('şüpheli kendi/test domaini', q.filter((r) => OWN.some((o) => (r.email || '').includes(o))));

// 6) ucretsiz saglayici
const free = await sql`SELECT domain FROM free_email_domains`;
const freeSet = new Set(free.map((r) => r.domain));
show('ücretsiz sağlayıcı adresi', q.filter((r) => freeSet.has(((r.email || '').split('@')[1] || '')))
  .map((r) => ({ firma: r.company_name, mail: r.email })));

// 7) eksik alan
show('telefonu yok', q.filter((r) => !r.phone).map((r) => r.company_name));
show('web sitesi yok', q.filter((r) => !r.website).map((r) => r.company_name));
show('ilçesi yok', q.filter((r) => !r.district).map((r) => r.company_name));

// 8) sablon degiskenleri doluyor mu (primary_contact_name bos ise "Merhaba ," olur)
show('kişi adı BOŞ (şablonda "Merhaba ," riski)', (await sql`
  SELECT company_name FROM leads
  WHERE id IN (SELECT lead_id FROM campaign_targets WHERE campaign_id=${CAMPAIGN} AND status='queued')
    AND (primary_contact_name IS NULL OR primary_contact_name='')`).map((r) => r.company_name).slice(0, 5));

// 9) e-posta bicim kontrolu
const RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;
show('geçersiz e-posta biçimi', q.filter((r) => !RE.test((r.email || '').trim()))
  .map((r) => ({ firma: r.company_name, mail: r.email })));

// site listesini python kontrolu icin yaz
const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const head = ['target_id', 'firma', 'email', 'domain'];
const lines = [head.join(','), ...q.map((r) => [r.target_id, r.company_name, r.email,
  (r.website || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')].map(esc).join(','))];
fs.writeFileSync('/root/acente-data-2026-08/son-kuyruk.csv', lines.join('\n'), 'utf8');
console.log('\n→ son-kuyruk.csv yazıldı (site içerik kontrolü için)');
await sql.end();
