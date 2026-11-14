#!/usr/bin/env node
/**
 * KIŞ ACENTE ŞABLONU — Mert'in kendi yazdığı metin (8 Eki 2026), 1C kampanyasına yüklenir.
 * Eski şablon (`outreach_initial_agency_dmc_tr`) bir yazılım paneli satıyordu, "Constantine"
 * imzalıydı, "tekne" diyordu ve 21 Ağu'da kaldırılan +90 501 numarasını taşıyordu.
 *
 * Spintax: anlam aynı kalacak şekilde 3 cümlede küçük varyasyon — aynı kutudan günde 20
 * birebir aynı mail gitmesin (spam parmak izi). Alt bilgi + abonelik linki email-send.ts
 * tarafından otomatik eklenir, burada YOK.
 *
 * node sablon-kis-acente.mjs [--uygula] [--geri-al] [--ornek N]
 */
import postgres from 'postgres'; import fs from 'node:fs';
import { resolveSpintax } from '../src/spintax.ts';
const KAMPANYA='018f99ba-cea8-4a1b-9bab-466801f5810f';
const ESKI_SABLON='3a32c3a6-01c6-4d3c-a89d-2226e0df242b';
const AD='outreach_kis_acente_2026';
const UYGULA=process.argv.includes('--uygula'), GERI=process.argv.includes('--geri-al');
const ornekIdx=process.argv.indexOf('--ornek'); const ORNEK=ornekIdx>0?Number(process.argv[ornekIdx+1]):0;

const KONU = '{Bu kış gruplarınız için Boğaz|Kış sezonunda gruplarınız için Boğaz|Bu kış gruplarınıza Boğaz turu}';
const GOVDE = `Merhaba,

Ben Mert Ödemiş, Constantine Yachts'tan. Boğaz'da özel yat turları yapıyoruz.

Kış sezonunda da acentelerle çalışmaya devam ediyoruz: gruplarınız için gündüz Boğaz turu, yemekli ya da yemeksiz {organizasyonlarımız var|organizasyon seçeneklerimiz var|programlarımız var}. Acentelere net fiyat veriyoruz.

Bu kış İstanbul'a grup getiriyor musunuz? Tarih ve kişi sayısını yazmanız yeterli; isterseniz aşağıdaki numaradan {arayın|bize ulaşın}, acentelere özel fiyatlarımızı iletelim.

İyi bir kış sezonu ve iyi çalışmalar dileriz.

Mert Ödemiş
Constantine Yachts
+90 536 399 14 42
https://constantineyachts.com`;

// HTML BİLEREK BOŞ (8 Eki): email-send.ts metni ve HTML'i AYRI AYRI render ediyor, spintax
// her birinde ayrı zar atıyor → aynı mailin HTML'i "programlarımız var", metni
// "organizasyonlarımız var" diyebiliyordu. Boş bırakınca email-send çözülmüş METİNDEN
// HTML üretiyor (textToBasicHtml) → iki parça birebir aynı. Açılma takibi için HTML şart.
const HTML = '';

if (ORNEK) {
  for (let i=0;i<ORNEK;i++) console.log(`--- örnek ${i+1} ---\nKonu: ${resolveSpintax(KONU)}\n\n${resolveSpintax(GOVDE)}\n`);
  process.exit(0);
}

const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);

if (GERI) {
  await sql`UPDATE campaigns SET template_id=${ESKI_SABLON}::uuid WHERE id=${KAMPANYA}::uuid`;
  console.log('1C eski şablona döndürüldü'); await sql.end(); process.exit(0);
}
if (!UYGULA) { console.log('(--uygula ile yüklenir · --ornek 3 ile önizleme)'); await sql.end(); process.exit(0); }

const [mevcut] = await sql`SELECT id FROM email_templates WHERE name=${AD}`;
let id;
if (mevcut) {
  await sql`UPDATE email_templates SET subject=${KONU}, body_text=${GOVDE}, body_html=${HTML}, is_active=true WHERE id=${mevcut.id}`;
  id = mevcut.id; console.log('şablon güncellendi', id);
} else {
  const [y] = await sql`INSERT INTO email_templates (name, display_name, subject, body_html, body_text, variables, category, is_active)
    VALUES (${AD}, 'Kış 2026 — Acente grupları (Mert)', ${KONU}, ${HTML}, ${GOVDE}, '[]'::jsonb, 'outreach', true) RETURNING id`;
  id = y.id; console.log('şablon oluşturuldu', id);
}
await sql`UPDATE campaigns SET template_id=${id}::uuid WHERE id=${KAMPANYA}::uuid`;
const [k] = await sql`SELECT c.name, t.name tname FROM campaigns c JOIN email_templates t ON t.id=c.template_id WHERE c.id=${KAMPANYA}::uuid`;
console.log(`1C artık: ${k.tname}`);
await sql.end();
