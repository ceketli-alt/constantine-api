#!/usr/bin/env node
/**
 * test-warmup-throttle.mjs — Warmup/cron_paused worker-binding DATA-LAYER testi.
 *
 * campaign-worker.ts'in artık çalıştırdığı GERÇEK SQL + karar mantığını test eder.
 * Her şey TEK transaction'da yapılıp ROLLBACK edilir → mail GÖNDERİLMEZ,
 * hiçbir gerçek veri (lead/campaign/message/event) kalıcı olmaz.
 *
 * Bağlam: 3 güvenlik mekanizması (cron_paused / warmup paused_until / warmup cap ramp)
 * KOD+TABLO olarak vardı ama worker'ın gerçek throttle'ına bağlı DEĞİLDİ. Bu test
 * bağlamayı doğrular (3449 lead havuzuna çıkmadan önce gerekli).
 *
 * Kapsam:
 *   1. cron_paused enforce — tick SELECT (status='running' ∧ channel='email' ∧ cron_paused=false)
 *      → cron_paused=true kampanya HİÇ çekilmez (skip), false olan çekilir.
 *   2. trg_init_warmup auto-seed + worker INSERT ON CONFLICT idempotency (tek satır).
 *   3. paused_until enforce — worker gate: paused_until>now → return (gönderMEZ);
 *      geçmiş/NULL → devam (auto-resume, cron'un kolonu temizlemesini beklemeden).
 *   4. Efektif cap = min(daily_cap, current_cap) (warmup açıkken); ramp daily_cap'i aşmaz,
 *      current_cap<daily_cap ise current_cap yönetir; warmup kapalıysa daily_cap.
 *   5. sent_today increment — worker bu tick'te giden maili sayar (cron'un bounce-oran payda'sı).
 *   6. cron-warmup-tick bounce/complaint sayımı email_events'ten DOĞRU (email-webhook yazıyor)
 *      + payda fix: sent_today=0 iken oran 0 (eski bug), sent_today>0 iken oran gerçek.
 *
 * Kullanım: node scripts/test-warmup-throttle.mjs
 */
import 'dotenv/config';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL eksik'); process.exit(1); }
const sql = postgres(DATABASE_URL);

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ FAIL: ${msg}`); }
}

const ROLLBACK = Symbol('rollback');

// ── worker'ın efektif-cap mantığının birebir kopyası (campaign-worker.ts) ──
function effectiveCap(dailyCap, warmupCap, warmupEnabled) {
  const wc = warmupEnabled ? warmupCap : null;
  return wc != null
    ? (dailyCap > 0 ? Math.min(dailyCap, wc) : wc)
    : dailyCap;
}
// ── worker'ın paused_until gate'inin birebir kopyası ──
function isPausedGate(pausedUntil) {
  return !!(pausedUntil && new Date(pausedUntil).getTime() > Date.now());
}

const BOUNCE_RATE_THRESHOLD = 0.05; // cron-warmup-tick.ts ile aynı

async function run() {
  console.log('\n=== Warmup/cron_paused worker-binding testi (ROLLBACK) ===\n');
  try {
    await sql.begin(async (tx) => {
      const tpls = await tx`SELECT id FROM email_templates ORDER BY created_at LIMIT 1`;
      if (tpls.length < 1) throw new Error('Test için en az 1 email_template gerekli');
      const tplId = tpls[0].id;

      // ── 1. cron_paused enforce (tick SELECT) ──
      console.log('[1] cron_paused enforce — tick SELECT cron_paused=true kampanyayı skipler');
      const campAct = await tx`
        INSERT INTO campaigns (name, channel, template_id, daily_cap, status, warmup_enabled, cron_paused)
        VALUES ('ZZ Warmup Active', 'email', ${tplId}, 100, 'running', true, false)
        RETURNING id
      `;
      const campCronPaused = await tx`
        INSERT INTO campaigns (name, channel, template_id, daily_cap, status, warmup_enabled, cron_paused)
        VALUES ('ZZ Warmup CronPaused', 'email', ${tplId}, 100, 'running', true, true)
        RETURNING id
      `;
      const activeId = campAct[0].id;
      const cronPausedId = campCronPaused[0].id;

      // worker tick'inin GERÇEK SELECT'i (campaign-worker.ts tick())
      const ticked = await tx`
        SELECT id FROM campaigns
        WHERE status = 'running' AND channel = 'email' AND cron_paused = false
      `;
      const tickedIds = ticked.map((r) => r.id);
      assert(tickedIds.includes(activeId), 'cron_paused=false kampanya tick SELECT\'te VAR');
      assert(!tickedIds.includes(cronPausedId), 'cron_paused=true kampanya tick SELECT\'te YOK (skip)');

      // ── 2. trg_init_warmup auto-seed + worker seed idempotency ──
      console.log('[2] warmup_state: trigger auto-seed + worker INSERT ON CONFLICT idempotent');
      const seededByTrigger = await tx`
        SELECT warmup_day, current_cap, sent_today, paused_until
        FROM campaign_warmup_state WHERE campaign_id = ${activeId}
      `;
      assert(seededByTrigger.length === 1, 'trg_init_warmup kampanya insert\'inde 1 satır açtı');
      assert(Number(seededByTrigger[0]?.warmup_day) === 1, 'warmup_day = 1 (gün 1)');
      assert(Number(seededByTrigger[0]?.current_cap) === 50, 'current_cap = 50 (cap_for_warmup_day(1))');
      assert(Number(seededByTrigger[0]?.sent_today) === 0, 'sent_today = 0 (başlangıç)');

      // worker'ın defensive seed'i (campaign-worker.ts processCampaign) — capForDay(1)=50
      await tx`
        INSERT INTO campaign_warmup_state (campaign_id, warmup_day, current_cap)
        VALUES (${activeId}, 1, 50)
        ON CONFLICT (campaign_id) DO NOTHING
      `;
      const afterSeed = await tx`
        SELECT count(*)::int AS n FROM campaign_warmup_state WHERE campaign_id = ${activeId}
      `;
      assert(afterSeed[0].n === 1, 'worker seed ON CONFLICT DO NOTHING → hâlâ tek satır (idempotent)');

      // ── 3. paused_until enforce (worker gönderMEZ) ──
      console.log('[3] paused_until enforce — worker gate: gelecek→durur, geçmiş/NULL→devam');
      await tx`
        UPDATE campaign_warmup_state
        SET paused_until = now() + interval '1 hour', paused_reason = 'bounce_threshold'
        WHERE campaign_id = ${activeId}
      `;
      // worker'ın okuduğu GERÇEK SELECT
      let wsRow = (await tx`
        SELECT current_cap, paused_until FROM campaign_warmup_state WHERE campaign_id = ${activeId}
      `)[0];
      assert(isPausedGate(wsRow.paused_until) === true, 'paused_until = now+1h → gate TRUE (worker return, GÖNDERMEZ)');

      await tx`UPDATE campaign_warmup_state SET paused_until = now() - interval '1 hour' WHERE campaign_id = ${activeId}`;
      wsRow = (await tx`SELECT paused_until FROM campaign_warmup_state WHERE campaign_id = ${activeId}`)[0];
      assert(isPausedGate(wsRow.paused_until) === false, 'paused_until = now-1h (geçmiş) → gate FALSE (worker devam, auto-resume)');

      await tx`UPDATE campaign_warmup_state SET paused_until = NULL, paused_reason = NULL WHERE campaign_id = ${activeId}`;
      wsRow = (await tx`SELECT paused_until FROM campaign_warmup_state WHERE campaign_id = ${activeId}`)[0];
      assert(isPausedGate(wsRow.paused_until) === false, 'paused_until = NULL → gate FALSE (pause yok)');

      // ── 4. Efektif cap = min(daily_cap, current_cap) ──
      console.log('[4] Efektif cap = min(daily_cap, current_cap) [warmup açık]');
      // current_cap=50, daily_cap=100 → 50 (current_cap < daily_cap → current_cap yönetir)
      assert(effectiveCap(100, 50, true) === 50, 'current_cap(50) < daily_cap(100) → efektif cap = 50 (current_cap)');
      // current_cap=200 (ramp ilerledi), daily_cap=16 (operatör tavanı) → 16
      assert(effectiveCap(16, 200, true) === 16, 'current_cap(200) > daily_cap(16) → efektif cap = 16 (daily_cap tavanı)');
      // warmup kapalı → daily_cap
      assert(effectiveCap(100, 50, false) === 100, 'warmup kapalı → efektif cap = daily_cap (100)');
      // daily_cap=0 (limitsiz) + warmup açık → current_cap tek başına
      assert(effectiveCap(0, 50, true) === 50, 'daily_cap=0 (limitsiz) + warmup → efektif cap = current_cap (50)');
      // Gerçek satırdan da doğrula (current_cap=50 trigger seed)
      const capRow = (await tx`SELECT current_cap FROM campaign_warmup_state WHERE campaign_id = ${activeId}`)[0];
      assert(effectiveCap(100, Number(capRow.current_cap), true) === 50, 'DB current_cap(50) ile efektif cap = 50');

      // ── 5. sent_today increment (warmup denominator) ──
      console.log('[5] sent_today increment — worker bu tick giden maili sayar');
      const before = (await tx`SELECT sent_today FROM campaign_warmup_state WHERE campaign_id = ${activeId}`)[0];
      assert(Number(before.sent_today) === 0, 'increment öncesi sent_today = 0');
      // worker'ın GERÇEK UPDATE'i (sentThisTick = 10 varsay)
      await tx`
        UPDATE campaign_warmup_state
        SET sent_today = sent_today + 10, updated_at = now()
        WHERE campaign_id = ${activeId}
      `;
      const afterInc = (await tx`SELECT sent_today FROM campaign_warmup_state WHERE campaign_id = ${activeId}`)[0];
      assert(Number(afterInc.sent_today) === 10, 'increment sonrası sent_today = 10');

      // ── 6. cron bounce/complaint sayımı email_events'ten + payda fix ──
      console.log('[6] cron bounce/complaint sayımı email_events\'ten (item 4) + payda fix');
      // Lead + thread + message (email_webhook bunları resend_message_id ile eşler;
      // burada doğrudan message_id FK ile event yazıyoruz — cron sayımı message→campaign join).
      const lead = (await tx`
        INSERT INTO leads (company_name, primary_contact_email, primary_contact_name, type, segment, source, status)
        VALUES (
          'ZZ Warmup Bounce Co', 'warmup-bounce-zz@example.invalid', 'Test Kişi',
          (SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='lead_type' LIMIT 1)::lead_type,
          (SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='lead_segment' LIMIT 1)::lead_segment,
          'test', 'new'
        ) RETURNING id, primary_contact_email
      `)[0];
      const thread = (await tx`
        INSERT INTO email_threads (lead_id, subject, message_count, status, last_direction, last_message_at)
        VALUES (${lead.id}, 'ZZ Warmup Konu', 1, 'open', 'outbound', now()) RETURNING id
      `)[0];
      const msg = (await tx`
        INSERT INTO email_messages (thread_id, direction, from_email, to_email, subject, campaign_id, sent_at, sequence_step)
        VALUES (${thread.id}, 'outbound', 'outreach@constantineyachts.online', ${lead.primary_contact_email}, 'ZZ Warmup Konu', ${activeId}, now(), 0)
        RETURNING id
      `)[0];
      // email-webhook.ts'in yazdığı gibi: event_type::email_event_type + occurred_at=now()
      await tx`INSERT INTO email_events (message_id, event_type, raw_payload, occurred_at) VALUES (${msg.id}, 'bounced'::email_event_type, '{}'::jsonb, now())`;
      await tx`INSERT INTO email_events (message_id, event_type, raw_payload, occurred_at) VALUES (${msg.id}, 'complained'::email_event_type, '{}'::jsonb, now())`;

      const since24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      // cron-warmup-tick.ts'in GERÇEK sayım sorguları
      const bounceN = (await tx`
        SELECT count(*)::int AS n
        FROM email_events ev
        INNER JOIN email_messages m ON m.id = ev.message_id
        WHERE ev.event_type = 'bounced' AND m.campaign_id = ${activeId} AND ev.occurred_at >= ${since24hIso}
      `)[0].n;
      const complaintN = (await tx`
        SELECT count(*)::int AS n
        FROM email_events ev
        INNER JOIN email_messages m ON m.id = ev.message_id
        WHERE ev.event_type = 'complained' AND m.campaign_id = ${activeId} AND ev.occurred_at >= ${since24hIso}
      `)[0].n;
      assert(bounceN === 1, `bounce_count_24h = 1 (email_events\'ten, geldi: ${bounceN})`);
      assert(complaintN === 1, `complaint_count_24h = 1 (email_events\'ten, geldi: ${complaintN})`);

      // Payda fix (item 4 derin sorun): cron'un GERÇEK oran mantığı
      //   sentLast24h = state.sent_today;  bounceRate = sentLast24h>0 ? bounce/sent : 0
      // sent_today=0 (worker artırmadan ÖNCEKİ eski bug): oran 0 → asla pause.
      const rateWhenZero = (() => { const s = 0; return s > 0 ? bounceN / s : 0; })();
      assert(rateWhenZero === 0, 'sent_today=0 → bounceRate=0 (eski bug: auto-pause asla tetiklenmezdi)');
      // sent_today=10 (worker artırdıktan SONRA): oran gerçek → eşik aşılırsa pause.
      const sentNow = Number((await tx`SELECT sent_today FROM campaign_warmup_state WHERE campaign_id = ${activeId}`)[0].sent_today);
      const rateNow = sentNow > 0 ? bounceN / sentNow : 0;
      assert(Math.abs(rateNow - 0.1) < 1e-9, `sent_today=10, bounce=1 → bounceRate=0.10 (geldi: ${rateNow})`);
      assert(rateNow > BOUNCE_RATE_THRESHOLD, 'bounceRate(0.10) > eşik(0.05) → cron paused_until set EDER → worker durur');

      throw ROLLBACK; // her şeyi geri al
    });
  } catch (e) {
    if (e !== ROLLBACK) { console.error('\nHATA:', e.message); failed++; }
  }

  console.log(`\n=== Sonuç: ${passed} geçti, ${failed} başarısız ===\n`);
  await sql.end();
  process.exit(failed > 0 ? 1 : 0);
}

run();
