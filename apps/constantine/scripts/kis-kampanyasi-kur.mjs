#!/usr/bin/env node
/**
 * KIŞ %25 KAMPANYASI — "en baştan bütün firmalara" (Mert, 21 Eki 2026).
 *
 * Kime: bugüne kadar maillenen her firma + 1C'nin henüz gönderilmemiş kuyruğu.
 * Hariç: sıcak firmalar (Agent Day/VIP, cevap verenler), %25 mailini ZATEN almış olanlar,
 *        opt-out / bastırılmış adresler, açık deal'i olanlar. Aynı adres tek kez.
 * Metin: Mert'in %25 kış indirimi metni (takip şablonuyla aynı gövde), yeni ve bağımsız ilk mail.
 * 1C durdurulur (düz kış maili artık gitmesin) ve bekleyen 1C takipleri iptal edilir
 * (hepsi bu kampanyada zaten var).
 * Gönderim YARIN 09:30'da başlar (scheduled_at) — bugün hiçbir şey gitmez.
 *
 * node kis-kampanyasi-kur.mjs [--uygula]
 */
import postgres from 'postgres'; import fs from 'node:fs';
const UYGULA = process.argv.includes('--uygula');
const C1 = '018f99ba-cea8-4a1b-9bab-466801f5810f';
const TAKIP_SABLON = '4d73c8cc-04e0-4154-be6b-f4f7b059be58';
const AD = 'Kış %25 — tüm acenteler (21 Eki)';
const SABLON_AD = 'outreach_kis_indirim_2026';
const BASLA = '2026-10-22T06:30:00Z';          // 09:30 TR
const HAVUZ = ['mert@constantineyachts.online', 'mert@constantineboat.online', 'tanitim@constantineboat.online',
               'mert@constantineyacht.online', 'tanitim@constantineyacht.online', 'outreach@constantineyachts.online'];
// Konuda "%" ve "indirim" YOK — spam filtrelerinin en sevdiği iki işaret. Teklif gövdede.
const KONU = '{Kış sezonu için acentelere özel teklif|Bu kış acentelere özel Boğaz teklifi|Kış sezonu acente teklifimiz}';

const env = Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env', 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sql = postgres(env.DATABASE_URL);

const [takip] = await sql`SELECT body_text FROM email_templates WHERE id=${TAKIP_SABLON}`;
const GOVDE = takip.body_text;

const hedef = await sql`
  WITH aday AS (
    SELECT DISTINCT t.lead_id FROM campaign_targets t
    WHERE t.status IN ('sent','replied') OR (t.campaign_id=${C1} AND t.status='queued')),
  sicak AS (
    SELECT DISTINCT t.lead_id FROM campaign_targets t JOIN campaigns c ON c.id=t.campaign_id
    WHERE c.name ~ 'Agent Day|VIP' OR t.status='replied'),
  almis AS (
    SELECT DISTINCT th.lead_id FROM email_messages m JOIN email_threads th ON th.id=m.thread_id
    WHERE m.template_id=${TAKIP_SABLON}),
  acan AS (   -- kış mailini açmış olanlar önce gitsin (sıcaklar)
    SELECT DISTINCT th.lead_id FROM email_events e JOIN email_messages m ON m.id=e.message_id
    JOIN email_threads th ON th.id=m.thread_id
    WHERE e.event_type='opened' AND m.campaign_id IS NOT NULL AND e.occurred_at > m.sent_at + interval '120 seconds')
  SELECT DISTINCT ON (lower(l.primary_contact_email)) l.id, lower(l.primary_contact_email) mail,
         (l.id IN (SELECT lead_id FROM acan)) AS acmis
  FROM aday a JOIN leads l ON l.id=a.lead_id
  WHERE l.primary_contact_email IS NOT NULL
    AND l.status::text <> 'opted_out'
    AND l.id NOT IN (SELECT lead_id FROM sicak)
    AND l.id NOT IN (SELECT lead_id FROM almis)
    AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.lead_id=l.id)
    AND NOT EXISTS (SELECT 1 FROM unsubscribes u WHERE u.channel='email' AND lower(u.identifier)=lower(l.primary_contact_email))
  ORDER BY lower(l.primary_contact_email), l.created_at`;
const acmis = hedef.filter(h => h.acmis).length;
console.log(`hedef: ${hedef.length} firma (kış mailini açmış ${acmis} → önce gider)`);
console.log(`konu: ${KONU}`);
console.log(`hız: günde 100 (6 kutu, kutu başı ~17) → ~${Math.ceil(hedef.length / 100)} iş günü`);

if (!UYGULA) { console.log('\n(--uygula ile kurulur)'); await sql.end(); process.exit(0); }

// 1) 1C'yi durdur, bekleyen takipleri iptal et
await sql`UPDATE campaigns SET status='paused', follow_up_steps='[]'::jsonb, follow_up_only_opened=false WHERE id=${C1}`;
const iptal = await sql`UPDATE campaign_targets SET next_followup_at=NULL
  WHERE campaign_id=${C1} AND status='sent' AND next_followup_at IS NOT NULL`;
console.log(`1C durduruldu · bekleyen ${iptal.count} takip iptal`);

// 2) şablon
const [s0] = await sql`SELECT id FROM email_templates WHERE name=${SABLON_AD}`;
const sablon = s0 ? s0.id : (await sql`
  INSERT INTO email_templates (name, display_name, subject, body_html, body_text, variables, category, is_active)
  VALUES (${SABLON_AD}, 'Kış 2026 — %25 kış indirimi, ilk mail (Mert metni)', ${KONU}, '', ${GOVDE}, '[]'::jsonb, 'outreach', true)
  RETURNING id`)[0].id;
if (s0) await sql`UPDATE email_templates SET subject=${KONU}, body_text=${GOVDE}, body_html='' WHERE id=${sablon}`;

// 3) kampanya (1C ayarlarından kopya, hacim ayarları yeni)
const [c1] = await sql`SELECT created_by, segment_filter FROM campaigns WHERE id=${C1}`;
const [kmp] = await sql`
  INSERT INTO campaigns (name, description, status, template_id, sender_email, sender_pool, created_by, segment_filter,
    channel, daily_cap, max_new_leads_per_day, warmup_enabled, min_gap_seconds, random_gap_seconds,
    send_window_start, send_window_end, send_days, max_per_company_per_day, first_email_text_only, send_text_only,
    exclude_free_email, cooldown_days, prioritize_new_leads, priority, started_at, target_count)
  VALUES (${AD}, 'Mert 21 Eki: %25 kış indirimi maili, bugüne kadar maillenen tüm firmalara + 1C kuyruğu.',
    'running', ${sablon}, ${HAVUZ[0]}, ${sql.json(HAVUZ)}, ${c1.created_by}, ${c1.segment_filter},
    'email', 100, 100, true, 180, 210, '09:30', '17:30', '{1,2,3,4,5}', 1, false, false,
    false, 0, true, 15, now(), ${hedef.length})
  RETURNING id`;
// warmup: kutular zaten ısınmış → kararlı gün (6 kutu × 25 = 150 tavan); günlük sınırı daily_cap belirler
await sql`INSERT INTO campaign_warmup_state (campaign_id, warmup_day, current_cap, last_advanced_at)
  VALUES (${kmp.id}, 15, 150, now())
  ON CONFLICT (campaign_id) DO UPDATE SET warmup_day=15, current_cap=150, last_advanced_at=now()`;  // trg_init_warmup kampanya eklenince day1/50 yaziyor

// 4) hedefler — açanlar önce, herkes yarın 09:30'dan itibaren
const ids = hedef.map(h => h.id), sira = hedef.map(h => h.acmis ? 0 : 1);
await sql`
  INSERT INTO campaign_targets (campaign_id, lead_id, status, sequence_step, scheduled_at)
  SELECT ${kmp.id}::uuid, x.id::uuid, 'queued', 0,
         ${BASLA}::timestamptz + make_interval(secs => x.sira)
  FROM unnest(${ids}::uuid[], ${sira}::int[]) AS x(id, sira)
  ON CONFLICT (campaign_id, lead_id) DO NOTHING`;
const [{ n }] = await sql`SELECT count(*)::int n FROM campaign_targets WHERE campaign_id=${kmp.id}`;
console.log(`kampanya ${kmp.id} kuruldu · ${n} hedef · ilk gönderim ${BASLA}`);
await sql.end();
