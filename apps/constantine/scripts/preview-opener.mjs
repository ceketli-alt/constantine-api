// DMC ilk mail önizleme — spintax + mustache çözülmüş, gerçek görünüm.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import postgres from 'postgres';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'), override: true });

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

// email-send.ts ile AYNI spintax mantığı (içten dışa).
function resolveSpintax(text) {
  const inner = /\{([^{}]*\|[^{}]*)\}/g;
  let prev = null, cur = text, guard = 0;
  while (prev !== cur && guard < 50) {
    prev = cur;
    cur = cur.replace(inner, (_m, body) => {
      const opts = body.split('|');
      return opts[Math.floor(Math.random() * opts.length)] ?? '';
    });
    guard++;
  }
  return cur;
}
function render(text, vars) {
  const sub = text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  return resolveSpintax(sub);
}

const [tpl] = await sql`SELECT subject, body_text FROM email_templates WHERE name='outreach_initial_agency_dmc_tr'`;
const vars = {
  company_name: 'ABAYLAR TURİZM',
  rep_name: 'Mert', rep_phone: '+90 501 621 94 13',
  agency_panel_url: 'https://acente.constantineyachts.com/acente/…',
};

console.log('KONU:', render(tpl.subject, vars));
console.log('\n══════════ SADECE AÇILIŞ CÜMLESİ — 5 spintax rolü ══════════');
const seen = new Set();
let tries = 0;
while (seen.size < 5 && tries < 60) {
  const line = resolveSpintax(tpl.body_text.split('\n\n')[1]); // 2. paragraf = açılış
  seen.add(line); tries++;
}
[...seen].forEach((l, i) => console.log(`\n${i + 1}. ${l}`));

console.log('\n\n══════════ TAM MAİL (örnek render) ══════════\n');
console.log(render(tpl.body_text, vars));
await sql.end();
