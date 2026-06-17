// preview-dmc-mails.mjs — DMC sekansının 3 mailini (ilk + 2 takip) göndermeden TAM render et.
// "Seed'de ne görürsen sahada o gider" garantisi: gerçek template + gerçek app_config + gerçek lead adı.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import postgres from 'postgres';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'), override: true });

const sql = postgres(process.env.DATABASE_URL, { max: 2 });

// Spintax {a|b|c} → rastgele birini seç (motorun yaptığının aynısı)
function spin(text) {
  return text.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, g) => {
    const opts = g.split('|');
    return opts[Math.floor((Date.now() % opts.length))]; // deterministik-ish, sadece önizleme
  });
}
function render(text, vars) {
  return spin(text).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `‹${k}?›`);
}

const FOOTER = `
—
Constantine Yachts · İstanbul
Bu e-posta ticari ileti niteliğindedir (ETK 6563).
Aboneliğinizi sonlandırmak için: <unsubscribe link>`;

async function cfg(key, def='') {
  const r = await sql`SELECT value FROM app_config WHERE key=${key}`;
  if (!r.length) return def;
  return String(r[0].value).replace(/^"|"$/g,'');
}

async function main() {
  const repPhone = await cfg('sales.rep_phone', '+90...');
  const panel = await cfg('sales.agency_panel_url', '<panel link>');
  // Gerçek bir DMC lead adı al (havuzdan)
  const lead = (await sql`
    SELECT company_name FROM leads
    WHERE tags @> ARRAY['seg-dmc','trust-high','email-valid'] AND status<>'opted_out'
    ORDER BY company_name LIMIT 1`)[0];
  const company = lead?.company_name ?? 'ÖRNEK DMC TURİZM';

  const waDigits = repPhone.replace(/[^0-9]/g, '');
  const vars = {
    company_name: company,
    primary_contact_name: '',           // kurumsal adres → boş (artık selamlamada kullanılmıyor)
    rep_name: 'Mert', rep_full_name: 'Mert Ödemiş',
    rep_phone: repPhone, agency_panel_url: panel,
    rep_whatsapp_url: waDigits.length >= 8 ? `https://wa.me/${waDigits}` : '',
    previous_subject: 'Boğaz tekneleri için acente paneliniz',
    sender_first_name: 'Mert',
  };

  const seq = ['outreach_initial_agency_dmc_tr','follow_up_no_reply_day3','follow_up_agency_no_reply'];
  const labels = ['① İLK MAİL (gün 0)','② TAKİP-1 (gün +7)','③ TAKİP-2 (gün +14)'];

  for (let i=0;i<seq.length;i++) {
    const t = (await sql`SELECT subject, body_text FROM email_templates WHERE name=${seq[i]}`)[0];
    if (!t) { console.log(`\n${labels[i]} — TEMPLATE YOK (${seq[i]})\n`); continue; }
    console.log(`\n${'='.repeat(70)}\n${labels[i]}  (örnek firma: ${company})\n${'='.repeat(70)}`);
    console.log(`KONU: ${render(t.subject, vars)}`);
    console.log(`────────────────────────────────────────`);
    console.log(render(t.body_text, vars));
    console.log(FOOTER);
  }
  await sql.end();
}
main().catch(e=>{console.error(e);process.exit(1);});
