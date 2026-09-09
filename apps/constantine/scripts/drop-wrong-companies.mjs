/**
 * Kimlik dogrulamasindan gecemeyen adresleri IST-ACENTE kuyrugundan duser.
 * Lead CRM'de KALIR, sadece kampanyadan cikar (elle gozden gecirilebilir).
 * Girdi: site-kimlik-kontrol.csv (KUSKULU/ERISILEMEDI) + turk-kontrol.csv (YABANCI/SINIRDA)
 */
import postgres from 'postgres';
import fs from 'node:fs';

const CAMPAIGN = 'cf291a24-25e5-4b68-98a4-6a621f425513';
const DIR = '/root/acente-data-2026-08';
const DRY = process.argv.includes('--dry');

const env = Object.fromEntries(
  fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sql = postgres(env.DATABASE_URL);

function readCsv(path) {
  const [head, ...lines] = fs.readFileSync(path, 'utf8').replace(/^﻿/, '').trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => {
    const cells = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return Object.fromEntries(cols.map((h, i) => [h.trim(), (cells[i] ?? '').trim()]));
  });
}

const drop = new Map();
for (const r of readCsv(`${DIR}/site-kimlik-kontrol.csv`)) {
  if (r.sonuc === 'KUSKULU') drop.set(r.id, 'site-baska-sirkete-ait');
  else if (r.sonuc === 'ERISILEMEDI') drop.set(r.id, 'site-erisilemedi');
}
for (const r of readCsv(`${DIR}/turk-kontrol.csv`)) {
  if (r.turk === 'YABANCI') drop.set(r.id, 'yabanci-sirket');
  else if (r.turk === 'SINIRDA') drop.set(r.id, 'turk-oldugu-dogrulanamadi');
  else if (r.turk === 'ERISILEMEDI') drop.set(r.id, 'site-erisilemedi');
}

console.log(`düşürülecek: ${drop.size}`);
const say = {};
for (const v of drop.values()) say[v] = (say[v] ?? 0) + 1;
console.log(say);

if (DRY) { console.log('[DRY] değişiklik yok'); await sql.end(); process.exit(0); }

let n = 0;
for (const [id, reason] of drop) {
  const r = await sql`
    UPDATE campaign_targets SET status='failed', error=${'kimlik:' + reason}
    WHERE id=${id} AND campaign_id=${CAMPAIGN} AND status='queued'`;
  n += r.count;
}
const [{ q }] = await sql`
  SELECT count(*)::int q FROM campaign_targets WHERE campaign_id=${CAMPAIGN} AND status='queued'`;
console.log(`✓ ${n} düşürüldü — kalan temiz kuyruk: ${q}`);
await sql.end();
