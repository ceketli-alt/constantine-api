#!/usr/bin/env node
/**
 * 1C TAKİP MAİLİNİ AÇ — yalnızca maili AÇANLARA, tek seferlik (8 Eki 2026 hazırlandı).
 *
 * ⚠️ KORKULUK: Haziran 2026'dan beri takip maili Mert'in AÇIK onayı olmadan açılmaz.
 * Bu script hazırda bekler; varsayılan çalıştırma hiçbir şey yazmaz, sadece ne yapacağını söyler.
 * Onay gelince: node takip-ac.mjs --uygula   ·   geri almak için: node takip-ac.mjs --kapat
 *
 * --uygula yaptıkları:
 *   1. takip şablonunu oluşturur/günceller (outreach_kis_acente_takip_2026)
 *   2. 1C'ye tek adımlık takip tanımlar: ilk mailden 5 gün sonra
 *   3. follow_up_only_opened = true → yalnızca bir İNSANIN açtığı görülenlere gider
 *   4. HTML'e geçişten (8 Eki) sonra gönderilmiş hedeflerin next_followup_at'ini kurar
 *      (o anda follow_up_steps boş olduğu için tetikleyici kurmamıştı)
 */
import postgres from 'postgres'; import fs from 'node:fs';
const KAMPANYA = '018f99ba-cea8-4a1b-9bab-466801f5810f';
const HTML_BASLANGIC = '2026-10-08T20:20:00Z';
const GECIKME_GUN = 5;
const AD = 'outreach_kis_acente_takip_2026';
const UYGULA = process.argv.includes('--uygula'), KAPAT = process.argv.includes('--kapat');

const GOVDE = `Merhaba,

Geçen hafta kış grupları için yazmıştım. Bu sezon İstanbul'a gelen bir grubunuz varsa tarih ve kişi sayısını yazmanız yeterli, aynı gün fiyat iletelim.

Mert Ödemiş
Constantine Yachts
+90 536 399 14 42
https://constantineyachts.com`;

const env = Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sql = postgres(env.DATABASE_URL);

if (KAPAT) {
  await sql`UPDATE campaigns SET follow_up_steps='[]'::jsonb, follow_up_only_opened=false WHERE id=${KAMPANYA}::uuid`;
  const r = await sql`UPDATE campaign_targets SET next_followup_at=NULL
    WHERE campaign_id=${KAMPANYA}::uuid AND status='sent' AND sequence_step=0 AND next_followup_at IS NOT NULL`;
  console.log(`takip KAPATILDI · bekleyen ${r.count} takip iptal`); await sql.end(); process.exit(0);
}

const [{ n: aday }] = await sql`SELECT count(*)::int n FROM campaign_targets
  WHERE campaign_id=${KAMPANYA}::uuid AND status='sent' AND sent_at > ${HTML_BASLANGIC}`;
const [{ n: acan }] = await sql`
  SELECT count(DISTINCT th.lead_id)::int n FROM email_messages m
  JOIN email_threads th ON th.id=m.thread_id
  JOIN email_events e ON e.message_id=m.id AND e.event_type='opened'
  WHERE m.campaign_id=${KAMPANYA}::uuid AND m.direction='outbound' AND m.created_at > ${HTML_BASLANGIC}
    AND e.occurred_at > m.sent_at + interval '120 seconds'`;
console.log(`HTML'e geçişten beri gönderilen: ${aday} · bunlardan maili açan (insan): ${acan}`);
console.log(`→ takip yalnızca açanlara, ilk mailden ${GECIKME_GUN} gün sonra, TEK sefer gider.\n`);
console.log(GOVDE.split('\n').map(l => '   | ' + l).join('\n'));

if (!UYGULA) {
  console.log('\n(hiçbir şey yazılmadı — Mert onayından sonra: node takip-ac.mjs --uygula)');
  await sql.end(); process.exit(0);
}

const [mevcut] = await sql`SELECT id FROM email_templates WHERE name=${AD}`;
const id = mevcut ? mevcut.id : (await sql`
  INSERT INTO email_templates (name, display_name, subject, body_html, body_text, variables, category, is_active)
  VALUES (${AD}, 'Kış 2026 — Acente takip (yalnız açanlar)', '(ilk mailin konusu kullanılır)', '', ${GOVDE},
          '[]'::jsonb, 'outreach', true) RETURNING id`)[0].id;
if (mevcut) await sql`UPDATE email_templates SET body_text=${GOVDE}, body_html='' WHERE id=${id}`;

await sql`UPDATE campaigns
  SET follow_up_steps = ${sql.json([{ template_id: id, delay_days: GECIKME_GUN }])},
      follow_up_only_opened = true
  WHERE id=${KAMPANYA}::uuid`;
const r = await sql`UPDATE campaign_targets
  SET next_followup_at = sent_at + make_interval(days => ${GECIKME_GUN})
  WHERE campaign_id=${KAMPANYA}::uuid AND status='sent' AND sequence_step=0
    AND next_followup_at IS NULL AND sent_at > ${HTML_BASLANGIC}`;
console.log(`\ntakip AÇILDI · şablon ${id} · zamanlanan ${r.count} hedef (açmayanlar seçilmez)`);
await sql.end();
